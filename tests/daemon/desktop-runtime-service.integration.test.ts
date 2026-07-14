import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
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
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { CronService } from "../../src/tasks/cron-service.js";
import { credentialRefForModelRoute } from "../../src/provider/credential-vault.js";

describe("DesktopRuntimeService integration", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
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

  async function createFixture() {
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
      execute: async () => undefined,
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
