import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      await expect(client.request("runtime.ping", {})).resolves.toEqual({ pong: true });
      client.close();
    } finally {
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
