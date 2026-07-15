import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../src/engine/session.js";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import {
  commandArgumentSuggestions,
  commandSuggestions,
  createPicoCommandRegistry,
} from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import {
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../../src/input/session-settings.js";
import { fileHistoryMakeSnapshot, fileHistoryTrackEdit } from "../../src/safety/file-history.js";
import { CronService } from "../../src/tasks/cron-service.js";
import type { CronDaemonBridge } from "../../src/input/cron-daemon-bridge.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { ModelRouter } from "../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { CredentialRef, CredentialVault } from "../../src/provider/credential-vault.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
} from "../../src/safety/background-yolo-policy.js";

describe("Pico command registry", () => {
  const cleanup: Array<() => void> = [];
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetSessionSettingsForTests();
    process.env = { ...originalEnv };
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  async function registryWithSnapshot(messageId = "turn-1") {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-rewind-"));
    const session = new Session(`pico-command-${Date.now()}-${Math.random()}`, workDir, {
      persistence: false,
    });
    const filePath = join(workDir, "note.txt");
    writeFileSync(filePath, "before\n");
    session.append({ role: "user", content: "edit" });
    session.append({ role: "assistant", content: "done" });
    await fileHistoryTrackEdit(session.fileHistory, filePath, messageId, session.id);
    writeFileSync(filePath, "after\n");
    await fileHistoryMakeSnapshot(
      session.fileHistory,
      messageId,
      session.id,
      undefined,
      session.length,
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
      sessionId: session.id,
    });
    cleanup.push(() => {
      session.close();
      rmSync(workDir, { recursive: true, force: true });
    });
    return { registry, filePath };
  }

  it("/mode shows the current interaction mode", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-show",
    });

    const result = await processUserInput("/mode", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Current mode: yolo");
  });

  it("/cron 在 YOLO 工作区创建并列出持久任务", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-cron-"));
    const cron = new CronService({ workDir });
    cleanup.push(() => {
      cron.close();
      rmSync(workDir, { recursive: true, force: true });
    });
    let daemonAvailable = true;
    const disabledCountWhenRegistered: number[] = [];
    const secrets = new Map<CredentialRef, string>();
    const bridge: CronDaemonBridge = {
      deleteProvider: async () => ({
        status: "unavailable",
        message: "daemon unavailable",
      }),
      registerWorkspace: async (workspacePath) => {
        disabledCountWhenRegistered.push(cron.list(workDir).filter((job) => !job.enabled).length);
        return {
          available: daemonAvailable,
          message: daemonAvailable ? `daemon registered ${workspacePath}` : "daemon unavailable",
        };
      },
      statusWorkspace: async () => ({
        available: true,
        registered: true,
        message: "daemon connected; workspace registered; scheduler unknown",
      }),
      importAutomationCredential: async (input) => {
        if (!daemonAvailable) return { status: "unavailable", message: "daemon unavailable" };
        secrets.set(input.expectedCredentialRef as CredentialRef, input.secret);
        return { status: "ok", message: "安全导入系统凭证库" };
      },
      createAutomation: async (input) => {
        if (!daemonAvailable) return { status: "unavailable", message: "daemon unavailable" };
        let job = cron.create({
          workspacePath: input.workspacePath,
          schedule: input.schedule,
          ...(input.timeZone ? { timeZone: input.timeZone } : {}),
          prompt: input.prompt,
          credentialRef: input.expectedCredentialRef as CredentialRef,
          modelRouteId: input.modelRouteId,
          enabled: false,
          policySnapshot: {
            mode: "yolo",
            backgroundEnabled: true,
            trustedWorkspace: true,
            toolNetworkPolicy: input.toolNetworkPolicy,
            ...(input.allowedToolNetworkHosts
              ? { allowedToolNetworkHosts: input.allowedToolNetworkHosts }
              : {}),
            allowedTools: input.allowedTools,
            hardlineVersion: BACKGROUND_HARDLINE_VERSION,
            hookVersion: BACKGROUND_HOOK_VERSION,
            createdAt: Date.now(),
          },
        });
        disabledCountWhenRegistered.push(cron.list(workDir).filter((item) => !item.enabled).length);
        if (input.enabled !== false) job = cron.setEnabled(job.cronJobId, job.version, true);
        return {
          status: "ok",
          message: `daemon registered ${input.workspacePath}`,
          job: {
            jobId: job.cronJobId,
            workspacePath: job.workspacePath,
            name: job.name,
            prompt: job.prompt,
            schedule: job.schedule,
            enabled: job.enabled,
            status: "idle",
            updatedAt: job.updatedAt,
            timeZone: job.timeZone,
          },
        };
      },
      setAutomationEnabled: async (input) => {
        if (!daemonAvailable) return { status: "unavailable", message: "remains disabled" };
        const current = cron.list(workDir).find((item) => item.cronJobId === input.jobId)!;
        const job = cron.setEnabled(current.cronJobId, current.version, input.enabled);
        return {
          status: "ok",
          message: input.enabled ? "enabled" : "disabled",
          job: {
            jobId: job.cronJobId,
            workspacePath: job.workspacePath,
            name: job.name,
            prompt: job.prompt,
            schedule: job.schedule,
            enabled: job.enabled,
            status: "idle",
            updatedAt: job.updatedAt,
          },
        };
      },
      deleteAutomation: async () => ({ status: "ok", message: "deleted" }),
    };
    const credentialVault: CredentialVault = {
      capability: () => ({
        available: true,
        backend: "macos-keychain",
        diagnostic: "test keychain",
      }),
      put: async (ref, secret) => void secrets.set(ref, secret),
      resolve: async (ref) => secrets.get(ref) ?? Promise.reject(new Error("missing")),
      has: async (ref) => secrets.has(ref),
      delete: async (ref) => void secrets.delete(ref),
    };
    const modelRouter = new ModelRouter(
      [
        {
          id: "configured/glm-5.2",
          providerId: "configured",
          provider: "openai",
          model: "glm-5.2",
          baseURL: "https://example.test/v1",
          apiKeyEnv: "TEST_CRON_API_KEY",
          source: "config",
          capabilities: resolveModelRouteCapabilities("openai", "glm-5.2"),
        },
      ],
      { TEST_CRON_API_KEY: "secret-never-rendered" },
      "configured/glm-5.2",
    );
    const userConfigStore = new UserConfigStore({ picoHome: join(workDir, "user-home") });
    const initialUserConfig = await userConfigStore.read();
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: "configured/glm-5.2" },
        providers: {
          configured: {
            protocol: "openai",
            baseURL: "https://example.test/v1",
            apiKeyEnv: "TEST_CRON_API_KEY",
            models: ["glm-5.2"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initialUserConfig.revision },
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      modelRouteId: "configured/glm-5.2",
      modelRouter,
      sessionId: "session-cron",
      cronService: cron,
      cronDaemonBridge: bridge,
      credentialVault,
      credentialEnv: { TEST_CRON_API_KEY: "secret-never-rendered" },
      userConfigStore,
      effectiveConfig: {
        defaultModelRouteId: "configured/glm-5.2",
        defaults: { modelRouteId: "configured/glm-5.2" },
        providers: {
          configured: {
            protocol: "openai",
            baseURL: "https://example.test/v1",
            apiKeyEnv: "TEST_CRON_API_KEY",
            models: ["glm-5.2"],
            discoverModels: false,
          },
        },
        sources: {
          "providers.configured": "user",
          "defaults.modelRouteId": "user",
        },
        revisions: { user: "test-user", project: "test-project" },
      },
    });

    const imported = await processUserInput("/cron credential import", { registry });
    expect(imported.type === "local-command" ? imported.result.message : undefined).toContain(
      "安全导入系统凭证库",
    );
    expect(imported.type === "local-command" ? imported.result.message : undefined).not.toContain(
      "secret-never-rendered",
    );
    const created = await processUserInput(
      "/cron add --tool-network=allowlist:api.example.com */5 * * * * 检查未提交的改动",
      { registry },
    );
    expect(created.type === "local-command" ? created.result.message : undefined).toContain(
      "Cron job created",
    );
    expect(created.type === "local-command" ? created.result.message : undefined).toContain(
      "daemon registered",
    );
    expect(created.type === "local-command" ? created.result.message : undefined).toContain(
      "工具网络：仅允许 api.example.com",
    );
    const allowlistedJob = cron.list(workDir).find((job) => job.prompt === "检查未提交的改动");
    expect(allowlistedJob?.credentialRef).toMatch(/^pico-keychain:\/\/provider\/v2\//u);
    expect(allowlistedJob?.modelRouteId).toBe("configured/glm-5.2");
    expect(allowlistedJob?.enabled).toBe(true);
    expect(disabledCountWhenRegistered).toEqual([1]);

    daemonAvailable = false;
    const offline = await processUserInput("/cron add */10 * * * * 生成默认联网日报", { registry });
    expect(offline.type === "local-command" ? offline.result.message : undefined).toContain(
      "daemon unavailable",
    );
    const offlineJob = cron.list(workDir).find((job) => job.prompt === "生成默认联网日报");
    expect(offlineJob).toBeUndefined();
    expect(disabledCountWhenRegistered).toEqual([1]);

    const listed = await processUserInput("/cron list", { registry });
    expect(listed.type === "local-command" ? listed.result.message : undefined).toContain(
      "检查未提交的改动",
    );
    expect(listed.type === "local-command" ? listed.result.message : undefined).toContain(
      "工具网络：仅允许 api.example.com",
    );
    const status = await processUserInput("/cron status", { registry });
    expect(status.type === "local-command" ? status.result.message : undefined).toContain(
      "daemon connected; workspace registered; scheduler unknown",
    );
    expect(status.type === "local-command" ? status.result.message : undefined).toContain(
      "模型 Provider 调用仍需联网",
    );
  });

  it("/cron 不将 effective environment Provider 误当成可持久 config", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-env-cron-"));
    const cron = new CronService({ workDir });
    cleanup.push(() => {
      cron.close();
      rmSync(workDir, { recursive: true, force: true });
    });
    const secrets = new Map<CredentialRef, string>();
    const vault: CredentialVault = {
      capability: () => ({
        available: true,
        backend: "macos-keychain",
        diagnostic: "test keychain",
      }),
      put: async (ref, secret) => void secrets.set(ref, secret),
      resolve: async (ref) => secrets.get(ref) ?? Promise.reject(new Error("missing")),
      has: async (ref) => secrets.has(ref),
      delete: async (ref) => void secrets.delete(ref),
    };
    const environmentProvider = {
      protocol: "openai" as const,
      baseURL: "https://environment.example.test/v1",
      apiKeyEnv: "LLM_API_KEY",
      models: ["env-model"],
      discoverModels: false,
    };
    const router = new ModelRouter(
      [
        {
          id: "legacy/env-model",
          providerId: "legacy",
          provider: "openai",
          model: "env-model",
          baseURL: environmentProvider.baseURL,
          apiKeyEnv: "LLM_API_KEY",
          // EffectiveConfigResolver flattens the environment entry before ModelRouter,
          // so source alone is not sufficient to classify persistence authority.
          source: "config",
          capabilities: resolveModelRouteCapabilities("openai", "env-model"),
        },
      ],
      { LLM_API_KEY: "environment-only-secret" },
      "legacy/env-model",
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "env-model",
      modelRouteId: "legacy/env-model",
      modelRouter: router,
      sessionId: "session-env-cron",
      cronService: cron,
      credentialVault: vault,
      credentialEnv: { LLM_API_KEY: "environment-only-secret" },
      effectiveConfig: {
        defaultModelRouteId: "legacy/env-model",
        defaults: { modelRouteId: "legacy/env-model" },
        providers: { legacy: environmentProvider },
        sources: {
          "providers.legacy": "environment",
          "defaults.modelRouteId": "environment",
        },
        revisions: { user: "env-user", project: "env-project" },
      },
    });

    const result = await processUserInput("/cron credential import", { registry });
    const message = result.type === "local-command" ? result.result.message : "";
    expect(message).toContain("仅由当前进程环境提供");
    expect(message).not.toContain("environment-only-secret");
    expect(secrets.size).toBe(0);
  });

  it("/rename 为当前 session 设置可持久化的可读标题", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-rename-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const session = new Session("session-rename", workDir, { persistence: false });
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
      sessionId: session.id,
    });

    const result = await processUserInput("/rename 认证重构：Session 方案", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("认证重构：Session 方案");
    expect(getStoredSessionSettings(session.id)?.title).toBe("认证重构：Session 方案");
  });

  it("/goal shows the active goal from the shared TUI runtime", async () => {
    const goalManager = new GoalManager();
    const goal = goalManager.create("Ship TUI fixes", "Close the reported interaction gaps", {
      maxTurns: 8,
    });
    goalManager.update(goal.id, { progress: "Goal command wired" });
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-goal-show",
      goalManager,
    });

    const result = await processUserInput("/goal", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("goal");
    expect(result.result.message).toContain("Ship TUI fixes");
    expect(result.result.message).toContain("Close the reported interaction gaps");
    expect(result.result.message).toContain("Goal command wired");
    expect(result.result.message).toContain("8 轮");
  });

  it("/goal explains an empty or unavailable runtime without creating state", async () => {
    const goalManager = new GoalManager();
    const liveRegistry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-goal-empty",
      goalManager,
    });
    const detachedRegistry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-goal-detached",
    });

    const empty = await processUserInput("/goal", { registry: liveRegistry });
    const detached = await processUserInput("/goal", { registry: detachedRegistry });
    const invalid = await processUserInput("/goal create something", { registry: liveRegistry });

    expect(empty.type === "local-command" ? empty.result.message : undefined).toContain(
      "No active goal",
    );
    expect(detached.type === "local-command" ? detached.result.message : undefined).toContain(
      "Goal unavailable",
    );
    expect(invalid.type === "local-command" ? invalid.result.message : undefined).toBe(
      "Usage: /goal",
    );
    expect(goalManager.list()).toHaveLength(0);
  });

  it("/add-dir adds a raw path to this session without writing project config", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-add-dir-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const canonicalPath = join(workDir, "outside path");
    const addDirectory = vi.fn(async (_path: string) => ({
      added: true,
      path: canonicalPath,
    }));
    const manager = {
      list: () => [workDir],
      addDirectory,
    };
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-add-dir",
      additionalDirectoryManager: manager,
    });

    const result = await processUserInput("/add-dir ../outside path", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("add-dir");
    expect(addDirectory).toHaveBeenCalledWith("../outside path");
    expect(result.result.message).toContain(canonicalPath);
    expect(getStoredSessionSettings("session-add-dir")?.additionalDirectories).toEqual([
      canonicalPath,
    ]);
    expect(existsSync(join(workDir, ".pico", "config.json"))).toBe(false);
  });

  it("/add-dir remains backward-compatible when no manager is supplied", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-add-dir-unavailable",
    });

    const result = await processUserInput("/add-dir /outside", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("add-dir");
    expect(result.result.message).toContain("unavailable");
  });

  it("/mode updates the current interaction mode", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-update",
    });

    const result = await processUserInput("/mode plan", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Mode set to plan");
    expect(getStoredSessionSettings("session-mode-update")?.mode).toBe("plan");
  });

  it("/mode plan keeps the shared settings object used by later runs", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-shared",
    });

    const before = getStoredSessionSettings("session-mode-shared");
    const result = await processUserInput("/mode plan", { registry });
    const after = getStoredSessionSettings("session-mode-shared");

    expect(result.type).toBe("local-command");
    expect(before).toBe(after);
    expect(after?.mode).toBe("plan");
  });

  it("/mode rejects unsupported interaction modes", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-reject",
    });

    const result = await processUserInput("/mode fast", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Usage: /mode <default|plan|auto|yolo>");
    expect(getStoredSessionSettings("session-mode-reject")?.mode).toBe("yolo");
  });

  it("/permissions yolo/auto/default/ask updates the shared interaction mode", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-permissions-shared",
    });

    const yolo = await processUserInput("/permissions yolo", { registry });
    const auto = await processUserInput("/permissions auto", { registry });
    const defaultMode = await processUserInput("/permissions default", { registry });
    const ask = await processUserInput("/permissions ask", { registry });

    expect(yolo.type).toBe("local-command");
    expect(auto.type).toBe("local-command");
    expect(defaultMode.type).toBe("local-command");
    expect(ask.type).toBe("local-command");
    expect(getStoredSessionSettings("session-permissions-shared")?.permissionMode).toBe("default");
    expect(ask.type === "local-command" ? ask.result.data : undefined).toMatchObject({
      permissionMode: "default",
    });
  });

  it("/model switches the session model used by later requests", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-model",
    });

    const result = await processUserInput("/model kimi-k2.5", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Model set to kimi-k2.5");
    expect(result.result.ui).toBeUndefined();
    expect(getStoredSessionSettings("session-model")?.model).toBe("kimi-k2.5");
  });

  it("/model without arguments opens the model selector signal", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-model-selector",
    });

    const result = await processUserInput("/model", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("model");
    expect(result.result.message).toContain("Current model: glm-5.2");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "model" });
  });

  it("/thinking and /effort update supported thinking effort", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-thinking",
      thinkingEffort: "off",
    });

    const thinking = await processUserInput("/thinking medium", { registry });
    const effort = await processUserInput("/effort high", { registry });

    expect(thinking.type).toBe("local-command");
    expect(effort.type).toBe("local-command");
    expect(getStoredSessionSettings("session-thinking")?.thinkingEffort).toBe("high");
  });

  it("/thinking explains unsupported provider profiles", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "gemini",
      model: "gemini-2.0-flash",
      sessionId: "session-gemini",
      thinkingEffort: "off",
    });

    const result = await processUserInput("/thinking high", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("does not support thinking effort");
    expect(getStoredSessionSettings("session-gemini")?.thinkingEffort).toBe("off");
  });

  it("/agents lists Claude Code compatible agents", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agents-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查代码\n---\n\n# Reviewer\n检查风险。",
    );

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agents", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("agents");
    expect(result.result.action).toBe("agents");
    expect(result.result.message).toContain("Available Agents");
    expect(result.result.message).toContain("- Explore [built-in]");
    expect(result.result.message).toContain("- reviewer [project/claude]: 审查代码");
  });

  it("/agents 和 /agent 参数补全共用包含 native Profile 的统一目录", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-native-agent-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claw"), { recursive: true });
    writeFileSync(
      join(workDir, ".claw", "agents.yaml"),
      [
        "agents:",
        "  - name: native-reviewer",
        "    description: Native reviewer",
        "    systemPrompt: Native prompt",
        "    tools: [read_file, grep]",
      ].join("\n"),
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const listed = await processUserInput("/agents", { registry });
    const agentCommand = registry.list().find((command) => command.name === "agent");
    const candidates = await agentCommand?.argumentCompleter?.("native-");

    expect(listed.type).toBe("local-command");
    if (listed.type !== "local-command") return;
    expect(listed.result.message).toContain("native-reviewer [project/native]");
    expect(candidates).toEqual([{ value: "native-reviewer", description: "Native reviewer" }]);
  });

  it("/agent <name> <task> dispatches through delegate_task intent", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agent-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    const sourcePath = join(workDir, ".claude", "agents", "reviewer.md");
    writeFileSync(
      sourcePath,
      "---\ndescription: 审查代码\nmodel: volcengine/deepseek-v4-pro\ntools: read_file, grep\nhooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: Verify review\n---\n\n# Reviewer\n只输出高风险问题。",
    );

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agent reviewer 检查 src/input", { registry });

    expect(result.type).toBe("prompt-command");
    if (result.type !== "prompt-command") return;
    expect(result.command).toBe("agent");
    expect(result.result.prompt).toContain("delegate_task");
    expect(result.result.prompt).toContain('"agent_name": "reviewer"');
    expect(result.result.prompt).toContain('"goal": "检查 src/input"');
    expect(result.result.prompt).not.toContain('"model_route"');
    expect(result.result.prompt).not.toContain("只输出高风险问题。");
    expect(result.result.metadata).toEqual({
      agentName: "reviewer",
      sourcePath,
      task: "检查 src/input",
      toolName: "delegate_task",
      agentHookConfig: {
        Stop: [{ hooks: [{ type: "prompt", prompt: "Verify review" }] }],
      },
    });
  });

  it("/agent missing arguments shows usage", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const noName = await processUserInput("/agent", { registry });
    const noTask = await processUserInput("/agent reviewer", { registry });

    expect(noName.type).toBe("local-command");
    expect(noTask.type).toBe("local-command");
    if (noName.type !== "local-command" || noTask.type !== "local-command") return;
    expect(noName.result.message).toContain("Usage: /agent <name> <task>");
    expect(noTask.result.message).toContain("Usage: /agent <name> <task>");
  });

  it("/agent suggests the closest existing agent when name is unknown", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agent-suggest-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查代码\n---\n\n# Reviewer",
    );
    writeFileSync(
      join(workDir, ".claude", "agents", "writer.md"),
      "---\ndescription: 撰写文档\n---\n\n# Writer",
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agent reviwer 检查 src", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("未找到 Agent: reviwer");
    expect(result.result.message).toContain("Did you mean: reviewer");
  });

  it("/skill 与动态 /<skill-name> 都执行显式激活 prompt", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-skill-activate-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const sourcePath = join(workDir, ".claude", "skills", "review", "SKILL.md");
    mkdirSync(join(workDir, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(
      sourcePath,
      "---\nname: review\ndescription: review files\nmodel: review/model\nallowed-tools: Read, Bash\nhooks:\n  PreToolUse:\n    - matcher: bash\n      hooks:\n        - type: prompt\n          prompt: Check command\n---\n\nReview $0 carefully.",
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    for (const input of ["/skill review src/a.ts", "/review src/a.ts"]) {
      const result = await processUserInput(input, { registry });
      expect(result.type).toBe("prompt-command");
      if (result.type !== "prompt-command") continue;
      expect(result.result.prompt).toContain('User explicitly activated skill "review"');
      expect(result.result.prompt).toContain("Review src/a.ts carefully.");
      expect(result.result.metadata).toMatchObject({
        skillName: "review",
        skillArgs: "src/a.ts",
        skillSourcePath: sourcePath,
        skillTrigger: "user-slash",
        skillHookConfig: {
          PreToolUse: [{ matcher: "bash", hooks: [{ type: "prompt", prompt: "Check command" }] }],
        },
      });
      expect(result.result.execution).toEqual({
        model: "review/model",
        allowedTools: ["read_file", "bash"],
      });
    }
  });

  it("Markdown command 将 model 与 allowed-tools 作为单轮执行约束", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-execution-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".pico", "commands"), { recursive: true });
    writeFileSync(
      join(workDir, ".pico", "commands", "review.md"),
      "---\ndescription: review safely\nmodel: review/model\nallowed-tools: [read_file]\n---\n\nReview $ARGUMENTS",
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/review src/a.ts", { registry });

    expect(result.type).toBe("prompt-command");
    if (result.type !== "prompt-command") return;
    expect(result.result.prompt).toBe("Review src/a.ts");
    expect(result.result.execution).toEqual({
      model: "review/model",
      allowedTools: ["read_file"],
    });
  });

  it("command descriptors provide dynamic skill, agent, and session argument candidates", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-arg-completer-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claw", "skills", "review"), { recursive: true });
    writeFileSync(
      join(workDir, ".claw", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: 审查代码\n---\n\n# Review",
    );
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查 Agent\n---\n\n# Reviewer",
    );
    writeSessionLog(workDir, "cli-review", "2026-07-09T02:00:00.000Z", [
      { type: "message", seq: 1, message: { role: "user", content: "review me" } },
    ]);
    const session = new Session("snapshot-session", workDir, { persistence: false });
    session.fileHistory.snapshots.push({
      messageId: "turn-review",
      timestamp: new Date("2026-07-09T03:00:00.000Z"),
      trackedFileBackups: new Map(),
    });

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
      sessionId: session.id,
    });

    await expect(
      Promise.resolve(registry.resolve("skill")?.argumentCompleter?.("rev")),
    ).resolves.toEqual([{ value: "review", description: "审查代码" }]);
    await expect(
      Promise.resolve(registry.resolve("agent")?.argumentCompleter?.("rev")),
    ).resolves.toEqual([{ value: "reviewer", description: "审查 Agent" }]);
    await expect(
      Promise.resolve(registry.resolve("resume")?.argumentCompleter?.("cli-r")),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "cli-review",
        insertText: "cli-review",
        label: "review me",
        description: expect.stringContaining("id=cli-review"),
      }),
    ]);
    await expect(
      Promise.resolve(registry.resolve("fork")?.argumentCompleter?.("review me")),
    ).resolves.toEqual([expect.objectContaining({ value: "cli-review", label: "review me" })]);
    expect(registry.resolve("rewind")?.argumentCompleter).toBeUndefined();
  });

  it("argument candidates read realtime skill data while rewind stays menu-only", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-live-completer-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const session = new Session("snapshot-live-session", workDir, { persistence: false });
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
      sessionId: session.id,
    });

    mkdirSync(join(workDir, ".claw", "skills", "late-review"), { recursive: true });
    writeFileSync(
      join(workDir, ".claw", "skills", "late-review", "SKILL.md"),
      "---\nname: late-review\ndescription: late skill\n---\n\n# Late",
    );
    session.fileHistory.snapshots.push({
      messageId: "turn-late",
      timestamp: new Date("2026-07-09T04:00:00.000Z"),
      trackedFileBackups: new Map(),
    });

    await expect(
      Promise.resolve(commandArgumentSuggestions(registry, "skill", "late")),
    ).resolves.toEqual([{ value: "late-review", description: "late skill" }]);
    await expect(
      Promise.resolve(commandArgumentSuggestions(registry, "rewind", "turn-l")),
    ).resolves.toEqual([]);
  });

  it("commandSuggestions 保留完整候选,不截断到 20 条", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-many-suggestions-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const commandsDir = join(workDir, ".pico", "commands");
    mkdirSync(commandsDir, { recursive: true });
    for (let i = 0; i < 24; i++) {
      writeFileSync(
        join(commandsDir, `bulk-${String(i).padStart(2, "0")}.md`),
        `---\ndescription: bulk ${i}\n---\n\nBulk ${i}`,
      );
    }
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    expect(commandSuggestions(registry, "bulk").map((item) => item.value)).toHaveLength(24);
  });

  it("/status summarizes mode permission mode model and thinking effort", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-status-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-status",
      thinkingEffort: "medium",
      permissionMode: "ask",
    });

    const result = await processUserInput("/status", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Mode: default");
    expect(result.result.message).not.toContain("Permission mode:");
    expect(result.result.message).toContain("Model: glm-5.2");
    expect(result.result.message).toContain("Thinking effort: medium");
    expect(result.result.message).toContain("Session: session-status");
    expect(result.result.message).toContain(`CWD: ${workDir}`);
  });

  it("/mcp shows empty state when no MCP config is loaded", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mcp-empty",
    });

    const result = await processUserInput("/mcp", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mcp");
    expect(result.result.action).toBe("mcp");
    expect(result.result.message).toContain("MCP status");
    expect(result.result.message).toContain("No MCP config loaded");
  });

  it("/mcp displays config path, stdio/http/sse servers, errors, and tool summary", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mcp-status",
      mcpStatus: () => ({
        configPath: "/tmp/pico/mcp.json",
        servers: [
          {
            name: "local",
            transport: "stdio",
            status: "connected",
            toolCount: 2,
            toolNames: ["echo", "read_file"],
          },
          {
            name: "remote-http",
            transport: "http",
            status: "failed",
            toolCount: 0,
            toolNames: [],
            error: "HTTP 503 Service Unavailable",
          },
          {
            name: "events",
            transport: "sse",
            status: "disabled",
            toolCount: 0,
            toolNames: [],
          },
        ],
        summary: {
          total: 3,
          connected: 1,
          failed: 1,
          disabled: 1,
          pending: 0,
          toolCount: 2,
        },
      }),
    });

    const result = await processUserInput("/mcp", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Config: /tmp/pico/mcp.json");
    expect(result.result.message).toContain(
      "Summary: 1/3 connected, 1 failed, 1 disabled, 2 tools",
    );
    expect(result.result.message).toContain("- local [stdio] connected - 2 tools: echo, read_file");
    expect(result.result.message).toContain("- remote-http [http] failed - 0 tools");
    expect(result.result.message).toContain("error: HTTP 503 Service Unavailable");
    expect(result.result.message).toContain("- events [sse] disabled - 0 tools");
  });

  it("/status includes an MCP overview when status is available", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-mcp-status-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-status-mcp",
      mcpStatus: () => ({
        configPath: "/tmp/pico/mcp.json",
        servers: [
          {
            name: "local",
            transport: "stdio",
            status: "connected",
            toolCount: 1,
            toolNames: ["echo"],
          },
          {
            name: "remote",
            transport: "http",
            status: "failed",
            toolCount: 0,
            toolNames: [],
            error: "boom",
          },
        ],
        summary: {
          total: 2,
          connected: 1,
          failed: 1,
          disabled: 0,
          pending: 0,
          toolCount: 1,
        },
      }),
    });

    const result = await processUserInput("/status", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("MCP: 1/2 connected, 1 failed, 1 tools");
  });

  it("/sessions lists resumable sessions for the current project", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-sessions-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeSessionLog(workDir, "cli-current", "2026-07-09T03:00:00.000Z", [
      { type: "message", seq: 0, message: { role: "user", content: "hi" } },
      { type: "message", seq: 1, message: { role: "assistant", content: "hello" } },
    ]);
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "cli-current",
    });

    const result = await processUserInput("/sessions", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("sessions");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "session" });
    expect(result.result.message).toContain("找到 1 个可恢复 session");
    expect(result.result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cli-current",
          messageCount: 2,
        }),
      ]),
    );
  });

  it("/resume requests a hot switch to an existing session", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-resume-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeSessionLog(workDir, "cli-known", "2026-07-09T03:00:00.000Z", [
      { type: "message", seq: 0, message: { role: "user", content: "resume me" } },
    ]);
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "cli-active",
    });

    const result = await processUserInput("/resume cli-known", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("resume");
    expect(result.result.action).toBe("resume");
    expect(result.result.message).toBe("Switching to session: cli-known");
    expect(result.result.data).toEqual({ sessionId: "cli-known", mode: "resume" });
  });

  it("/resume without args points to current session startup flags", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "cli-active",
    });

    const result = await processUserInput("/resume", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("resume");
    expect(result.result.message).toContain("Usage: /resume <session-id>");
    expect(result.result.message).toContain("--session <session-id>");
    expect(result.result.message).toContain("--continue");
    expect(result.result.message).not.toContain("--resume");
  });

  it("/sessions and /resume are discoverable from help and suggestions", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-discovery",
    });
    const resumeCommand = registry.resolve("resume");

    const help = await processUserInput("/help", { registry });
    const resumeHelp = await processUserInput("/help resume", { registry });

    expect(resumeCommand?.argumentHint).toBe("<session-id>");
    expect(help.type).toBe("local-command");
    if (help.type !== "local-command") return;
    expect(help.result.message).toContain("/sessions");
    expect(help.result.message).toContain("/resume");
    expect(resumeHelp.type).toBe("local-command");
    if (resumeHelp.type !== "local-command") return;
    expect(resumeHelp.result.message).toContain(`Usage: /resume ${resumeCommand?.argumentHint}`);
    expect(commandSuggestions(registry, "sess").map((item) => item.value)).toContain("sessions");
    expect(commandSuggestions(registry, "res")).toContainEqual(
      expect.objectContaining({
        value: "resume",
        description: resumeCommand?.description,
        argumentHint: resumeCommand?.argumentHint,
      }),
    );
  });

  it("/mcp is discoverable from help and suggestions", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mcp-discovery",
    });

    const help = await processUserInput("/help", { registry });
    const mcpHelp = await processUserInput("/help mcp", { registry });

    expect(help.type).toBe("local-command");
    if (help.type !== "local-command") return;
    expect(help.result.message).toContain("/mcp");
    expect(mcpHelp.type).toBe("local-command");
    if (mcpHelp.type !== "local-command") return;
    expect(mcpHelp.result.message).toContain("Command: /mcp");
    expect(mcpHelp.result.message).toContain(
      "Description: Inspect and control MCP server connections",
    );
    expect(commandSuggestions(registry, "mc")).toContainEqual(
      expect.objectContaining({
        value: "mcp",
        description: "Inspect and control MCP server connections",
      }),
    );
  });

  it("/tasks remains internal and is absent from commands, help and suggestions", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-tasks-internal",
    });

    const result = await processUserInput("/tasks", { registry });
    const help = await processUserInput("/help", { registry });
    const taskHelp = await processUserInput("/help tasks", { registry });

    expect(result.type).toBe("unknown-command");
    expect(registry.resolve("tasks")).toBeUndefined();
    expect(help.type === "local-command" ? help.result.message : "").not.toContain("/tasks");
    expect(taskHelp.type === "local-command" ? taskHelp.result.message : "").toBe(
      "No help found for /tasks.",
    );
    expect(commandSuggestions(registry, "task").map((item) => item.value)).not.toContain("tasks");
  });

  it("/goal is discoverable from help and remains available while the agent is running", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-goal-discovery",
      goalManager: new GoalManager(),
    });

    const help = await processUserInput("/help", { registry });
    const goalHelp = await processUserInput("/help goal", { registry });
    const runningSuggestion = commandSuggestions(registry, "go", {
      availabilityState: "running",
    }).find((candidate) => candidate.value === "goal");
    const modalSuggestion = commandSuggestions(registry, "go", {
      availabilityState: "modal",
    }).find((candidate) => candidate.value === "goal");

    expect(help.type).toBe("local-command");
    if (help.type !== "local-command") return;
    expect(help.result.message).toContain("/goal");
    expect(goalHelp.type).toBe("local-command");
    if (goalHelp.type !== "local-command") return;
    expect(goalHelp.result.message).toContain("Command: /goal");
    expect(goalHelp.result.message).toContain("Usage: /goal");
    expect(runningSuggestion).toEqual(
      expect.objectContaining({
        value: "goal",
        description: "Show the current session goal",
        usage: "/goal",
      }),
    );
    expect(runningSuggestion?.disabled).toBeUndefined();
    expect(modalSuggestion).toEqual(
      expect.objectContaining({
        value: "goal",
        disabled: true,
        disabledReason: "Command unavailable while a modal is active.",
      }),
    );
  });

  it("commandSuggestions carries disabled metadata from the current TUI availability state", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-modal-suggestions",
    });

    expect(commandSuggestions(registry, "help", { availabilityState: "modal" })).toContainEqual(
      expect.objectContaining({
        value: "help",
        category: "help",
        source: "builtin",
        disabled: true,
        disabledReason: "Command unavailable while a modal is active.",
      }),
    );
  });

  it("/status exposes session id mode and fork source", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-fork-status-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-fork",
      sessionMode: "fork",
      forkFrom: "session-source",
    });

    const result = await processUserInput("/status", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("sessionId: session-fork");
    expect(result.result.message).toContain("sessionMode: fork");
    expect(result.result.message).toContain("forkFrom: session-source");
  });

  it("builtin registry leaves /mode to the Pico TUI registry", async () => {
    const result = await processUserInput("/mode", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("unknown-command");
    if (result.type !== "unknown-command") return;
    expect(result.command).toBe("mode");
    expect(result.suggestions).toEqual([]);
  });

  it("/snapshots 展示当前 session 可回滚点", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/snapshots", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("snapshots");
    expect(result.result.message).toContain("Rewind");
    expect(result.result.message).toContain("Choose a message to preview");
    expect(result.result.message).toContain("Preview first");
    expect(result.result.message).toContain("turn-1");
    expect(result.result.message).toContain("1 file changed");
    expect(result.result.message).not.toContain("/rewind turn-1 both");
  });

  it("/rewind 无参数展示 Claude 风格选择器入口", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Rewind");
    expect(result.result.message).toContain("Choose a message to preview");
    expect(result.result.message).toContain("Preview first");
    expect(result.result.message).toContain("turn-1");
    expect(result.result.message).toContain("Enter to preview");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "rewind" });
    expect(result.result.message).not.toContain("用法: /rewind <messageId> code|conversation|both");
  });

  it("/checkpoint 作为 /rewind alias 展示同一个入口", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/checkpoint", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("rewind");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "rewind" });
    expect(result.result.message).toContain("Rewind");
    expect(result.result.message).toContain("turn-1");
  });

  it("/rewind <message-id> 也收敛到交互选择器，不绕过 TUI runtime", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind turn-1 code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("已收敛到交互菜单");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "rewind" });
    expect(readFileSync(filePath, "utf8")).toBe("after\n");
  });

  it("/rewind 的旧 message-id 参数不再触发隐藏的直接回滚", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind missing code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("请在列表中选择目标消息");
    expect(result.result.ui).toEqual({ kind: "open-selector", selector: "rewind" });
  });

  it("/compact 在无法安全触发摘要压缩时说明原因", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/compact", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("compact");
    expect(result.result.message).toContain("Compact unavailable");
    expect(result.result.message).toContain("no live session");
  });

  it("/init creates lightweight Pico project entry files without overwriting existing AGENTS.md", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-init-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeFileSync(join(workDir, "AGENTS.md"), "# Existing\n");
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/init", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(readFileSync(join(workDir, "AGENTS.md"), "utf8")).toBe("# Existing\n");
    expect(existsSync(join(workDir, ".pico", "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(workDir, ".pico", "config.json"), "utf8"))).toEqual({
      version: 1,
      commandsDir: ".pico/commands",
      keybindings: {},
    });
    expect(result.result.message).toContain("AGENTS.md already exists");
    expect(result.result.message).toContain("Created .pico/config.json");
  });

  it("/doctor reports env provider model cwd and node diagnostics", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-doctor-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeFileSync(join(workDir, ".env"), "LLM_BASE_URL=https://llm.example.test\n");
    process.env.LLM_BASE_URL = "https://llm.example.test";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL = "glm-5.2";
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/doctor", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("doctor");
    expect(result.result.message).toContain(".env: found");
    expect(result.result.message).toContain("Provider: openai");
    expect(result.result.message).toContain("Model: glm-5.2");
    expect(result.result.message).toContain(`CWD: ${workDir}`);
    expect(result.result.message).toContain("Node:");
  });
});

function writeSessionLog(
  workDir: string,
  sessionId: string,
  timestamp: string,
  records: readonly unknown[],
): void {
  const dir = resolvePicoPaths(workDir).workspace.sessions;
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "meta", schemaVersion: 1 }),
      ...records.map((record) => JSON.stringify(record)),
    ].join("\n") + "\n",
    "utf8",
  );
  const time = new Date(timestamp);
  utimesSync(path, time, time);
}
