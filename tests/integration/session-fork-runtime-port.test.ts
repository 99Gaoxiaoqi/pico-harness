import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionForkRuntimeConflictError } from "../../src/engine/session-fork-runtime-port.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

test("session fork runtime port preserves the durable fork lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-port-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-port-source", workDir, { persistence: true, picoHome });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const capability = source.runtimeEventCapability!;
    const port = createSessionForkRuntimePort();
    await port.reconcileIncompleteRuns({ capability });

    const messages = source.getHistory();
    const runId = port.deriveBootstrapRunId({
      sourceSessionId: source.id,
      targetSessionId: "fork-port-target",
      operationId: "fork-port-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      messages,
      workDir,
      runtimeAuthority: store,
    });
    assert.match(runId, /^fork-bootstrap:/u);

    let publicationActive = true;
    const publication = {
      async assertOwned() {
        if (!publicationActive) throw new Error("fork publication expired");
      },
    };
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId: "fork-port-target",
      operationId: "fork-port-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      messages,
      workDir,
      runtimeAuthority: store,
      publication,
      statePublication: {
        eventId: "fork:fork-port-operation:state",
        at: "2026-01-01T00:00:00.000Z",
        patch: {
          settings: {
            provider: "openai" as const,
            model: "test",
            mode: "default" as const,
            thinkingEffort: "off",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
        },
      },
    };
    await port.bootstrapFork(bootstrap);
    const targetEvents = await store.readSession("fork-port-target");
    const stateIndex = targetEvents.findIndex((event) => event.kind === "session.state.committed");
    const markerIndex = targetEvents.findIndex((event) => event.kind === "session.forked");
    assert.ok(stateIndex >= 0 && markerIndex > stateIndex);
    assert.equal(
      targetEvents.some((event) => event.kind === "session.forked"),
      true,
    );
    assert.equal(
      targetEvents.some(
        (event) =>
          event.kind === "session.state.committed" &&
          event.eventId === bootstrap.statePublication.eventId,
      ),
      true,
    );
    await port.bootstrapFork(bootstrap);
    assert.equal((await store.readSession("fork-port-target")).length, targetEvents.length);

    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        statePublication: {
          ...bootstrap.statePublication,
          patch: {
            settings: { ...bootstrap.statePublication.patch.settings, model: "conflict" },
          },
        },
      }),
      /another payload/u,
    );
    publicationActive = false;
    await assert.rejects(port.bootstrapFork(bootstrap), /publication expired/u);
    assert.equal((await store.readSession("fork-port-target")).length, targetEvents.length);
    assert.equal(
      targetEvents.some((event) => event.kind === "run.terminal"),
      true,
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session fork rejects a Runtime store that differs from the source Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-store-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const manager = new SessionManager();
  const source = await manager.getOrCreate("fork-store-source", workDir, {
    persistence: true,
    picoHome,
  });
  const foreignStore = new RuntimeEventStore({
    databasePath: join(root, "foreign-runtime.sqlite"),
  });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const service = new SessionForkService({
      workDir,
      picoHome,
      sessionManager: manager,
      runtimeStore: foreignStore,
      runtimePort: createSessionForkRuntimePort(),
    });

    await assert.rejects(
      service.fork({
        sourceSessionId: source.id,
        targetSessionId: "fork-store-target",
        targetMode: "default",
      }),
      /does not match source Session store/u,
    );
    assert.equal(await foreignStore.readSessionManifest("fork-store-target"), undefined);
  } finally {
    await source.close();
    foreignStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fork bootstrap reports a conflicting terminal as a typed durable conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-terminal-conflict-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-terminal-source", workDir, { persistence: true, picoHome });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const port = createSessionForkRuntimePort();
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId: "fork-terminal-target",
      operationId: "fork-terminal-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      messages: source.getHistory(),
      workDir,
      runtimeAuthority: store,
      publication: { async assertOwned() {} },
    };
    await port.bootstrapFork(bootstrap);
    const terminal = (await store.readSession(bootstrap.targetSessionId)).find(
      (event) => event.kind === "run.terminal",
    );
    assert.ok(terminal?.kind === "run.terminal");
    const database = new Database(store.databasePath);
    try {
      database
        .prepare("DELETE FROM agent_runtime_events WHERE session_id = ? AND event_id = ?")
        .run(bootstrap.targetSessionId, terminal.eventId);
    } finally {
      database.close();
    }
    await store.append({
      ...terminal,
      eventId: `${terminal.eventId}:conflict`,
      data: { status: "failed", reason: "injected conflict" },
    });

    await assert.rejects(
      port.bootstrapFork(bootstrap),
      (error: unknown) =>
        error instanceof SessionForkRuntimeConflictError && error.reason === "target_conflict",
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
