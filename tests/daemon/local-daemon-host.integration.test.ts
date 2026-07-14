import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRef, CredentialVault } from "../../src/provider/credential-vault.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
  type RunAgentCliResult,
} from "../../src/runtime/agent-runtime.js";
import type { AskUserRequestId } from "../../src/tools/ask-user.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import {
  LocalDaemonAlreadyRunningError,
  LocalDaemonHost,
  LocalRuntimeClient,
  LocalRuntimeDaemon,
  createProductionLocalDaemonHost,
  resolveLocalDaemonEndpoint,
  WorkspaceRegistrationStore,
  type CronWorkspaceRuntimeFactoryInput,
  type JsonValue,
  type LocalRuntimeService,
  type ManagedCronWorkspaceRuntime,
  type RuntimeEvent,
  type RuntimeRequest,
} from "../../src/daemon/index.js";

describe("LocalDaemonHost integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("恢复登记工作区、持有用户级单例并在关闭时释放资源", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-host-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const registration = new WorkspaceRegistrationStore(join(root, "daemon-workspaces.json"));
    const canonical = await registration.register(workspace);
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "host-test",
    });
    const managed: ManagedCronWorkspaceRuntime & {
      recovered: number;
      started: number;
      closed: number;
    } = {
      recovered: 0,
      started: 0,
      closed: 0,
      recoverInterruptedRuns() {
        this.recovered += 1;
        return [];
      },
      start() {
        this.started += 1;
      },
      async close() {
        this.closed += 1;
      },
    };
    const created: CronWorkspaceRuntimeFactoryInput[] = [];
    const host = new LocalDaemonHost({
      endpoint,
      service: new PingService(),
      registrationStore: registration,
      cronRuntimeFactory: {
        create: async (input) => {
          created.push(input);
          return managed;
        },
      },
    });
    await host.start();

    expect(host.registeredWorkspaces).toEqual([canonical]);
    expect(created).toEqual([
      expect.objectContaining({ workspacePath: canonical, ownerId: host.ownerId }),
    ]);
    expect(managed).toEqual(expect.objectContaining({ recovered: 1, started: 1 }));
    const client = new LocalRuntimeClient(endpoint);
    await expect(client.request("runtime.ping", {})).resolves.toEqual({ pong: true });
    client.close();

    const competing = new LocalDaemonHost({
      endpoint,
      service: new PingService(),
      registrationStore: registration,
      cronRuntimeFactory: { create: async () => managed },
    });
    await expect(competing.start()).rejects.toBeInstanceOf(LocalDaemonAlreadyRunningError);
    const stillAlive = new LocalRuntimeClient(endpoint);
    await expect(stillAlive.request("runtime.ping", {})).resolves.toEqual({ pong: true });
    stillAlive.close();

    await host.stop();
    expect(managed.closed).toBe(1);
  });

  it("活跃旧版 socket 即使没有 lock 也不会被新 host 删除", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-legacy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "legacy-test",
    });
    const legacy = new LocalRuntimeDaemon({ endpoint, service: new PingService() });
    await legacy.start();
    try {
      const host = new LocalDaemonHost({
        endpoint,
        service: new PingService(),
        registrationStore: new WorkspaceRegistrationStore(join(root, "workspaces.json")),
        cronRuntimeFactory: { create: async () => new EmptyCronRuntime() },
      });
      await expect(host.start()).rejects.toBeInstanceOf(LocalDaemonAlreadyRunningError);
      const client = new LocalRuntimeClient(endpoint);
      await expect(client.request("runtime.ping", {})).resolves.toEqual({ pong: true });
      client.close();
    } finally {
      await legacy.stop();
    }
  });

  it("生产装配以安全后台执行器启动内部 daemon，不依赖 TUI 生命周期", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-production-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "production-test",
    });
    const host = createProductionLocalDaemonHost({
      endpoint,
      registrationStore: new WorkspaceRegistrationStore(join(root, "workspaces.json")),
    });
    await host.start();
    try {
      const client = new LocalRuntimeClient(endpoint);
      await expect(client.request("runtime.ping", {})).resolves.toEqual(
        expect.objectContaining({
          pong: true,
          capabilities: expect.arrayContaining(["session-conversation-v1"]),
        }),
      );
      client.close();
    } finally {
      await host.stop();
    }
  });

  it("受信任桌面 Run 使用真实交互边界并幂等接收审批与 Ask User", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-desktop-run-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync(
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
    await writeFile(
      join(workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_DESKTOP_TEST_KEY",
            models: ["coder"],
          },
        },
      }),
    );
    const trustStore = new WorkspaceTrustStore({
      userStateDirectory: join(root, "trust"),
    });
    await trustStore.trust(await trustStore.canonicalize(workspace));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "desktop-run-test",
    });
    const host = createProductionLocalDaemonHost({
      endpoint,
      trustStore,
      agentRuntime: new InteractiveFakeAgentRuntime(),
      credentialVault: new AvailableCredentialVault(),
      registrationStore: new WorkspaceRegistrationStore(join(root, "workspaces.json")),
    });
    await host.start();
    const client = new LocalRuntimeClient(endpoint);
    try {
      const approvalEvent = deferred<RuntimeEvent>();
      const promptEvent = deferred<RuntimeEvent>();
      const timelineEvents: RuntimeEvent[] = [];
      await client.subscribe(
        (event) => {
          if (event.topic === "approval.requested") approvalEvent.resolve(event);
          if (event.topic === "prompt.requested") promptEvent.resolve(event);
          if (event.topic === "run.timeline") timelineEvents.push(event);
        },
        undefined,
        workspace,
      );

      const run = (await client.request("run.start", {
        workspacePath: workspace,
        sessionId: "desktop-session-1",
        prompt: "检查项目并给出结论",
      })) as { runId: string };
      const approval = await approvalEvent.promise;
      const prompt = await promptEvent.promise;
      expect(approval.scope.runId).toBe(run.runId);
      expect(prompt.scope.runId).toBe(run.runId);

      await expect(
        client.request("approval.respond", {
          workspacePath: join(root, "other-workspace"),
          approvalId: "approval-1",
          decision: "allow_once",
        }),
      ).rejects.toThrow(/^FORBIDDEN:/u);
      await expect(
        client.request("approval.respond", {
          workspacePath: workspace,
          approvalId: "approval-1",
          decision: "allow_once",
        }),
      ).resolves.toEqual({ accepted: true, alreadyResolved: false });
      await expect(
        client.request("approval.respond", {
          workspacePath: workspace,
          approvalId: "approval-1",
          decision: "allow_once",
        }),
      ).resolves.toEqual({ accepted: true, alreadyResolved: true });
      await expect(
        client.request("prompt.respond", {
          workspacePath: join(root, "other-workspace"),
          promptId: "prompt-1",
          answer: "保留兼容",
        }),
      ).rejects.toThrow(/^FORBIDDEN:/u);
      await expect(
        client.request("prompt.respond", {
          workspacePath: workspace,
          promptId: "prompt-1",
          answer: "任意自由文本",
        }),
      ).rejects.toThrow(/^INVALID_PARAMS:/u);
      await expect(
        client.request("prompt.respond", {
          workspacePath: workspace,
          promptId: "prompt-1",
          answer: "保留兼容",
        }),
      ).resolves.toEqual({ accepted: true, alreadyResolved: false });

      await expect
        .poll(async () => {
          const listed = (await client.request("runs.list", {
            workspacePath: workspace,
          })) as { runs: Array<{ runId: string; status: string }> };
          return listed.runs.find((candidate) => candidate.runId === run.runId)?.status;
        })
        .toBe("succeeded");
      expect(timelineEvents.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item: expect.objectContaining({ eventType: "tool.started" }) }),
          expect.objectContaining({
            item: expect.objectContaining({ eventType: "tool.completed" }),
          }),
        ]),
      );
    } finally {
      client.close();
      await host.stop();
    }
  });

  it("生产桌面 Run 使用 Session 选择的模型、模式和思考档位", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-ds-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(
      join(workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_DESKTOP_TEST_KEY",
            models: {
              coder: {},
              reasoner: {
                reasoning: {
                  enabled: true,
                  defaultLevel: "high",
                  levels: ["off", "high", "max"],
                },
              },
            },
          },
        },
      }),
    );
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: join(root, "trust") });
    await trustStore.trust(await trustStore.canonicalize(workspace));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "settings",
    });
    const agentRuntime = new CapturingSettingsAgentRuntime();
    const host = createProductionLocalDaemonHost({
      endpoint,
      trustStore,
      agentRuntime,
      credentialVault: new AvailableCredentialVault(),
      registrationStore: new WorkspaceRegistrationStore(join(root, "workspaces.json")),
    });
    await host.start();
    const client = new LocalRuntimeClient(endpoint);
    try {
      const created = (await client.request("session.create", {
        workspacePath: workspace,
      })) as { session: { sessionId: string } };
      await client.request("session.settings.update", {
        workspacePath: workspace,
        sessionId: created.session.sessionId,
        modelRouteId: "local/reasoner",
        permissions: "plan",
        thinkingEffort: "max",
      });
      await client.request("run.start", {
        workspacePath: workspace,
        sessionId: created.session.sessionId,
        prompt: "按计划检查项目",
      });

      await expect(agentRuntime.received.promise).resolves.toMatchObject({
        session: created.session.sessionId,
        model: "reasoner",
        modelRouteId: "local/reasoner",
        thinkingEffort: "max",
        planMode: true,
        rewindInteractionMode: "plan",
      });
    } finally {
      client.close();
      await host.stop();
    }
  });

  it("生产 daemon 通过 IPC 创建、执行并审计桌面 Automation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-auto-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(
      join(workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/coder",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_DESKTOP_TEST_KEY",
            models: ["coder"],
          },
        },
      }),
    );
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: join(root, "trust") });
    await trustStore.trust(await trustStore.canonicalize(workspace));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "auto-test",
    });
    const host = createProductionLocalDaemonHost({
      endpoint,
      trustStore,
      agentRuntime: new AutomationFakeAgentRuntime(),
      credentialVault: new AvailableCredentialVault(),
      registrationStore: new WorkspaceRegistrationStore(join(root, "workspaces.json")),
    });
    await host.start();
    const client = new LocalRuntimeClient(endpoint);
    try {
      const created = (await client.request("jobs.create", {
        workspacePath: workspace,
        name: "Repository health",
        prompt: "summarize repository health",
        schedule: "0 0 1 1 *",
      })) as { job: { jobId: string; enabled: boolean } };
      expect(created.job.enabled).toBe(true);
      expect(host.registeredWorkspaces).toHaveLength(1);

      const receipt = (await client.request("jobs.runNow", {
        workspacePath: workspace,
        jobId: created.job.jobId,
      })) as { runId: string };
      await expect
        .poll(async () => {
          const history = (await client.request("jobs.history", {
            workspacePath: workspace,
            jobId: created.job.jobId,
          })) as { runs: Array<{ runId: string; status: string; error?: string }> };
          const run = history.runs.find((candidate) => candidate.runId === receipt.runId);
          return run ? `${run.status}:${run.error ?? ""}` : undefined;
        })
        .toBe("succeeded:");

      await client.request("jobs.setEnabled", {
        workspacePath: workspace,
        jobId: created.job.jobId,
        enabled: false,
      });
      await expect(
        client.request("jobs.delete", {
          workspacePath: workspace,
          jobId: created.job.jobId,
        }),
      ).resolves.toEqual({ deleted: true });
    } finally {
      client.close();
      await host.stop();
    }
  });

  it("并发登记与取消登记不丢失更新", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-registration-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspaces = ["a", "b", "c"].map((name) => join(root, name));
    await Promise.all(workspaces.map((workspace) => mkdir(workspace)));
    const registration = new WorkspaceRegistrationStore(join(root, "workspaces.json"));

    const [a, b] = await Promise.all([
      registration.register(workspaces[0]!),
      registration.register(workspaces[1]!),
    ]);
    const [, c] = await Promise.all([
      registration.unregister(workspaces[0]!),
      registration.register(workspaces[2]!),
    ]);

    await expect(registration.list()).resolves.toEqual([b, c].sort());
    expect(a).not.toBe(b);
  });

  it("并发 refresh 串行 reconcile，相同工作区只创建一个 runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-refresh-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const registration = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "refresh-test",
    });
    const createStarted = deferred<void>();
    const allowCreate = deferred<void>();
    let created = 0;
    let closed = 0;
    const host = new LocalDaemonHost({
      endpoint,
      service: new PingService(),
      registrationStore: registration,
      cronRuntimeFactory: {
        create: async () => {
          created += 1;
          createStarted.resolve();
          await allowCreate.promise;
          return {
            recoverInterruptedRuns: () => [],
            start: () => undefined,
            close: async () => {
              closed += 1;
            },
          };
        },
      },
    });
    cleanups.push(() => host.stop());
    await host.start();
    const canonical = await registration.register(workspace);

    const first = host.refreshRegisteredWorkspaces();
    await createStarted.promise;
    const second = host.refreshRegisteredWorkspaces();
    allowCreate.resolve();
    await Promise.all([first, second]);

    expect(host.registeredWorkspaces).toEqual([canonical]);
    expect(created).toBe(1);
    await host.stop();
    expect(closed).toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class PingService implements LocalRuntimeService {
  async handle(request: RuntimeRequest): Promise<JsonValue> {
    if (request.method !== "runtime.ping") throw new Error(`unexpected method ${request.method}`);
    return { pong: true };
  }

  async replayEvents(): Promise<readonly RuntimeEvent[]> {
    return [];
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

class EmptyCronRuntime implements ManagedCronWorkspaceRuntime {
  recoverInterruptedRuns(): readonly never[] {
    return [];
  }

  start(): void {}

  async close(): Promise<void> {}
}

class AvailableCredentialVault implements CredentialVault {
  capability() {
    return {
      available: true,
      backend: "macos-keychain" as const,
      diagnostic: "test vault",
    };
  }

  async put(): Promise<void> {}

  async has(): Promise<boolean> {
    return true;
  }

  async resolve(_ref: CredentialRef): Promise<string> {
    return "desktop-test-secret";
  }
}

class InteractiveFakeAgentRuntime extends AgentRuntime {
  override async execute(
    options: RunAgentCliOptions,
    dependencies: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    if (!dependencies.approvalManager || !dependencies.approvalNotifier) {
      throw new Error("desktop approval boundary missing");
    }
    if (!dependencies.askUserHandler) throw new Error("desktop AskUser boundary missing");
    if (!dependencies.runtimeState?.taskHostRuntime) {
      throw new Error("desktop Git workspace task host missing");
    }
    const sessionId = options.session ?? "missing-session";
    const workDir = options.dir ?? process.cwd();
    dependencies.reporter?.onStart(workDir);
    dependencies.reporter?.onToolCall("bash", '{"command":"npm test"}', "call-1");
    const approval = dependencies.approvalManager.waitForApproval(
      "approval-1",
      "bash",
      '{"command":"npm test"}',
      dependencies.approvalNotifier,
      undefined,
      dependencies.signal,
    );
    const answer = dependencies.askUserHandler.waitForAnswer(
      {
        requestId: "prompt-1" as AskUserRequestId,
        question: "如何处理兼容性？",
        options: [
          { optionId: "keep", label: "保留兼容" },
          { optionId: "break", label: "允许破坏" },
        ],
      },
      dependencies.signal,
    );
    const [approvalResult, promptResult] = await Promise.all([approval, answer]);
    if (!approvalResult.allowed || promptResult.kind !== "selected") {
      throw new Error("desktop interaction rejected");
    }
    dependencies.reporter?.onToolResult("bash", "tests passed", false, "call-1");
    dependencies.reporter?.onMessage("已保留兼容并完成验证。\n");
    dependencies.reporter?.onFinish();
    return {
      sessionId,
      sessionSelection: { mode: "resume", sessionId },
      workDir,
      finalMessage: "已保留兼容并完成验证。",
      usage: { promptTokens: 12, completionTokens: 6, costCNY: 0.01 },
      messages: [],
    };
  }
}

class AutomationFakeAgentRuntime extends AgentRuntime {
  override async execute(
    options: RunAgentCliOptions,
    _dependencies: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    if (options.execution?.kind !== "background") {
      throw new Error("automation must use the background execution boundary");
    }
    const sessionId = options.session ?? "automation-session";
    return {
      sessionId,
      sessionSelection: { mode: "new", sessionId },
      workDir: options.dir ?? process.cwd(),
      finalMessage: "repository healthy",
      usage: { promptTokens: 8, completionTokens: 2, costCNY: 0.001 },
      messages: [],
    };
  }
}

class CapturingSettingsAgentRuntime extends AgentRuntime {
  readonly received = deferred<RunAgentCliOptions>();

  override async execute(
    options: RunAgentCliOptions,
    _dependencies: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    this.received.resolve(options);
    const sessionId = options.session ?? "missing-session";
    return {
      sessionId,
      sessionSelection: { mode: "resume", sessionId },
      workDir: options.dir ?? process.cwd(),
      finalMessage: "settings applied",
      usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
      messages: [],
    };
  }
}
