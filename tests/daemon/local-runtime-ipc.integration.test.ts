import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  LocalRuntimeClient,
  LocalRuntimeDaemon,
  resolveLocalDaemonEndpoint,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeRegistry,
  WorkspaceRuntimeService,
  type JsonValue,
  type LocalRuntimeService,
  type RuntimeEvent,
  type RuntimeRequest,
} from "../../src/daemon/index.js";
import type { WorkspaceRuntimeEvent } from "../../src/runtime/workspace-runtime.js";

describe("local runtime daemon IPC integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("serves versioned requests and replays then streams runtime events over a private Unix socket", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const service = new FixtureRuntimeService(workspace);
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "test-user",
    });
    const daemon = new LocalRuntimeDaemon({ endpoint, service });
    const client = new LocalRuntimeClient(endpoint);
    try {
      await daemon.start();
      if (endpoint.transport === "unix") {
        expect((await stat(endpoint.address)).mode & 0o777).toBe(0o600);
      }

      await expect(client.request("runtime.ping", { probe: true })).resolves.toEqual({
        pong: true,
      });
      const replayed = await client.request("events.replay", {});
      expect(replayed).toEqual({ events: [service.events[0]] });

      const liveEvent = new Promise<RuntimeEvent>((resolve) => {
        void client.subscribe(resolve, service.events[0]!.eventId);
      });
      await waitFor(() => service.listenerCount === 1);
      const next = service.emit("run.updated", { runId: "run-2" });
      await expect(liveEvent).resolves.toEqual(next);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it("canonicalizes workspaces so aliases share one runtime while distinct workspaces stay isolated", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    let created = 0;
    const registry = new WorkspaceRuntimeRegistry({
      create: async (workspacePath) => ({ workspacePath, instance: ++created }),
    });
    try {
      const [firstA, firstB, second] = await Promise.all([
        registry.get(firstPath),
        registry.get(firstPath),
        registry.get(secondPath),
      ]);
      expect(firstA).toBe(firstB);
      expect(firstA.workspacePath).not.toBe(second.workspacePath);
      expect(created).toBe(2);
    } finally {
      await registry.close();
    }
  });

  it("注册非 Git 工作区并保留普通文件夹能力边界", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "plain-folder");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const registrations = new WorkspaceRegistrationStore(join(root, "daemon-workspaces.json"));
    const service = new WorkspaceRuntimeService({
      execute: async () => undefined,
      registrationStore: registrations,
    });
    try {
      await expect(
        service.handle(createRuntimeRequest("workspace.register", { workspacePath: workspace })),
      ).resolves.toEqual({
        workspacePath: canonicalWorkspace,
        registered: true,
      });
      await expect(registrations.list()).resolves.toEqual([canonicalWorkspace]);
      await expect(service.getWorkspaceRuntime(workspace)).resolves.toMatchObject({
        workspace: canonicalWorkspace,
        mode: "folder",
        capabilities: {
          foregroundRuns: true,
          fileHistory: true,
          isolatedWorktrees: false,
          branchMerge: false,
        },
      });
    } finally {
      await service.close();
    }
  });

  it("persists workspace Runtime events in SQLite so a restarted daemon replays them by eventId", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const registrations = new WorkspaceRegistrationStore(join(root, "daemon-workspaces.json"));
    const runtime = new EventingWorkspaceRuntime(canonicalWorkspace);
    const service = new WorkspaceRuntimeService({
      execute: async () => undefined,
      createWorkspaceRuntime: async () => runtime as never,
      registrationStore: registrations,
    });
    try {
      await service.handle(
        createRuntimeRequest("workspace.register", { workspacePath: workspace }),
      );
      await service.handle(createRuntimeRequest("runs.list", { workspacePath: workspace }));
      expect(runtime.listenerCount).toBe(1);
      runtime.emit("run.finished", "run-event-1");
      const initial = await service.replayEvents({ workspacePath: workspace });
      const registered = initial.find((event) => event.topic === "workspace.registered");
      const finished = initial.find((event) => event.topic === "run.finished");
      expect(registered).toBeDefined();
      expect(finished).toBeDefined();
      await service.close();

      const restarted = new WorkspaceRuntimeService({
        execute: async () => undefined,
        registrationStore: registrations,
      });
      try {
        const replayed = await restarted.replayEvents({
          workspacePath: workspace,
          afterEventId: registered!.eventId,
        });
        expect(replayed).toEqual([
          expect.objectContaining({
            eventId: finished!.eventId,
            topic: "run.finished",
            scope: { workspacePath: canonicalWorkspace, runId: "run-1" },
          }),
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await service.close();
    }
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-ipc-"));
    cleanup.push(root);
    return root;
  }
});

class EventingWorkspaceRuntime {
  readonly workspacePath: string;
  readonly workspace: string;
  private readonly listeners = new Set<(event: WorkspaceRuntimeEvent) => void>();

  constructor(workspace: string) {
    this.workspace = workspace;
    this.workspacePath = workspace;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (event: WorkspaceRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listRuns() {
    return [];
  }

  listTasks() {
    return [];
  }

  async close(): Promise<void> {}

  emit(type: WorkspaceRuntimeEvent["type"], eventId: string): void {
    const event: WorkspaceRuntimeEvent = {
      eventId,
      type,
      workspace: this.workspace,
      at: Date.now(),
      resourceVersion: 2,
      run: {
        runId: "run-1",
        workspace: this.workspace,
        description: "persisted run",
        status: "succeeded",
        startedAt: 1,
        updatedAt: 2,
        finishedAt: 2,
        version: 2,
      },
    };
    for (const listener of this.listeners) listener(event);
  }
}

class FixtureRuntimeService implements LocalRuntimeService {
  readonly events: RuntimeEvent[];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(private readonly workspacePath: string) {
    this.events = [this.event("run.started", { runId: "run-1" })];
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async handle(request: RuntimeRequest): Promise<JsonValue> {
    if (request.method !== "runtime.ping") throw new Error(`unexpected method ${request.method}`);
    return { pong: true };
  }

  async replayEvents(cursor: { afterEventId?: string }): Promise<readonly RuntimeEvent[]> {
    if (!cursor.afterEventId) return this.events;
    const index = this.events.findIndex((event) => event.eventId === cursor.afterEventId);
    return index < 0 ? this.events : this.events.slice(index + 1);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(topic: string, payload: JsonValue): RuntimeEvent {
    const event = this.event(topic, payload);
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  private event(topic: string, payload: JsonValue): RuntimeEvent {
    return createRuntimeEvent({
      topic,
      scope: { workspacePath: this.workspacePath },
      resourceVersion: this.events?.length ?? 0,
      at: Date.now(),
      payload,
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for daemon subscription");
}
