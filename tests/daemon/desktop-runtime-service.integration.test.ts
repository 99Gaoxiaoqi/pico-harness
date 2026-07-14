import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
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
    expect(mcp).toEqual({
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
    expect(await stat(join(fixture.workspace, ".claw", "sessions", `${sessionId}.jsonl`))).toEqual(
      expect.objectContaining({ size: expect.any(Number) }),
    );

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

  async function createFixture(
    execute: ConstructorParameters<typeof WorkspaceRuntimeService>[0]["execute"] = async () =>
      undefined,
  ) {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-runtime-"));
    cleanups.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canonicalWorkspace = await import("node:fs/promises").then(({ realpath }) =>
      realpath(workspace),
    );
    const registration = new WorkspaceRegistrationStore(join(root, "state", "workspaces.json"));
    const trust = new WorkspaceTrustStore({ userStateDirectory: join(root, "state", "trust") });
    const sessionState = new DesktopSessionStateStore({
      filePath: join(root, "state", "desktop-sessions.json"),
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
    });
    return {
      root,
      workspace,
      canonicalWorkspace,
      registration,
      trust,
      sessionState,
      runtime,
      service,
    };
  }
});
