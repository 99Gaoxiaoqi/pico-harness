import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionForkRuntimeConflictError } from "../../src/engine/session-fork-runtime-port.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";

/** Windows:分离的后台任务(memory recovery 等)可能短暂持有 pico.sqlite 句柄,
 * 删除临时目录按 EBUSY 有界重试,等待分离 drain 归还 lease。 */
async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 50 || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("session fork runtime port preserves the durable fork lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-port-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-port-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const capability = source.runtimeEventCapability!;
    const port = createSessionForkRuntimePort();
    await port.reconcileIncompleteRuns({ capability });

    const snapshot = await source.readDurableForkSnapshot();
    const seedEntries = snapshot.runtimeSeedEntries;
    const statePublication = {
      eventId: "fork:fork-port-operation:state",
      at: "2026-01-01T00:00:00.000Z",
      patch: {
        settings: {
          provider: "openai" as const,
          model: "test",
          modelRouteId: "test/test",
          mode: "default" as const,
          thinkingEffort: "off",
          thinkingEffortExplicit: false,
          additionalDirectories: [],
        },
      },
    };
    const runId = port.deriveBootstrapRunId({
      sourceSessionId: source.id,
      targetSessionId: "fork-port-target",
      operationId: "fork-port-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      seedEntries,
      statePublication,
      workDir,
      runtimeAuthority: store,
    });
    assert.match(runId, /^fork-bootstrap:/u);
    assert.equal(
      port.deriveBootstrapRunId({
        sourceSessionId: source.id,
        targetSessionId: "fork-port-target",
        operationId: "fork-port-operation",
        operationCreatedAt: "2025-12-31T19:00:00-05:00",
        seedEntries,
        statePublication,
        workDir: `${workDir}/.`,
        runtimeAuthority: store,
      }),
      runId,
    );
    assert.notEqual(
      port.deriveBootstrapRunId({
        sourceSessionId: source.id,
        targetSessionId: "fork-port-target",
        operationId: "fork-port-operation",
        operationCreatedAt: "2027-01-01T00:00:00.000Z",
        seedEntries,
        statePublication,
        workDir,
        runtimeAuthority: store,
      }),
      runId,
    );
    assert.notEqual(
      port.deriveBootstrapRunId({
        sourceSessionId: source.id,
        targetSessionId: "fork-port-target",
        operationId: "fork-port-operation",
        operationCreatedAt: "2026-01-01T00:00:00.000Z",
        seedEntries,
        statePublication,
        workDir: join(root, "another-workspace"),
        runtimeAuthority: store,
      }),
      runId,
    );

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
      seedEntries,
      workDir,
      runtimeAuthority: store,
      publication,
      statePublication,
    };
    await port.bootstrapFork(bootstrap);
    const targetEvents = await store.readSession("fork-port-target");
    const stateIndex = targetEvents.findIndex((event) => event.kind === "session.state.committed");
    const markerIndex = targetEvents.findIndex((event) => event.kind === "session.forked");
    assert.ok(stateIndex >= 0 && markerIndex > stateIndex);
    assert.equal(targetEvents[markerIndex]?.runId, runId);
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
    await port.bootstrapFork({ ...bootstrap, workDir: `${workDir}/.` });

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
      (error: unknown) => error instanceof SessionForkRuntimeConflictError,
    );
    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        operationCreatedAt: "2027-01-01T00:00:00.000Z",
      }),
      (error: unknown) => error instanceof SessionForkRuntimeConflictError,
    );
    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        workDir: join(root, "another-workspace"),
      }),
      (error: unknown) => error instanceof SessionForkRuntimeConflictError,
    );
    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        sourceThroughEventId: "wrong-source-boundary",
      }),
      /does not match its canonical seed/u,
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
    await rmRetry(root);
  }
});

test("completed fork rejects a state fact appended after its publication marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-marker-order-"));
  const workDir = join(root, "workspace");
  const targetSessionId = "fork-marker-order-target";
  const canonicalStore = new SqliteRuntimeEventStore({
    storageRoot: join(root, "canonical-runtime"),
  });
  const reorderedStore = new SqliteRuntimeEventStore({
    storageRoot: join(root, "reordered-runtime"),
  });
  const statePublication = {
    eventId: "fork:marker-order:state",
    at: "2026-01-01T00:00:00.000Z",
    patch: {
      settings: {
        provider: "openai" as const,
        model: "test",
        modelRouteId: "test/test",
        mode: "default" as const,
        thinkingEffort: "off",
        thinkingEffortExplicit: false,
        additionalDirectories: [],
      },
    },
  };
  const bootstrap = {
    sourceSessionId: "fork-marker-order-source",
    targetSessionId,
    operationId: "fork-marker-order-operation",
    operationCreatedAt: "2026-01-01T00:00:00.000Z",
    seedEntries: [],
    statePublication,
    workDir,
    store: canonicalStore,
    writeGuard: { async assertRuntimeEventWriteAllowed() {} },
  };
  try {
    await RuntimeRun.bootstrapFork(bootstrap);
    const canonical = await canonicalStore.readSession(targetSessionId);
    const eventByKind = new Map(canonical.map((event) => [event.kind, event]));
    await reorderedStore.initializeSession({
      sessionId: targetSessionId,
      workDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    for (const kind of [
      "run.started",
      "session.forked",
      "session.state.committed",
      "run.terminal",
    ] as const) {
      const event = eventByKind.get(kind);
      assert.ok(event, `missing canonical ${kind}`);
      await reorderedStore.append(event);
    }

    await assert.rejects(
      RuntimeRun.bootstrapFork({ ...bootstrap, store: reorderedStore }),
      (error: unknown) => error instanceof SessionForkRuntimeConflictError,
    );
  } finally {
    canonicalStore.close();
    reorderedStore.close();
    await rmRetry(root);
  }
});

