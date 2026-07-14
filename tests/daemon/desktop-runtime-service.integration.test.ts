import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
  DesktopConversationStateStore,
  DesktopAutomationService,
  DesktopRuntimeService,
  DesktopSessionStateStore,
  LocalRuntimeClient,
  LocalRuntimeDaemon,
  RUNTIME_ERROR_CODES,
  resolveLocalDaemonEndpoint,
  RuntimeProtocolError,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { fileHistoryTrackEdit } from "../../src/safety/file-history.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { CronService } from "../../src/tasks/cron-service.js";
import { credentialRefForModelRoute } from "../../src/provider/credential-vault.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

const execFile = promisify(execFileCallback);

describe("DesktopRuntimeService integration", () => {
  const cleanups: string[] = [];
  const managedSessions: { sessionId: string; workspacePath: string }[] = [];

  afterEach(async () => {
    for (const session of managedSessions.splice(0)) {
      globalSessionManager.delete(session.sessionId, session.workspacePath);
      cleanups.push(
        join(
          homedir(),
          ".pico",
          "file-history",
          createHash("sha256").update(session.sessionId).digest("hex").slice(0, 32),
        ),
      );
    }
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("仅在信任工作区安全初始化入口文件，并提供只诊断不修复的 Doctor 结果", async () => {
    const fixture = await createFixture(undefined, {
      env: {
        ...process.env,
        LLM_PROVIDER: "openai",
        LLM_MODEL: "gpt-test",
        LLM_API_KEY: "test-only",
      },
    });
    const observedTopics: string[] = [];
    const unsubscribe = fixture.service.subscribe((event) => observedTopics.push(event.topic));

    for (const method of ["workspace.init", "diagnostics.run", "diagnostics.resources"] as const) {
      await expect(
        fixture.service.handle(createRuntimeRequest(method, { workspacePath: fixture.workspace })),
      ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.FORBIDDEN });
    }

    await fixture.trust.trust(fixture.canonicalWorkspace);
    await writeFile(join(fixture.workspace, "AGENTS.md"), "# Existing guidance\n");
    const initialized = await fixture.service.handle(
      createRuntimeRequest("workspace.init", { workspacePath: fixture.workspace }),
    );
    expect(initialized).toMatchObject({
      workspacePath: fixture.canonicalWorkspace,
      files: [
        { path: "AGENTS.md", status: "existing" },
        { path: ".pico/config.json", status: "created" },
      ],
    });
    await expect(readFile(join(fixture.workspace, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Existing guidance\n",
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("workspace.init", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toMatchObject({
      files: [
        { path: "AGENTS.md", status: "existing" },
        { path: ".pico/config.json", status: "existing" },
      ],
    });

    await mkdir(join(fixture.workspace, ".pico", "skills", "review"), { recursive: true });
    const diagnostics = await fixture.service.handle(
      createRuntimeRequest("diagnostics.run", { workspacePath: fixture.workspace }),
    );
    expect(diagnostics).toMatchObject({
      workspacePath: fixture.canonicalWorkspace,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "cwd", status: "ok" }),
        expect.objectContaining({ id: "session-catalog" }),
        expect.objectContaining({ id: "storage" }),
      ]),
      output: expect.stringContaining(`CWD: ${fixture.canonicalWorkspace} (ok)`),
    });

    const resources = await fixture.service.handle(
      createRuntimeRequest("diagnostics.resources", { workspacePath: fixture.workspace }),
    );
    expect(resources).toMatchObject({
      workDir: fixture.canonicalWorkspace,
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: "skills",
          origin: "pico-native",
          status: "present",
          authority: true,
        }),
      ]),
      output: expect.stringContaining("Resource skills: pico-native"),
    });
    expect(observedTopics).toContain("workspace.initialized");

    unsubscribe();
    await fixture.service.close();
  });

  it("初始化在 .pico 符号链接越出工作区时失败并且不写入外部目录", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.workspace, ".pico"));
    await fixture.trust.trust(fixture.canonicalWorkspace);

    await expect(
      fixture.service.handle(
        createRuntimeRequest("workspace.init", { workspacePath: fixture.workspace }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("工作区边界外"),
    });
    await expect(stat(join(outside, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(fixture.workspace, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fixture.service.close();
  });

  it("共用登记与信任真源，只在信任后投影脱敏配置、Skills 与 MCP", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspace, ".pico"));
    await writeFile(
      join(fixture.workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "http://127.0.0.1:11434/v1",
            apiKeyEnv: "PICO_TEST_TOKEN",
            models: ["coder"],
          },
        },
      }),
    );
    await mkdir(join(fixture.workspace, ".claw", "skills", "review"), { recursive: true });
    await writeFile(
      join(fixture.workspace, ".claw", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\n\n# Review\n",
    );
    await writeFile(
      join(fixture.workspace, ".claw", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            transport: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "Bearer never-expose" },
          },
        },
      }),
    );

    await fixture.service.handle(
      createRuntimeRequest("workspace.register", { workspacePath: fixture.workspace }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("config.get", { workspacePath: fixture.workspace }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.FORBIDDEN });

    const trusted = await fixture.service.handle(
      createRuntimeRequest("workspace.trust", {
        workspacePath: fixture.workspace,
        trusted: true,
      }),
    );
    expect(trusted).toMatchObject({ trusted: true });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("workspace.trustStatus", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toMatchObject({ trusted: true });
    await expect(
      fixture.service.handle(createRuntimeRequest("workspace.list", {})),
    ).resolves.toEqual({
      workspaces: [
        {
          workspacePath: fixture.canonicalWorkspace,
          registered: true,
          schedulerStatus: "unknown",
          mode: "git",
          capabilities: {
            foregroundRuns: true,
            fileHistory: true,
            isolatedWorktrees: true,
            branchMerge: true,
          },
        },
      ],
    });

    await expect(
      fixture.service.handle(
        createRuntimeRequest("config.get", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toMatchObject({
      config: { model: "local/coder", sandbox: { network: "deny" } },
      version: expect.any(Number),
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("config.providers", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toMatchObject({
      providers: [
        {
          id: "local",
          protocol: "openai",
          apiKeyEnv: "PICO_TEST_TOKEN",
          models: ["coder"],
        },
      ],
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("config.skills", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toMatchObject({ skills: [{ name: "review", description: "Review code" }] });
    const mcp = await fixture.service.handle(
      createRuntimeRequest("config.mcpServers", { workspacePath: fixture.workspace }),
    );
    expect(mcp).toMatchObject({
      servers: [
        { name: "local", transport: "http", status: "pending", toolCount: 0, toolNames: [] },
      ],
    });
    expect(JSON.stringify(mcp)).not.toContain("never-expose");

    const events = await fixture.service.replayEvents({
      workspacePath: fixture.workspace,
      limit: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.topic).toBe("workspace.registered");

    await Promise.all([
      fixture.trust.setTrusted(fixture.canonicalWorkspace, false),
      fixture.trust.setTrusted(fixture.canonicalWorkspace, true),
    ]);
    await expect(fixture.trust.isTrusted(fixture.canonicalWorkspace)).resolves.toBe(true);

    await fixture.service.close();
  });

  it("新建会话落入既有 JSONL，归档只持久化桌面元数据且可恢复", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.handle(
      createRuntimeRequest("session.create", {
        workspacePath: fixture.workspace,
        title: "  Desktop   first task  ",
      }),
    );
    expect(created).toMatchObject({
      session: {
        workspacePath: fixture.canonicalWorkspace,
        title: "Desktop first task",
        status: "active",
      },
    });
    const sessionId = (created as { session: { sessionId: string } }).session.sessionId;
    expect(
      await stat(
        join(resolvePicoPaths(fixture.workspace).workspace.sessions, `${sessionId}.jsonl`),
      ),
    ).toEqual(expect.objectContaining({ size: expect.any(Number) }));

    await fixture.service.handle(
      createRuntimeRequest("session.archive", { workspacePath: fixture.workspace, sessionId }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.list", { workspacePath: fixture.workspace }),
      ),
    ).resolves.toEqual({ sessions: [] });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.list", {
          workspacePath: fixture.workspace,
          includeArchived: true,
        }),
      ),
    ).resolves.toMatchObject({ sessions: [{ sessionId, status: "archived" }] });

    await fixture.service.handle(
      createRuntimeRequest("session.restore", { workspacePath: fixture.workspace, sessionId }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.get", { workspacePath: fixture.workspace, sessionId }),
      ),
    ).resolves.toMatchObject({ session: { sessionId, status: "active" } });

    const persistedState = await readFile(fixture.sessionState.filePath, "utf8");
    expect(persistedState).toContain("Desktop first task");
    if (process.platform !== "win32") {
      expect((await stat(fixture.sessionState.filePath)).mode & 0o777).toBe(0o600);
    }
    await fixture.service.close();
  });

  it("复用 Session 真源完成重命名、分叉与手动压缩", async () => {
    const summaryProvider = {
      async generate() {
        return { role: "assistant" as const, content: "## 历史任务快照\n已完成前缀压缩" };
      },
    };
    const fixture = await createFixture(undefined, {
      env: { PICO_TEST_TOKEN: "test-token" },
      providerFactory: () => summaryProvider,
      createSessionId: () => "desktop-fork-target",
    });
    await mkdir(join(fixture.workspace, ".pico"));
    await writeFile(
      join(fixture.workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_TEST_TOKEN",
            models: ["coder"],
            discoverModels: false,
          },
        },
      }),
    );
    await fixture.trust.trust(fixture.canonicalWorkspace);
    const created = (await fixture.service.handle(
      createRuntimeRequest("session.create", {
        workspacePath: fixture.workspace,
        title: "Desktop seed",
      }),
    )) as { session: { sessionId: string } };
    const sourceSessionId = created.session.sessionId;
    managedSessions.push({ sessionId: sourceSessionId, workspacePath: fixture.canonicalWorkspace });
    const source = await globalSessionManager.getOrCreate(
      sourceSessionId,
      fixture.canonicalWorkspace,
      { persistence: true, sessionCatalog: false },
    );
    await source.commitMessages({ role: "user", content: "task one" });
    await source.commitMessages({ role: "assistant", content: "step one" });
    await source.commitMessages({ role: "user", content: "task two" });
    await source.commitMessages({ role: "assistant", content: "step two" });
    await source.commitMessages({ role: "user", content: "recent request" });
    await source.flushPersistence();

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.rename", {
          workspacePath: fixture.workspace,
          sessionId: sourceSessionId,
          title: "  主会话   重构  ",
        }),
      ),
    ).resolves.toMatchObject({ session: { sessionId: sourceSessionId, title: "主会话 重构" } });
    expect(source.getRuntimeStateSnapshot().settings?.title).toBe("主会话 重构");

    const forked = await fixture.service.handle(
      createRuntimeRequest("session.fork", {
        workspacePath: fixture.workspace,
        sessionId: sourceSessionId,
      }),
    );
    expect(forked).toMatchObject({
      sourceSessionId,
      session: {
        sessionId: "desktop-fork-target",
        forkFrom: sourceSessionId,
        title: expect.stringContaining("主会话 重构"),
      },
    });
    managedSessions.push({
      sessionId: "desktop-fork-target",
      workspacePath: fixture.canonicalWorkspace,
    });

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.compact", {
          workspacePath: fixture.workspace,
          sessionId: "desktop-fork-target",
        }),
      ),
    ).resolves.toMatchObject({
      compacted: true,
      beforeMessageCount: 5,
      afterMessageCount: 4,
      session: { sessionId: "desktop-fork-target" },
    });
    const target = await globalSessionManager.getOrCreate(
      "desktop-fork-target",
      fixture.canonicalWorkspace,
      { persistence: true, sessionCatalog: false },
    );
    expect(target.getHistory()[0]?.content).toContain("上下文压缩");
    expect(source.length).toBe(5);

    const events = await fixture.service.replayEvents({ workspacePath: fixture.workspace });
    expect(events.map((event) => event.topic)).toEqual(
      expect.arrayContaining(["session.updated", "session.transcriptUpdated"]),
    );
    await fixture.service.close();
  });

  it("以 Session 为主体幂等发送多轮消息，并从 JSONL 分页恢复可见 Transcript", async () => {
    const fixture = await createFixture(async ({ workspacePath, sessionId, prompt, context }) => {
      if (!sessionId) throw new Error("session.send 必须预先绑定 Session");
      context.bindSession(sessionId);
      const session = await globalSessionManager.getOrCreate(sessionId, workspacePath, {
        persistence: true,
        sessionCatalog: false,
      });
      await session.commitMessages({ role: "user", content: prompt });
      await session.commitMessages({ role: "assistant", content: `reply:${prompt}` });
      await session.flushPersistence();
      return { sessionId };
    });

    const first = await fixture.service.handle(
      createRuntimeRequest("session.send", {
        workspacePath: fixture.workspace,
        input: { text: "检查项目" },
        behavior: "auto",
        idempotencyKey: "send-first",
      }),
    );
    expect(first).toMatchObject({
      disposition: "started",
      session: { title: "检查项目" },
      run: { sessionId: expect.any(String), status: "running" },
    });
    const firstResult = first as {
      session: { sessionId: string };
      run: { runId: string };
    };
    managedSessions.push({
      sessionId: firstResult.session.sessionId,
      workspacePath: fixture.canonicalWorkspace,
    });
    const workspaceRuntime = await fixture.runtime.getWorkspaceRuntime(fixture.workspace);
    await workspaceRuntime.waitForRun(firstResult.run.runId);

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.send", {
          workspacePath: fixture.workspace,
          input: { text: "检查项目" },
          behavior: "auto",
          idempotencyKey: "send-first",
        }),
      ),
    ).resolves.toEqual(first);

    const firstPage = await fixture.service.handle(
      createRuntimeRequest("session.transcript", {
        workspacePath: fixture.workspace,
        sessionId: firstResult.session.sessionId,
        limit: 1,
      }),
    );
    expect(firstPage).toMatchObject({
      items: [{ kind: "runBoundary", status: "succeeded" }],
      nextBefore: expect.any(String),
      revision: expect.any(String),
      queuedInputs: [],
    });
    const revision = (firstPage as { revision: string }).revision;

    const second = await fixture.service.handle(
      createRuntimeRequest("session.send", {
        workspacePath: fixture.workspace,
        sessionId: firstResult.session.sessionId,
        input: { text: "继续解释" },
        behavior: "auto",
        idempotencyKey: "send-second",
      }),
    );
    const secondRunId = (second as { run: { runId: string } }).run.runId;
    await workspaceRuntime.waitForRun(secondRunId);

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.transcript", {
          workspacePath: fixture.workspace,
          sessionId: firstResult.session.sessionId,
          expectedRevision: revision,
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });
    const completeTranscript = (await fixture.service.handle(
      createRuntimeRequest("session.transcript", {
        workspacePath: fixture.workspace,
        sessionId: firstResult.session.sessionId,
      }),
    )) as { items: Array<{ kind: string; content?: string; status?: string }> };
    expect(
      completeTranscript.items
        .filter((item) => item.kind === "userMessage" || item.kind === "assistantMessage")
        .map(({ kind, content }) => ({ kind, content })),
    ).toEqual([
      { kind: "userMessage", content: "检查项目" },
      { kind: "assistantMessage", content: "reply:检查项目" },
      { kind: "userMessage", content: "继续解释" },
      { kind: "assistantMessage", content: "reply:继续解释" },
    ]);
    expect(
      completeTranscript.items
        .filter((item) => item.kind === "runBoundary")
        .map((item) => item.status),
    ).toEqual(["running", "succeeded", "running", "succeeded"]);
    await fixture.service.close();
  });

  it("显式中断会清空当前 Session 的持久化 Queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture(async ({ sessionId, context }) => {
      if (!sessionId) throw new Error("sessionId is required");
      context.bindSession(sessionId);
      await gate;
      return { sessionId };
    });
    const first = (await fixture.service.handle(
      createRuntimeRequest("session.send", {
        workspacePath: fixture.workspace,
        input: { text: "开始长任务" },
        idempotencyKey: "interrupt-first",
      }),
    )) as { session: { sessionId: string }; run: { runId: string } };
    managedSessions.push({
      sessionId: first.session.sessionId,
      workspacePath: fixture.canonicalWorkspace,
    });

    await fixture.service.handle(
      createRuntimeRequest("session.send", {
        workspacePath: fixture.workspace,
        sessionId: first.session.sessionId,
        input: { text: "下一轮" },
        behavior: "queue",
        expectedRunId: first.run.runId,
        idempotencyKey: "interrupt-queue",
      }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.transcript", {
          workspacePath: fixture.workspace,
          sessionId: first.session.sessionId,
        }),
      ),
    ).resolves.toMatchObject({ queuedInputs: [{ input: { text: "下一轮" } }] });

    await fixture.service.handle(
      createRuntimeRequest("run.cancel", {
        workspacePath: fixture.workspace,
        runId: first.run.runId,
        reason: "user interrupt",
      }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.transcript", {
          workspacePath: fixture.workspace,
          sessionId: first.session.sessionId,
        }),
      ),
    ).resolves.toMatchObject({ queuedInputs: [] });

    release();
    const workspaceRuntime = await fixture.runtime.getWorkspaceRuntime(fixture.workspace);
    await workspaceRuntime.waitForRun(first.run.runId);
    await fixture.service.close();
  });

  it("从 Session 真源读写模型模式与思考档位，并从 hydration 快照读取 Goal", async () => {
    const fixture = await createFixture(async () => undefined, {
      createSessionId: () => "desktop-settings-session",
      env: { PICO_TEST_TOKEN: "test-secret" },
    });
    await mkdir(join(fixture.workspace, ".pico"), { recursive: true });
    await writeFile(
      join(fixture.workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_TEST_TOKEN",
            models: {
              coder: {},
              reasoner: {
                reasoning: {
                  enabled: true,
                  defaultLevel: "high",
                  levels: ["off", "high", "max"],
                },
              },
              fixed: { reasoning: true },
            },
          },
        },
      }),
    );
    await fixture.trust.trust(fixture.canonicalWorkspace);
    const created = (await fixture.service.handle(
      createRuntimeRequest("session.create", { workspacePath: fixture.workspace }),
    )) as { session: { sessionId: string } };
    const sessionId = created.session.sessionId;
    managedSessions.push({ sessionId, workspacePath: fixture.canonicalWorkspace });
    const session = await globalSessionManager.getOrCreate(sessionId, fixture.canonicalWorkspace, {
      persistence: true,
      sessionCatalog: false,
    });
    session.updateRuntimeState({
      goal: {
        stateVersion: 1,
        sequence: 1,
        activeGoalId: "goal-1",
        goals: [
          {
            id: "goal-1",
            title: "完成桌面会话化",
            description: "保持 TUI 与 Desktop 的运行真源一致",
            status: "active",
            createdAt: 100,
            budgetUsage: { turns: 2, tokens: 300, costCNY: 0.2, startedAt: 100 },
            progress: "已接通协议",
          },
        ],
      },
    });
    await session.flushPersistence();

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: fixture.workspace,
          sessionId,
          modelRouteId: "local/reasoner",
          permissions: "plan",
          thinkingEffort: "max",
        }),
      ),
    ).resolves.toEqual({
      settings: {
        sessionId,
        provider: "openai",
        model: "reasoner",
        modelRouteId: "local/reasoner",
        mode: "plan",
        permissions: "plan",
        thinkingEffort: "max",
        thinkingEffortExplicit: true,
        reasoningLevels: ["off", "high", "max"],
      },
    });
    expect(session.getRuntimeStateSnapshot().settings).toMatchObject({
      modelRouteId: "local/reasoner",
      mode: "plan",
      thinkingEffort: "max",
    });
    expect(session.getRuntimeStateSnapshot().settings).not.toHaveProperty("permissions");
    expect(session.getRuntimeStateSnapshot().settings).not.toHaveProperty("permissionMode");
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.settings.get", {
          workspacePath: fixture.workspace,
          sessionId,
        }),
      ),
    ).resolves.toMatchObject({
      settings: { modelRouteId: "local/reasoner", mode: "plan", permissions: "plan" },
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("goal.get", { workspacePath: fixture.workspace, sessionId }),
      ),
    ).resolves.toEqual({
      goal: expect.objectContaining({
        activeGoalId: "goal-1",
        goals: [expect.objectContaining({ title: "完成桌面会话化", progress: "已接通协议" })],
      }),
    });

    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: fixture.workspace,
          sessionId,
          mode: "auto",
          permissions: "yolo",
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.INVALID_PARAMS });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: fixture.workspace,
          sessionId,
          modelRouteId: "local/fixed",
          thinkingEffort: "max",
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.INVALID_PARAMS });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("session.settings.get", {
          workspacePath: fixture.workspace,
          sessionId,
        }),
      ),
    ).resolves.toMatchObject({
      settings: { modelRouteId: "local/reasoner", thinkingEffort: "max" },
    });

    const events = await fixture.service.replayEvents({ workspacePath: fixture.workspace });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "session.settingsUpdated",
          payload: expect.objectContaining({ sessionId }),
        }),
      ]),
    );
    await fixture.service.close();
  });

  it("从 Runtime SQLite 返回真实用量，时间区间不伪造无法归属的历史 baseline", async () => {
    const fixture = await createFixture();
    const ledger = new RuntimeStore({ workDir: fixture.workspace });
    ledger.recordProviderCall({
      callId: "call-1",
      sessionId: "session-1",
      purpose: "main",
      provider: "openai",
      model: "coder",
      status: "succeeded",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      cost: 0.25,
      createdAt: 200,
    });
    ledger.putUsageBaseline({
      baselineId: "baseline-1",
      sessionId: "session-1",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.05,
      importedAt: 100,
    });
    ledger.close();

    await expect(
      fixture.service.handle(
        createRuntimeRequest("usage.get", {
          workspacePath: fixture.workspace,
          sessionId: "session-1",
        }),
      ),
    ).resolves.toMatchObject({
      usage: {
        providerCallCount: 1,
        baselineCount: 1,
        total: { inputTokens: 140, outputTokens: 35, totalTokens: 175, cost: 0.3 },
        rangeAccuracy: "all_time_with_baselines",
      },
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("usage.get", {
          workspacePath: fixture.workspace,
          sessionId: "session-1",
          from: 150,
          to: 250,
        }),
      ),
    ).resolves.toMatchObject({
      usage: {
        providerCallCount: 1,
        baselineCount: 0,
        total: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.25 },
        rangeAccuracy: "provider_calls_only",
      },
    });

    const unsupported = fixture.service.handle(
      createRuntimeRequest("config.update", {
        workspacePath: fixture.workspace,
        patch: {},
        expectedVersion: 0,
      }),
    );
    await expect(unsupported).rejects.toBeInstanceOf(RuntimeProtocolError);
    await expect(unsupported).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.METHOD_NOT_FOUND });
    await fixture.service.close();
  });

  it("通过 IPC 保留未开放能力的稳定错误码", async () => {
    const fixture = await createFixture();
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(fixture.root, "runtime"),
      userIdentity: "desktop-runtime-error",
    });
    const daemon = new LocalRuntimeDaemon({ endpoint, service: fixture.service });
    await daemon.start();
    const client = new LocalRuntimeClient(endpoint);
    try {
      await expect(
        client.request("config.update", {
          workspacePath: fixture.workspace,
          patch: {},
          expectedVersion: 0,
        }),
      ).rejects.toThrow(/^METHOD_NOT_FOUND: config\.update /u);
    } finally {
      client.close();
      await daemon.stop();
      await fixture.service.close();
    }
  });

  it("从 Run 精确投影 Changes，并在指纹冲突时 fail-closed 后安全 Rewind", async () => {
    const sessionId = `desktop-changes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const checkpointId = "desktop-checkpoint-1";
    const fixture = await createFixture(async ({ context }) => {
      context.bindSession(sessionId);
      context.bindCheckpoint(checkpointId);
      return { sessionId };
    });
    await execFile("git", ["init", "-q"], { cwd: fixture.workspace });
    managedSessions.push({ sessionId, workspacePath: fixture.canonicalWorkspace });
    await fixture.trust.setTrusted(fixture.canonicalWorkspace, true);

    const filePath = join(fixture.canonicalWorkspace, "src", "answer.ts");
    await mkdir(join(fixture.canonicalWorkspace, "src"));
    await writeFile(filePath, "export const answer = 41;\n");
    const session = await globalSessionManager.getOrCreate(sessionId, fixture.canonicalWorkspace, {
      persistence: true,
      sessionCatalog: false,
    });
    await session.beginRewindPoint({
      messageId: checkpointId,
      userPrompt: "Update the answer",
      transcriptIndex: 0,
      interactionMode: "default",
    });
    await session.commitMessages({ role: "user", content: "Update the answer" });
    await fileHistoryTrackEdit(session.fileHistory, filePath, checkpointId, sessionId);
    await writeFile(filePath, "export const answer = 42;\n");
    await session.commitMessages({ role: "assistant", content: "Done" });

    const started = await fixture.service.handle(
      createRuntimeRequest("run.start", {
        workspacePath: fixture.workspace,
        prompt: "Update the answer",
        sessionId,
      }),
    );
    const runId = (started as { runId: string }).runId;
    await (await fixture.runtime.getWorkspaceRuntime(fixture.workspace)).waitForRun(runId);

    const listed = await fixture.service.handle(
      createRuntimeRequest("changes.list", { workspacePath: fixture.workspace, runId }),
    );
    expect(listed).toMatchObject({
      changes: [{ path: "src/answer.ts", status: "modified", additions: 1, deletions: 1 }],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const fingerprint = (listed as { fingerprint: string }).fingerprint;
    await expect(
      fixture.service.handle(
        createRuntimeRequest("changes.diff", {
          workspacePath: fixture.workspace,
          runId,
          path: "src/answer.ts",
        }),
      ),
    ).resolves.toMatchObject({
      path: "src/answer.ts",
      patch: expect.stringContaining("answer = 42"),
      truncated: false,
      fingerprint,
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("changes.review", {
          workspacePath: fixture.workspace,
          runId,
          decision: "approve",
          expectedFingerprint: fingerprint,
        }),
      ),
    ).resolves.toEqual({ accepted: true, fingerprint });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("changes.review", {
          workspacePath: fixture.workspace,
          runId,
          decision: "request_changes",
          message: "Keep the exported name and add a comment",
          expectedFingerprint: fingerprint,
        }),
      ),
    ).resolves.toEqual({ accepted: true, fingerprint });
    const workspaceRuntime = await fixture.runtime.getWorkspaceRuntime(fixture.workspace);
    const revisionRun = workspaceRuntime
      .listRuns()
      .find((run) => run.description === "Keep the exported name and add a comment");
    expect(revisionRun).toBeDefined();
    if (!revisionRun) throw new Error("changes.review 未启动真实修改 Run");
    await workspaceRuntime.waitForRun(revisionRun.runId);
    await expect(
      fixture.service.handle(
        createRuntimeRequest("changes.apply", {
          workspacePath: fixture.workspace,
          runId,
          expectedFingerprint: fingerprint,
        }),
      ),
    ).resolves.toEqual({ applied: true, fingerprint });

    await expect(
      fixture.service.handle(
        createRuntimeRequest("rewind.list", {
          workspacePath: fixture.workspace,
          sessionId,
        }),
      ),
    ).resolves.toMatchObject({
      checkpoints: [{ checkpointId, label: "Update the answer", changedFileCount: 1 }],
    });
    const preview = await fixture.service.handle(
      createRuntimeRequest("rewind.preview", {
        workspacePath: fixture.workspace,
        sessionId,
        checkpointId,
      }),
    );
    const rewindFingerprint = (preview as { fingerprint: string }).fingerprint;
    await writeFile(filePath, "export const answer = 43;\n");

    await expect(
      fixture.service.handle(
        createRuntimeRequest("changes.apply", {
          workspacePath: fixture.workspace,
          runId,
          expectedFingerprint: fingerprint,
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });

    const conflicted = fixture.service.handle(
      createRuntimeRequest("rewind.apply", {
        workspacePath: fixture.workspace,
        sessionId,
        checkpointId,
        expectedFingerprint: rewindFingerprint,
      }),
    );
    await expect(conflicted).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });
    await expect(readFile(filePath, "utf8")).resolves.toBe("export const answer = 43;\n");

    const refreshed = await fixture.service.handle(
      createRuntimeRequest("rewind.preview", {
        workspacePath: fixture.workspace,
        sessionId,
        checkpointId,
      }),
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("rewind.apply", {
          workspacePath: fixture.workspace,
          sessionId,
          checkpointId,
          expectedFingerprint: (refreshed as { fingerprint: string }).fingerprint,
        }),
      ),
    ).resolves.toMatchObject({ applied: true, sessionId });
    await expect(readFile(filePath, "utf8")).resolves.toBe("export const answer = 41;\n");
    expect(session.getHistory()).toEqual([]);
    await fixture.service.close();
  });

  it("Automations 共用 Cron 账本完成 CRUD、启停、立即运行与历史", async () => {
    const fixture = await createFixture();
    await fixture.trust.trust(fixture.canonicalWorkspace);
    const credentialRef = credentialRefForModelRoute(
      {
        id: "local/coder",
        provider: "openai",
        baseURL: "https://provider.example.test/v1",
        model: "coder",
        apiKeyEnv: "PICO_TEST_TOKEN",
      },
      fixture.canonicalWorkspace,
    );
    const automations = new DesktopAutomationService({
      prepareSecurity: async () => ({
        credentialRef,
        policySnapshot: {
          mode: "yolo",
          backgroundEnabled: true,
          trustedWorkspace: true,
          toolNetworkPolicy: "disabled",
          allowedTools: [],
          hardlineVersion: "builtin-v1",
          hookVersion: "workspace-v1",
          createdAt: 100,
        },
      }),
      ensureWorkspaceRuntime: async (workspacePath) => {
        await fixture.registration.register(workspacePath);
      },
      runNow: async (workspacePath, jobId) => {
        const cron = new CronService({ workDir: workspacePath, now: () => 500 });
        try {
          return cron.runNow(jobId);
        } finally {
          cron.close();
        }
      },
      now: () => 100,
    });
    const service = new DesktopRuntimeService({
      runtimeService: fixture.runtime,
      registrationStore: fixture.registration,
      trustStore: fixture.trust,
      sessionStateStore: fixture.sessionState,
      automations,
      now: () => 100,
    });

    const created = (await service.handle(
      createRuntimeRequest("jobs.create", {
        workspacePath: fixture.workspace,
        name: "Daily health",
        prompt: "check the repository",
        schedule: "0 9 * * 1-5",
      }),
    )) as { job: { jobId: string; enabled: boolean; name: string } };
    expect(created.job).toMatchObject({ name: "Daily health", enabled: true });
    const jobId = created.job.jobId;

    await expect(
      service.handle(
        createRuntimeRequest("jobs.update", {
          workspacePath: fixture.workspace,
          jobId,
          name: "Weekday health",
          schedule: "30 8 * * 1-5",
        }),
      ),
    ).resolves.toMatchObject({
      job: { jobId, name: "Weekday health", schedule: "30 8 * * 1-5" },
    });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.update", {
          workspacePath: fixture.workspace,
          jobId,
          schedule: "@daily",
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.INVALID_PARAMS });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.delete", { workspacePath: fixture.workspace, jobId }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.runNow", { workspacePath: fixture.workspace, jobId }),
      ),
    ).resolves.toMatchObject({ job: { jobId, status: "running" }, runId: expect.any(String) });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.history", {
          workspacePath: fixture.workspace,
          jobId,
          limit: 10,
        }),
      ),
    ).resolves.toMatchObject({
      runs: [{ workspacePath: fixture.canonicalWorkspace, status: "running" }],
    });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.setEnabled", {
          workspacePath: fixture.workspace,
          jobId,
          enabled: false,
        }),
      ),
    ).resolves.toMatchObject({ job: { jobId, enabled: false } });
    await expect(
      service.handle(
        createRuntimeRequest("jobs.delete", { workspacePath: fixture.workspace, jobId }),
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(
      service.handle(createRuntimeRequest("jobs.list", { workspacePath: fixture.workspace })),
    ).resolves.toEqual({ jobs: [] });

    await service.close();
  });

  async function createFixture(
    execute: ConstructorParameters<typeof WorkspaceRuntimeService>[0]["execute"] = async () =>
      undefined,
    desktopOptions: Pick<
      ConstructorParameters<typeof DesktopRuntimeService>[0],
      "env" | "providerFactory" | "createSessionId"
    > = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-runtime-"));
    cleanups.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await execFile("git", ["init", "-q"], { cwd: workspace });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Pico Integration",
        "-c",
        "user.email=pico@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: workspace },
    );
    const canonicalWorkspace = await import("node:fs/promises").then(({ realpath }) =>
      realpath(workspace),
    );
    const registration = new WorkspaceRegistrationStore(join(root, "state", "workspaces.json"));
    const trust = new WorkspaceTrustStore({ userStateDirectory: join(root, "state", "trust") });
    const sessionState = new DesktopSessionStateStore({
      filePath: join(root, "state", "desktop-sessions.json"),
    });
    const conversationState = new DesktopConversationStateStore({
      filePath: join(root, "state", "desktop-conversations.json"),
    });
    const runtime = new WorkspaceRuntimeService({
      execute,
      registrationStore: registration,
    });
    const service = new DesktopRuntimeService({
      runtimeService: runtime,
      registrationStore: registration,
      trustStore: trust,
      sessionStateStore: sessionState,
      conversationStateStore: conversationState,
      ...desktopOptions,
    });
    return {
      root,
      workspace,
      canonicalWorkspace,
      registration,
      trust,
      sessionState,
      conversationState,
      runtime,
      service,
    };
  }
});
