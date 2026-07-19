import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeClient } from "../../src/daemon/client.js";
import { LocalRuntimeDaemon } from "../../src/daemon/server.js";
import type { LocalIpcAuthTokenStore } from "../../src/daemon/ipc-auth.js";
import type { LocalRuntimeService, RuntimeNotificationCursor } from "../../src/daemon/service.js";
import {
  createRuntimeNotification,
  type JsonValue,
  type RuntimeNotification,
  type RuntimeNotificationPage,
  type RuntimeRequest,
} from "../../src/daemon/protocol.js";

class ReplayOverflowService implements LocalRuntimeService {
  readonly durable: RuntimeNotification[] = [];
  replayCalls = 0;
  injectOverflow = false;
  private overflowInjected = false;
  private readonly listeners = new Set<(notification: RuntimeNotification) => void>();

  async handle(_request: RuntimeRequest): Promise<JsonValue> {
    return {};
  }

  async replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage> {
    this.replayCalls++;
    if (this.injectOverflow && !this.overflowInjected) {
      this.overflowInjected = true;
      this.emitDurable("overflow-0");
      this.emitDurable("overflow-1");
      return {
        events: [],
        hasMore: false,
        highWatermarkEventId: this.durable.at(-1)?.eventId,
      };
    }
    const start = cursor.afterEventId
      ? Math.max(0, this.durable.findIndex((event) => event.eventId === cursor.afterEventId) + 1)
      : 0;
    const events = this.durable.slice(start);
    return {
      events,
      hasMore: false,
      ...(events.at(-1) ? { nextAfterEventId: events.at(-1)!.eventId } : {}),
      ...(this.durable.at(-1) ? { highWatermarkEventId: this.durable.at(-1)!.eventId } : {}),
    };
  }

  subscribe(listener: (notification: RuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitDurable(eventId: string, title = eventId): void {
    const event = createRuntimeNotification({
      eventId,
      topic: "run.timeline",
      scope: { workspacePath: this.workspacePath, sessionId: "session-1", runId: "run-1" },
      resourceVersion: this.durable.length + 1,
      at: this.durable.length + 1,
      payload: { runId: "run-1", item: { kind: "status", title } },
    });
    this.durable.push(event);
    for (const listener of this.listeners) listener(event);
  }

  workspacePath = "";
}

test("Runtime client keeps a recovery fence after replay overflow", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-client-replay-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const endpoint = {
    transport: "unix" as const,
    address: join(root, "runtime.sock"),
    authTokenPath: join(root, "runtime.auth"),
  };
  const token = "x".repeat(43);
  const authTokenStore = {
    async rotate() {
      return token;
    },
    async read() {
      return token;
    },
  } satisfies LocalIpcAuthTokenStore;
  const service = new ReplayOverflowService();
  service.workspacePath = await realpath(workspacePath);
  const daemon = new LocalRuntimeDaemon({ endpoint, service, authTokenStore });
  const client = new LocalRuntimeClient(endpoint, {
    authTokenStore,
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 50,
    replayBufferOptions: { maxEvents: 1, maxBytes: 4096 },
  });
  context.after(async () => {
    client.close();
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  await daemon.start();
  const delivered: string[] = [];
  await client.subscribe({ workspacePath }, (event) => delivered.push(event.eventId));

  service.injectOverflow = true;
  await daemon.stop();
  await daemon.start();
  await waitFor(() => service.replayCalls >= 2);
  service.emitDurable("during-recovery-fence");
  await waitFor(
    () => delivered.length === 3,
    5_000,
    () => `replayCalls=${service.replayCalls}, delivered=${delivered.length}`,
  );

  assert.equal(new Set(delivered).size, 3);
  assert.equal(delivered[0], "overflow-0");
  assert.equal(delivered.at(-1), "during-recovery-fence");
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  diagnostic: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Runtime replay ${diagnostic()}`.trim());
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