test("completed fork cannot add state after its publication marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-state-barrier-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-state-barrier-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const port = createSessionForkRuntimePort();
    const snapshot = await source.readDurableForkSnapshot();
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId: "fork-state-barrier-target",
      operationId: "fork-state-barrier-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      seedEntries: snapshot.runtimeSeedEntries,
      workDir,
      runtimeAuthority: store,
      publication: { async assertOwned() {} },
    };

    await port.bootstrapFork(bootstrap);
    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        statePublication: {
          eventId: "fork:state-barrier:state",
          at: "2026-01-01T00:00:00.000Z",
          patch: {
            settings: {
              provider: "openai",
              model: "test",
              modelRouteId: "test/test",
              mode: "default",
              thinkingEffort: "off",
              thinkingEffortExplicit: false,
              additionalDirectories: [],
            },
          },
        },
      }),
      (error: unknown) => error instanceof SessionForkRuntimeConflictError,
    );
    assert.equal(
      (await store.readSession(bootstrap.targetSessionId)).some(
        (event) => event.kind === "session.state.committed",
      ),
      false,
    );
  } finally {
    await source.close();
    await rmRetry(root);
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
    runtimePort: createEngineRuntimePort(),
  });
  const foreignStore = new SqliteRuntimeEventStore({
    storageRoot: join(root, "foreign-runtime"),
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
    await rmRetry(root);
  }
});

test("SessionForkService explicitly rejects legacy v1/v2/v3/v4/v5 fork bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-legacy-bundle-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const journal = new StorageOperationJournal({ workDir, picoHome });
  const service = new SessionForkService({
    workDir,
    picoHome,
    journal,
    runtimePort: createSessionForkRuntimePort(),
  });
  try {
    for (const version of [1, 2, 3, 4, 5] as const) {
      const operationId = `legacy-fork-v${version}`;
      const stagingDirectory = join(root, "staging", operationId);
      const sourceCursor = {
        logId: "legacy-source",
        seq: version,
        epoch: 0,
        eventId: `source-event-v${version}`,
      };
      await mkdir(stagingDirectory, { recursive: true });
      await writeFile(
        join(stagingDirectory, "runtime-fork.json"),
        `${JSON.stringify({
          schemaVersion: version,
          operationId,
          sourceSessionId: "legacy-source",
          targetSessionId: `legacy-target-v${version}`,
          sourceCursor,
          ...(version <= 2 ? { messages: [] } : { historyEntries: [] }),
        })}\n`,
      );
      await journal.create({
        kind: "fork",
        operationId,
        sessionId: "legacy-source",
        sourceSessionId: "legacy-source",
        sourceCursor,
        targetSessionId: `legacy-target-v${version}`,
        targetMode: "default",
        stagingDirectory,
      });
    }

    await service.reconcileUnfinished();
    for (const version of [1, 2, 3, 4] as const) {
      const operation = await journal.get(`legacy-fork-v${version}`);
      assert.equal(operation?.state, "needs_attention");
      assert.match(
        operation?.error?.message ?? "",
        new RegExp(`v${version} is no longer supported`, "u"),
      );
    }
  } finally {
    service.close();
    await rmRetry(root);
  }
});

test("fork bootstrap reports a conflicting terminal as a typed durable conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-terminal-conflict-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-terminal-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const port = createSessionForkRuntimePort();
    const snapshot = await source.readDurableForkSnapshot();
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId: "fork-terminal-target",
      operationId: "fork-terminal-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      seedEntries: snapshot.runtimeSeedEntries,
      workDir,
      runtimeAuthority: store,
      publication: { async assertOwned() {} },
    };
    await port.bootstrapFork(bootstrap);
    const terminal = (await store.readSession(bootstrap.targetSessionId)).find(
      (event) => event.kind === "run.terminal",
    );
    assert.ok(terminal?.kind === "run.terminal");
    // SQLite 纪元:等价于旧 fixture 的"改写 session.jsonl 删掉 terminal 行"——
    // 直接删 runtime_events 行并把 sessions 水位修回一致,再追加冲突 terminal。
    const database = new DatabaseSync(operationalDatabasePath(store.storageRoot));
    try {
      const deleteTerminal = database.prepare(
        "DELETE FROM runtime_events WHERE session_id = ? AND event_id = ?",
      );
      deleteTerminal.run(bootstrap.targetSessionId, terminal.eventId);
      database
        .prepare(
          `UPDATE sessions
           SET last_event_seq = (SELECT COALESCE(MAX(event_seq), 0) FROM runtime_events WHERE session_id = ?1),
               event_count = (SELECT COUNT(*) FROM runtime_events WHERE session_id = ?1),
               storage_bytes = (SELECT COALESCE(SUM(length(payload_json)), 0) FROM runtime_events WHERE session_id = ?1),
               last_event_at = (SELECT MAX(at) FROM runtime_events WHERE session_id = ?1)
           WHERE session_id = ?1`,
        )
        .run(bootstrap.targetSessionId);
    } finally {
      database.close();
    }
    await store.rebuildSessionCatalogRow(bootstrap.targetSessionId);
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
    await rmRetry(root);
  }
});
