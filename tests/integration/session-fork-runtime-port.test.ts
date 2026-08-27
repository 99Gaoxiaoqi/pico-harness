import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { globalSessionManager, Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionForkRuntimeConflictError } from "../../src/engine/session-fork-runtime-port.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";
import {
  getOrCreateSessionSettings,
  setSessionCollaborationMode,
  setSessionPermissionMode,
} from "../../src/input/session-settings.js";

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

test("session fork runtime port composes the coordinator for Session callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-port-compose-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sourceSessionId = "fork-port-compose-source";
  const targetSessionId = "fork-port-compose-target";
  const source = await globalSessionManager.getOrCreate(sourceSessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await source.commitMessages({ role: "user", content: "seed through composed port" });
    await createSessionForkRuntimePort().forkSession({
      workDir,
      picoHome,
      fileHistoryBaseDir: source.fileHistoryBaseDir,
      sourceSessionId,
      targetSessionId,
      targetMode: "default",
    });

    const targetEvents = await source.runtimeEventStore!.readSession(targetSessionId);
    assert.ok(
      targetEvents.some(
        (event) =>
          event.kind === "message.committed" &&
          event.data.message.content.includes("composed port"),
      ),
    );
  } finally {
    await globalSessionManager.delete(sourceSessionId, workDir, { picoHome })?.close();
    await globalSessionManager.delete(targetSessionId, workDir, { picoHome })?.close();
    await rmRetry(root);
  }
});

test("fork inherits both interaction axes and survives target Resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-permissions-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const manager = new SessionManager();
  const cases = [
    ["agent", "default"],
    ["agent", "auto"],
    ["agent", "yolo"],
    ["plan", "default"],
    ["plan", "auto"],
    ["plan", "yolo"],
  ] as const;

  try {
    for (const [index, [collaborationMode, permissionMode]] of cases.entries()) {
      const sourceSessionId = `fork-permission-source-${index}`;
      const targetSessionId = `fork-permission-target-${index}`;
      const source = await manager.getOrCreate(sourceSessionId, workDir, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      const settings = getOrCreateSessionSettings(
        {
          sessionId: sourceSessionId,
          cwd: workDir,
          picoHome,
          provider: "openai",
          model: "test",
          modelRouteId: "openai/test",
          mode: permissionMode,
        },
        { persistence: source },
      );
      assert.equal(setSessionCollaborationMode(settings, collaborationMode).ok, true);
      assert.equal(setSessionPermissionMode(settings, permissionMode).ok, true);
      await source.commitMessages({ role: "user", content: `seed ${index}` });
      await source.flushPersistence();

      const journal = new StorageOperationJournal({ workDir, picoHome });
      const operationId = `fork-permission-op-${index}`;
      const service = new SessionForkService({
        workDir,
        picoHome,
        sessionManager: manager,
        runtimeStore: source.runtimeEventStore!,
        journal,
        runtimePort: createSessionForkRuntimePort(),
        createOperationId: () => operationId,
      });
      try {
        await service.fork({
          sourceSessionId,
          targetSessionId,
          // Compatibility input cannot override the source's canonical axes.
          targetMode: permissionMode === "yolo" ? "default" : "yolo",
        });
      } finally {
        service.close();
      }

      const operation = await journal.get(operationId);
      assert.equal(operation?.kind, "fork");
      if (operation?.kind === "fork") {
        assert.equal(operation.targetCollaborationMode, collaborationMode);
        assert.equal(operation.targetPermissionMode, permissionMode);
        assert.equal(operation.targetMode, undefined);
      }

      const resumed = new Session(targetSessionId, workDir, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        await resumed.recover();
        const inherited = resumed.getRuntimeStateSnapshot().settings;
        assert.equal(inherited?.collaborationMode, collaborationMode);
        assert.equal(inherited?.permissionMode, permissionMode);
        assert.deepEqual(inherited?.additionalDirectories, []);
      } finally {
        await resumed.close();
      }
    }
  } finally {
    for (const index of cases.keys()) {
      await manager.delete(`fork-permission-source-${index}`, workDir, { picoHome })?.close();
    }
    await rmRetry(root);
  }
});

