import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeEvent,
  type JsonValue,
  type RuntimeEvent,
  type RuntimeRequest,
} from "@pico/protocol";
import { LocalDaemonRuntimeClientAdapter } from "../../apps/desktop/src/main/runtime-client-adapter.js";
import {
  LocalRuntimeDaemon,
  resolveLocalDaemonEndpoint,
  type LocalRuntimeService,
  type RuntimeEventCursor,
} from "../../src/daemon/index.js";

describe("LocalDaemonRuntimeClientAdapter", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reconnects after daemon restart and resumes workspace events from the last event id", async () => {
    // macOS Unix-domain socket paths are limited to roughly 104 bytes.
    const root = await mkdtemp(join(tmpdir(), "pico-drc-"));
    cleanup.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const canonicalWorkspacePath = await realpath(workspacePath);
    const workspaceAliasPath = join(root, "workspace-alias");
    await symlink(workspacePath, workspaceAliasPath, "dir");
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "desktop-runtime-client-test",
    });
    const service = new ReconnectFixtureService(canonicalWorkspacePath);
    let daemon = new LocalRuntimeDaemon({ endpoint, service });
    const client = new LocalDaemonRuntimeClientAdapter(endpoint, {
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 40,
    });
    let subscription: { readonly dispose: () => void } | undefined;
    try {
      await daemon.start();
      const received: string[] = [];
      const connected = await client.subscribe({ workspacePath: workspaceAliasPath }, (event) => {
        received.push(event.eventId);
      });
      subscription = connected;
      expect(connected.replay.events).toHaveLength(1);

      const liveBeforeRestart = service.emit("run.updated", { status: "running" });
      await waitFor(() => received.includes(liveBeforeRestart.eventId));

      await daemon.stop();
      await waitFor(() => service.listenerCount === 0);
      const missedDuringRestart = service.emit("run.updated", { status: "paused" });
      service.duplicateDuringNextReplay = missedDuringRestart.eventId;

      daemon = new LocalRuntimeDaemon({ endpoint, service });
      await daemon.start();
      await waitFor(() => received.includes(missedDuringRestart.eventId));
      const liveAfterRestart = service.emit("run.updated", { status: "running" });
      await waitFor(() => received.includes(liveAfterRestart.eventId));

      expect(service.replayCursors.at(-1)).toEqual({
        workspacePath: canonicalWorkspacePath,
        afterEventId: liveBeforeRestart.eventId,
      });
      expect(received).toEqual([
        liveBeforeRestart.eventId,
        missedDuringRestart.eventId,
        liveAfterRestart.eventId,
      ]);
    } finally {
      subscription?.dispose();
      client.close();
      await daemon.stop();
    }
  });
});

class ReconnectFixtureService implements LocalRuntimeService {
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  readonly replayCursors: RuntimeEventCursor[] = [];
  duplicateDuringNextReplay: string | undefined;

  constructor(private readonly workspacePath: string) {
    this.emit("run.started", { status: "running" });
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async handle(request: RuntimeRequest): Promise<JsonValue> {
    if (request.method !== "runtime.ping") throw new Error(`unexpected method ${request.method}`);
    return { pong: true };
  }

  async replayEvents(cursor: RuntimeEventCursor): Promise<readonly RuntimeEvent[]> {
    this.replayCursors.push({ ...cursor });
    const workspaceEvents = cursor.workspacePath
      ? this.events.filter((event) => event.scope.workspacePath === cursor.workspacePath)
      : this.events;
    const index = cursor.afterEventId
      ? workspaceEvents.findIndex((event) => event.eventId === cursor.afterEventId)
      : -1;
    const replay = index < 0 ? workspaceEvents : workspaceEvents.slice(index + 1);
    const duplicate = replay.find((event) => event.eventId === this.duplicateDuringNextReplay);
    if (duplicate) {
      this.duplicateDuringNextReplay = undefined;
      for (const listener of this.listeners) listener(duplicate);
    }
    return replay;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(topic: string, payload: JsonValue): RuntimeEvent {
    const event = createRuntimeEvent({
      topic,
      scope: { workspacePath: this.workspacePath },
      resourceVersion: this.events.length + 1,
      at: Date.now(),
      payload,
    });
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for desktop runtime reconnect");
}
