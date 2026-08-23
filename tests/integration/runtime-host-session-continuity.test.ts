import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RuntimeHostKernel,
  RuntimeHostOperationError,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostConnection,
  type StorageRootCapability,
} from "@pico/runtime-host";
import { createRuntimeHostComposition } from "../../src/daemon/runtime-host-composition.js";
import {
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered,
} from "../../src/daemon/runtime-host-operations.js";
import {
  SessionSubscriptionRegistry,
  type SessionContinuityDataSource,
  type SessionSubscriptionSnapshot,
} from "../../src/daemon/session-subscription-owner.js";
import type {
  RuntimeParams,
  RuntimeResult,
  RuntimeSessionSubscriptionFrame,
} from "../../src/daemon/protocol.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "../../src/daemon/protocol.js";

ensurePicoRuntimeHostOperationsRegistered();
ensurePicoRuntimeHostSessionContinuityOperationsRegistered();

const workspacePath = "/workspace";
const sessionId = "session-1";
const watermark = {
  historyEpoch: "history-1",
  projectorVersion: 1 as const,
  throughSequence: 4,
};

class DeferredSource implements SessionContinuityDataSource {
  requireReset = false;
  readonly started: Promise<void>;
  #markStarted!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  async readOpenSnapshot(): Promise<SessionSubscriptionSnapshot> {
    this.#markStarted();
    await this.#released;
    return {
      session: {
        sessionId,
        workspacePath,
        title: "Session",
        status: "active",
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      },
      watermark,
      durableTail: [],
      activeOverlay: [],
      queuedInputs: [],
    };
  }

  async readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<RuntimeResult<"session.transcript.page">> {
    return { watermark: params.through, items: [] };
  }

  async readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<RuntimeResult<"session.transcript.advance">> {
    if (this.requireReset) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.RESET_REQUIRED, "projection reset");
    }
    return { after: params.after, through: params.through, changes: [] };
  }

  async readTranscriptWatermark() {
    return watermark;
  }
}

test("session open flushes its snapshot response before activating queued live frames", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-session-continuity-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const source = new DeferredSource();
  let registry: SessionSubscriptionRegistry | undefined;
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: async (context) => {
      registry = new SessionSubscriptionRegistry(context.hostEpoch, source);
      return createRuntimeHostComposition({
        service: { handle: async () => ({}) },
        sessionContinuity: registry,
      });
    },
  });
  t.after(async () => {
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });
  const connection = await connectClient(capability, "session-continuity-client");
  t.after(async () => connection.close().catch(() => undefined));

  const observed: string[] = [];
  const received: RuntimeSessionSubscriptionFrame[] = [];
  connection.setEventListener((event) => {
    received.push(event as unknown as RuntimeSessionSubscriptionFrame);
    observed.push("event");
  });
  const openPending = connection.requestRegistered<RuntimeResult<"session.subscription.open">>(
    "session.subscription.open",
    { workspacePath, sessionId },
    5_000,
  );
  await source.started;
  assert.ok(registry);
  registry.publishReporterEvent(workspacePath, {
    runId: "run-1",
    sessionId,
    type: "assistant.delta",
    resourceVersion: 1,
    at: 1,
    payload: { turn: 1, delta: "queued" },
  });
  source.release();
  const opened = await openPending;
  observed.push("response");
  await waitFor(() => received.length === 1);
  assert.deepEqual(observed, ["response", "event"]);
  assert.equal(received[0]?.hostEpoch, kernel.hostEpoch);
  assert.equal(received[0]?.subscriptionId, opened.subscriptionId);
  assert.equal(received[0]?.sequence, opened.nextSequence);

  const page = await connection.requestRegistered<RuntimeResult<"session.transcript.page">>(
    "session.transcript.page",
    { workspacePath, sessionId, through: watermark },
    5_000,
  );
  assert.deepEqual(page, { watermark, items: [] });
  const through = { ...watermark, throughSequence: 5 };
  const advance = await connection.requestRegistered<RuntimeResult<"session.transcript.advance">>(
    "session.transcript.advance",
    { workspacePath, sessionId, after: watermark, through },
    5_000,
  );
  assert.deepEqual(advance, { after: watermark, through, changes: [] });
  source.requireReset = true;
  await assert.rejects(
    connection.requestRegistered(
      "session.transcript.advance",
      { workspacePath, sessionId, after: watermark, through },
      5_000,
    ),
    (error: unknown) =>
      error instanceof RuntimeHostOperationError && error.code === "reset_required",
  );
  const closed = await connection.requestRegistered<RuntimeResult<"session.subscription.close">>(
    "session.subscription.close",
    { workspacePath, sessionId, subscriptionId: opened.subscriptionId },
    5_000,
  );
  assert.deepEqual(closed, { closed: true });
});

async function connectClient(
  capability: StorageRootCapability<"interactive">,
  clientInstanceId: string,
): Promise<RuntimeHostConnection> {
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const result = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    electionDeadline: performance.now() + 15_000,
  });
  assert.equal(result.kind, "connected");
  if (result.kind !== "connected") throw new Error("Runtime Host did not accept test client");
  return result.connection;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
