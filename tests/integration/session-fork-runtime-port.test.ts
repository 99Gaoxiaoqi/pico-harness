import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionForkRuntimeConflictError } from "../../src/engine/session-fork-runtime-port.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";

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

test("SessionForkService v3 preserves structured ToolResult and source evidence ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-tool-result-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const manager = new SessionManager();
  const source = await manager.getOrCreate("fork-tool-result-source", workDir, {
    persistence: true,
    picoHome,
  });
  try {
    await source.recover();
    const run = await RuntimeRun.start({ capability: source.runtimeEventCapability! });
    const raw = "full output kept in evidence";
    const evidence = {
      schemaVersion: 1 as const,
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
    });
    await service.fork({
      sourceSessionId: source.id,
      targetSessionId: "fork-tool-result-target",
      targetMode: "default",
    });

    const targetEvents = await source.runtimeEventStore!.readSession("fork-tool-result-target");
    const copied = targetEvents.find(
      (event) =>
        event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:fork-evidence",
    );
    assert.ok(copied?.kind === "tool.result.recorded");
    assert.deepEqual(copied.refs.evidence, evidence);
    assert.equal(copied.data.body.storage, "evidence");
    assert.equal("content" in copied.data.body, false);

    const targetMessages = createSessionForkRuntimePort().projectModelMessages(targetEvents);
    assert.match(
      targetMessages.at(-1)?.message.content ?? "",
      new RegExp(`pico://evidence/${source.id}/${evidence.contentHash}`, "u"),
    );
  } finally {
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