test("legacy settings-less fork journal recovery materializes agent/default before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-legacy-permission-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sourceSessionId = "fork-legacy-permission-source";
  const targetSessionId = "fork-legacy-permission-target";
  const operationId = "fork-legacy-permission-op";
  const manager = new SessionManager();
  const source = await manager.getOrCreate(sourceSessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const journal = new StorageOperationJournal({ workDir, picoHome });
  let injectFailure = true;
  const service = new SessionForkService({
    workDir,
    picoHome,
    sessionManager: manager,
    runtimeStore: source.runtimeEventStore!,
    journal,
    runtimePort: createSessionForkRuntimePort(),
    createOperationId: () => operationId,
    hooks: {
      beforeRuntimeBootstrap: () => {
        if (injectFailure) throw new Error("injected crash before publication");
      },
    },
  });
  try {
    getOrCreateSessionSettings(
      {
        sessionId: sourceSessionId,
        cwd: workDir,
        picoHome,
        provider: "openai",
        model: "test",
        modelRouteId: "openai/test",
        mode: "default",
      },
      { persistence: source },
    );
    await source.commitMessages({ role: "user", content: "legacy recovery seed" });
    await source.flushPersistence();
    await assert.rejects(
      service.fork({ sourceSessionId, targetSessionId }),
      /injected crash before publication/u,
    );

    const failedBeforeRewrite = await journal.get(operationId);
    assert.ok(failedBeforeRewrite?.kind === "fork");
    const frozenPath = join(failedBeforeRewrite.stagingDirectory, "runtime-fork.json");
    const frozen = JSON.parse(await readFile(frozenPath, "utf8")) as Record<string, unknown>;
    delete frozen["settings"];
    const frozenContents = `${JSON.stringify(frozen)}\n`;
    await writeFile(frozenPath, frozenContents);
    const manifestPath = join(failedBeforeRewrite.stagingDirectory, "fork-bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["contentSha256"] = createHash("sha256").update(frozenContents).digest("hex");
    manifest["sizeBytes"] = Buffer.byteLength(frozenContents);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    // Mutable source/user state may now be YOLO; the missing historical fact has
    // no authority to inherit it.
    const mutableSettings = getOrCreateSessionSettings(
      {
        sessionId: sourceSessionId,
        cwd: workDir,
        picoHome,
        provider: "openai",
        model: "test",
        modelRouteId: "openai/test",
        mode: "yolo",
      },
      { persistence: source, restore: false },
    );
    setSessionCollaborationMode(mutableSettings, "plan");
    setSessionPermissionMode(mutableSettings, "yolo");
    await source.flushPersistence();

    const database = new DatabaseSync(
      operationalDatabasePath(source.runtimeEventStore!.storageRoot),
    );
    try {
      const row = database
        .prepare("SELECT operation_json FROM storage_operations WHERE operation_id = ?")
        .get(operationId) as { operation_json: string };
      const legacy = JSON.parse(row.operation_json) as Record<string, unknown>;
      delete legacy["targetCollaborationMode"];
      delete legacy["targetPermissionMode"];
      legacy["targetMode"] = "yolo";
      legacy["bundleManifest"] = {
        manifestPath,
        stagedBundlePath: frozenPath,
        contentSha256: manifest["contentSha256"],
        sizeBytes: manifest["sizeBytes"],
      };
      database
        .prepare("UPDATE storage_operations SET operation_json = ? WHERE operation_id = ?")
        .run(JSON.stringify(legacy), operationId);
    } finally {
      database.close();
    }

    const failed = await journal.get(operationId);
    assert.equal(failed?.state, "sidecars_committed");
    injectFailure = false;
    await service.reconcileUnfinished();

    const resumed = new Session(targetSessionId, workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      await resumed.recover();
      assert.equal(resumed.getRuntimeStateSnapshot().settings?.collaborationMode, "agent");
      assert.equal(resumed.getRuntimeStateSnapshot().settings?.permissionMode, "default");
      assert.deepEqual(resumed.getRuntimeStateSnapshot().settings?.additionalDirectories, []);
    } finally {
      await resumed.close();
    }
  } finally {
    service.close();
    await manager.delete(sourceSessionId, workDir, { picoHome })?.close();
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
      const stagedBundlePath = join(stagingDirectory, "runtime-fork.json");
      const frozenContents = `${JSON.stringify({
        schemaVersion: version,
        operationId,
        sourceSessionId: "legacy-source",
        targetSessionId: `legacy-target-v${version}`,
        sourceCursor,
        ...(version <= 2 ? { messages: [] } : { historyEntries: [] }),
      })}\n`;
      const contentSha256 = createHash("sha256").update(frozenContents).digest("hex");
      await writeFile(stagedBundlePath, frozenContents);
      const manifestPath = join(stagingDirectory, "fork-bundle.json");
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schemaVersion: 2,
          operationId,
          sourceCursor,
          targetSessionId: `legacy-target-v${version}`,
          stagingDirectory,
          stagedBundlePath,
          contentSha256,
          sizeBytes: Buffer.byteLength(frozenContents),
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
        bundleManifest: {
          manifestPath,
          stagedBundlePath,
          contentSha256,
          sizeBytes: Buffer.byteLength(frozenContents),
        },
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
      database
        .prepare(
          `UPDATE runtime_run_projection
           SET terminal_event_id = NULL, terminal_sequence = NULL, terminal_status = NULL,
               last_event_sequence = last_event_sequence - 1
           WHERE session_id = ? AND run_id = ?`,
        )
        .run(bootstrap.targetSessionId, terminal.runId);
    } finally {
      database.close();
    }
    await store.rebuildSessionCatalogRow(bootstrap.targetSessionId);
    await store.append(
      {
        ...terminal,
        eventId: `${terminal.eventId}:conflict`,
        data: { status: "failed", reason: "injected conflict" },
      },
      { ownerFence: await store.readOwnerFence(bootstrap.targetSessionId) },
    );

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
