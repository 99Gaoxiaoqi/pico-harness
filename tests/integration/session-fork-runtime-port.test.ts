import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionForkRuntimeConflictError } from "../../src/engine/session-fork-runtime-port.js";
import { projectRuntimeSessionMessageEntries } from "../../src/engine/session-runtime-projection.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";
import { hydrateTuiEntries } from "../../src/tui/session-hydration.js";

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
    await rm(root, { recursive: true, force: true });
  }
});

test("completed fork rejects a state fact appended after its publication marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-marker-order-"));
  const workDir = join(root, "workspace");
  const targetSessionId = "fork-marker-order-target";
  const canonicalStore = new RuntimeEventStore({
    storageRoot: join(root, "canonical-runtime"),
  });
  const reorderedStore = new RuntimeEventStore({
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("fork bootstrap retries a partially imported v5 seed without duplicate facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-seed-retry-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-seed-retry-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "model seed" });
    await source.recordTranscriptEvent({
      eventId: "transcript:fork-seed-retry",
      sequence: 1,
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      type: "entry.appended",
      entryId: "entry:fork-seed-retry",
      entry: { kind: "user", content: "transcript seed" },
    });
    const store = source.runtimeEventStore!;
    const targetSessionId = "fork-seed-retry-target";
    const port = createSessionForkRuntimePort();
    const snapshot = await source.readDurableForkSnapshot();
    let injectFailure = true;
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId,
      operationId: "fork-seed-retry-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      seedEntries: snapshot.runtimeSeedEntries,
      workDir,
      runtimeAuthority: store,
      publication: {
        async assertOwned() {
          if (
            injectFailure &&
            (await store.readSession(targetSessionId)).some(
              (event) => event.kind === "transcript.event.recorded",
            )
          ) {
            injectFailure = false;
            throw new Error("injected publication loss");
          }
        },
      },
    };

    await assert.rejects(port.bootstrapFork(bootstrap), /injected publication loss/u);
    const partial = await store.readSession(targetSessionId);
    assert.equal(partial.filter((event) => event.kind === "transcript.event.recorded").length, 1);
    assert.equal(
      partial.some((event) => event.kind === "session.forked"),
      false,
    );

    await port.bootstrapFork(bootstrap);
    const completed = await store.readSession(targetSessionId);
    assert.equal(completed.filter((event) => event.kind === "message.committed").length, 1);
    assert.equal(completed.filter((event) => event.kind === "transcript.event.recorded").length, 1);
    assert.equal(
      completed.some((event) => event.kind === "session.forked"),
      true,
    );
    await port.bootstrapFork(bootstrap);
    assert.equal((await store.readSession(targetSessionId)).length, completed.length);
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
    runtimePort: createEngineRuntimePort(),
  });
  const foreignStore = new RuntimeEventStore({
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
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionForkService explicitly rejects legacy v1/v2/v3/v4 fork bundles", async () => {
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
    for (const version of [1, 2, 3, 4] as const) {
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
    await rm(root, { recursive: true, force: true });
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
    const sessionDigest = createHash("sha256").update(bootstrap.targetSessionId).digest("hex");
    const ledgerPath = join(store.storageRoot, "sessions", sessionDigest, "session.jsonl");
    const records = (await readFile(ledgerPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const rewritten = records.flatMap((record) => {
      if (record["type"] !== "event-batch") return [record];
      const entries = (record["entries"] as Array<Record<string, unknown>>).filter(
        (entry) => (entry["event"] as Record<string, unknown>)["eventId"] !== terminal.eventId,
      );
      return entries.length > 0 ? [{ ...record, entries }] : [];
    });
    await writeFile(
      ledgerPath,
      `${rewritten.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
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

test("SessionForkService v5 preserves transcript, structured ToolResult, and evidence ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-tool-result-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const manager = new SessionManager();
  const source = await manager.getOrCreate("fork-tool-result-source", workDir, {
    persistence: true,
    picoHome,
  });
  let frozenBundle: Record<string, unknown> | undefined;
  let target: Session | undefined;
  try {
    await source.recover();
    await source.recordTranscriptEvent({
      eventId: "transcript:fork-evidence:start",
      sequence: 1,
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      type: "tool.started",
      entryId: "entry:fork-evidence",
      toolCallId: "ui-tool:fork-evidence",
      providerCallId: "call:fork-evidence",
      name: "bash",
      args: "{}",
    });
    const run = await RuntimeRun.start({ capability: source.runtimeEventCapability! });
    const raw = "full output kept in evidence";
    const evidence = {
      schemaVersion: 2 as const,
      contentHash: createHash("sha256").update("manifest").digest("hex"),
      sessionId: source.id,
      kind: "tool-exchange" as const,
    };
    const result = run.registerToolResult({
      toolCallId: "call:fork-evidence",
      toolName: "bash",
      status: "succeeded",
      body: {
        storage: "evidence",
        sha256: createHash("sha256").update(raw).digest("hex"),
        sizeBytes: Buffer.byteLength(raw),
      },
      projection: {
        version: 1,
        mode: "preview",
        text: "bounded fork preview",
        strategy: "head-tail",
        truncated: true,
      },
      evidence,
    });
    await run.commitMessages(source, [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:fork-evidence", name: "bash", arguments: "{}" }],
      },
      result,
    ]);
    await run.finish("completed");

    const service = new SessionForkService({
      workDir,
      picoHome,
      sessionManager: manager,
      runtimeStore: source.runtimeEventStore!,
      runtimePort: createSessionForkRuntimePort(),
      hooks: {
        async afterSidecars(operation) {
          frozenBundle = JSON.parse(
            await readFile(join(operation.stagingDirectory, "runtime-fork.json"), "utf8"),
          ) as Record<string, unknown>;
        },
      },
    });
    await service.fork({
      sourceSessionId: source.id,
      targetSessionId: "fork-tool-result-target",
      targetMode: "default",
    });

    assert.equal(frozenBundle?.["schemaVersion"], 5);
    assert.equal(Object.hasOwn(frozenBundle ?? {}, "messages"), false);
    assert.equal(Object.hasOwn(frozenBundle ?? {}, "historyEntries"), false);
    const frozenSeed = frozenBundle?.["seedEntries"];
    assert.ok(Array.isArray(frozenSeed));
    assert.equal(
      frozenSeed.some((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const seed = entry as Record<string, unknown>;
        const event = seed["event"];
        return (
          seed["kind"] === "model" &&
          typeof event === "object" &&
          event !== null &&
          (event as Record<string, unknown>)["kind"] === "tool.result.recorded"
        );
      }),
      true,
    );
    assert.equal(
      frozenSeed.some((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const seed = entry as Record<string, unknown>;
        const event = seed["event"];
        return (
          seed["kind"] === "transcript" &&
          typeof event === "object" &&
          event !== null &&
          (event as Record<string, unknown>)["type"] === "tool.started"
        );
      }),
      true,
    );

    const targetEvents = await source.runtimeEventStore!.readSession("fork-tool-result-target");
    const copied = targetEvents.find(
      (event) =>
        event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:fork-evidence",
    );
    assert.ok(copied?.kind === "tool.result.recorded");
    assert.deepEqual(copied.refs.evidence, evidence);
    assert.equal(copied.data.body.storage, "evidence");
    assert.equal("content" in copied.data.body, false);

    const targetMessages = projectRuntimeSessionMessageEntries(targetEvents);
    assert.match(
      targetMessages.at(-1)?.message.content ?? "",
      new RegExp(`pico://evidence/${source.id}/${evidence.contentHash}`, "u"),
    );

    target = await manager.getOrCreate("fork-tool-result-target", workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    await target.recover();
    const hydration = await target.readHydrationSnapshot();
    assert.equal(hydration.transcriptEvents.length, 1);
    assert.equal(hydration.toolResults.length, 1);
    const hydratedTool = hydrateTuiEntries(hydration).find((entry) => entry.kind === "tool");
    assert.equal(hydratedTool?.kind, "tool");
    assert.equal(hydratedTool?.status, "success");
    assert.equal(hydratedTool?.uiToolCallId, "ui-tool:fork-evidence");
  } finally {
    await target?.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("completed fork bootstrap reconciles a ToolResult rewound after its active call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-rewind-result-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const manager = new SessionManager();
  const source = await manager.getOrCreate("fork-rewind-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  let target: Session | undefined;
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "kept seed" });
    const sourceRun = await RuntimeRun.start({ capability: source.runtimeEventCapability! });
    const rawResult = "completed source result";
    const result = sourceRun.registerToolResult({
      toolCallId: "call:fork-rewind",
      toolName: "read_file",
      status: "succeeded",
      body: {
        storage: "inline",
        content: rawResult,
        sha256: createHash("sha256").update(rawResult).digest("hex"),
        sizeBytes: Buffer.byteLength(rawResult),
      },
      projection: {
        version: 1,
        mode: "full",
        text: rawResult,
        strategy: "full",
        truncated: false,
      },
    });
    await sourceRun.commitMessages(source, [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:fork-rewind", name: "read_file", arguments: "{}" }],
      },
      result,
    ]);
    await sourceRun.finish("completed");

    const service = new SessionForkService({
      workDir,
      picoHome,
      sessionManager: manager,
      runtimeStore: source.runtimeEventStore!,
      runtimePort: createSessionForkRuntimePort(),
    });
    await service.fork({
      sourceSessionId: source.id,
      targetSessionId: "fork-rewind-target",
      targetMode: "default",
    });

    target = await manager.getOrCreate("fork-rewind-target", workDir, {
      persistence: true,
      picoHome,
    });
    await target.recover();
    assert.deepEqual(
      target.getHistory().map((message) => [message.role, message.toolCallId]),
      [
        ["user", undefined],
        ["assistant", undefined],
        ["user", "call:fork-rewind"],
      ],
    );
    await target.rewindOnce("remove-forked-result", 2);

    const bootstrapRunId = (await target.runtimeEventStore!.listRunIds(target.id)).find((runId) =>
      runId.startsWith("fork-bootstrap:"),
    );
    assert.ok(bootstrapRunId);
    const reconciled = await RuntimeRun.reconcileIncompleteRuns({
      capability: target.runtimeEventCapability!,
    });
    assert.deepEqual(reconciled, [bootstrapRunId]);

    const probe = await RuntimeRun.start({ capability: target.runtimeEventCapability! });
    const recoveredHistory = await probe.readModelHistory();
    await probe.finish("completed");
    assert.deepEqual(
      recoveredHistory.map((message) => [message.role, message.toolCallId]),
      [
        ["user", undefined],
        ["assistant", undefined],
        ["user", "call:fork-rewind"],
      ],
    );
    assert.match(recoveredHistory.at(-1)?.content ?? "", /中断/u);

    const synthetic = (await target.runtimeEventStore!.readSession(target.id)).findLast(
      (event) =>
        event.kind === "tool.result.recorded" &&
        event.refs.toolCallId === "call:fork-rewind" &&
        event.data.status === "interrupted",
    );
    assert.ok(synthetic?.kind === "tool.result.recorded");
    assert.equal(synthetic.data.projection.mode, "synthetic");
    assert.equal(synthetic.data.projection.strategy, "runtime-interruption-recovery");
    assert.equal(synthetic.refs.parentRunId, bootstrapRunId);

    assert.deepEqual(
      await RuntimeRun.reconcileIncompleteRuns({
        capability: target.runtimeEventCapability!,
      }),
      [],
    );
  } finally {
    await target?.close();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
