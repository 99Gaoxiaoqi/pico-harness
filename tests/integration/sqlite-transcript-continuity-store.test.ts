import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import {
  RuntimeEventStoreRunSealedError,
  type RuntimeTranscriptChangeCursor,
  type RuntimeTranscriptProjectionCursor,
} from "../../src/storage/runtime-event-store-contracts.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import {
  RuntimeTranscriptResetRequiredError,
  SqliteRuntimeEventStore,
} from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

function eventBase(eventId: string, sessionId: string, runId = "run-1", turnId = "turn-1") {
  return {
    schemaVersion: 2 as const,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId,
    turnId,
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "model" as const,
  };
}

function message(
  eventId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  runId = "run-1",
  turnId = "turn-1",
): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId, runId, turnId),
    kind: "message.committed",
    data: { message: { role, content } },
  };
}

function started(
  eventId: string,
  sessionId: string,
  workDir: string,
  runId = "run-1",
): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId, runId),
    visibility: "internal",
    kind: "run.started",
    data: { workDir },
  };
}

function terminal(eventId: string, sessionId: string): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId),
    visibility: "internal",
    kind: "run.terminal",
    data: { status: "completed" },
  };
}

function toolResult(
  eventId: string,
  sessionId: string,
  toolCallId: string,
  toolName = "read",
  runId = "run-1",
): RuntimeEvent {
  const content = "tool result";
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    ...eventBase(eventId, sessionId, runId),
    refs: { toolCallId },
    kind: "tool.result.recorded",
    data: {
      toolName,
      status: "succeeded",
      body: { storage: "inline", content, sha256, sizeBytes: Buffer.byteLength(content) },
      projection: {
        version: 1,
        mode: "full",
        text: content,
        strategy: "inline",
        truncated: false,
      },
    },
  };
}

function transcriptToolStarted(
  eventId: string,
  sessionId: string,
  runId: string,
  turnId: string,
  toolCallId: string,
  providerCallId: string,
  name: string,
  sequence: number,
): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId, runId, turnId),
    visibility: "transcript",
    kind: "transcript.event.recorded",
    data: {
      event: {
        eventId: `${eventId}:transcript`,
        sequence,
        createdAt: sequence,
        type: "tool.started",
        entryId: `${toolCallId}:entry`,
        toolCallId,
        providerCallId,
        name,
        args: "{}",
      },
    },
  };
}

test("transcript projection keeps fixed watermarks and advances from the change suffix", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-projection-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "projection-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const first = await store.append(message("user-event", sessionId, "user", "hello"));
    assert.equal(first.transcriptWatermark?.throughSequence, 1);
    const firstWatermark = first.transcriptWatermark!;

    const second = await store.append(
      message("assistant-event", sessionId, "assistant", "world", "run-a", "turn-a"),
    );
    const secondWatermark = second.transcriptWatermark!;
    assert.equal(secondWatermark.throughSequence, 2);
    assert.equal(secondWatermark.historyEpoch, firstWatermark.historyEpoch);

    const fixed = await store.readTranscriptProjectionPage({
      sessionId,
      through: firstWatermark,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      fixed.items.map(({ itemId }) => itemId),
      ["message:user-event:user"],
    );

    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: firstWatermark,
      through: secondWatermark,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      advance.changes.map((change) =>
        change.op === "upsert" ? [change.op, change.record.itemId] : [change.op, change.itemId],
      ),
      [["upsert", "message:turn-a:assistant"]],
    );

    await assert.rejects(
      () =>
        store.readTranscriptProjectionPage({
          sessionId,
          through: { ...firstWatermark, historyEpoch: "stale-history" },
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection page and advance resume one oversized item on UTF-8 boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-fragments-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "fragment-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const before = await store.append(message("older-event", sessionId, "user", "older"));
    const content = "你🙂好🌍".repeat(180);
    const appended = await store.append(
      message("large-event", sessionId, "assistant", content, "run-large", "turn-large"),
    );

    let pageCursor: RuntimeTranscriptProjectionCursor | undefined;
    let pageJson = "";
    let pageOffset = 0;
    const ordinaryItemIds: string[] = [];
    let pageCount = 0;
    do {
      const page = await store.readTranscriptProjectionPage({
        sessionId,
        through: appended.transcriptWatermark!,
        ...(pageCursor ? { cursor: pageCursor } : {}),
        maxBytes: 256,
        limit: 2,
      });
      assert.deepEqual(page.watermark, appended.transcriptWatermark);
      for (const fragment of page.fragments ?? []) {
        assert.equal(fragment.itemId, "message:turn-large:assistant");
        assert.equal(fragment.byteOffset, pageOffset);
        assert.equal(Buffer.byteLength(fragment.json), fragment.byteLength);
        pageOffset += fragment.byteLength;
        pageJson += fragment.json;
      }
      ordinaryItemIds.push(...page.items.map(({ itemId }) => itemId));
      pageCursor = page.nextCursor;
      pageCount += 1;
      assert.ok(pageCount < 200, "projection fragment cursor must make progress");
    } while (pageCursor);
    assert.ok(pageCount > 2);
    assert.equal(pageOffset, Buffer.byteLength(pageJson));
    assert.equal(
      (JSON.parse(pageJson) as { content: string }).content,
      content,
      "projection fragments must have no overlap or gap",
    );
    assert.deepEqual(ordinaryItemIds, ["message:older-event:user"]);

    let advanceCursor: RuntimeTranscriptChangeCursor | undefined;
    let advanceJson = "";
    let advanceOffset = 0;
    let advanceCount = 0;
    do {
      const page = await store.readTranscriptAdvancePage({
        sessionId,
        after: before.transcriptWatermark!,
        through: appended.transcriptWatermark!,
        ...(advanceCursor ? { cursor: advanceCursor } : {}),
        maxBytes: 257,
        limit: 2,
      });
      assert.deepEqual(page.changes, []);
      for (const fragment of page.fragments ?? []) {
        assert.equal(fragment.byteOffset, advanceOffset);
        assert.equal(Buffer.byteLength(fragment.json), fragment.byteLength);
        advanceOffset += fragment.byteLength;
        advanceJson += fragment.json;
      }
      advanceCursor = page.nextCursor;
      advanceCount += 1;
      assert.ok(advanceCount < 200, "advance fragment cursor must make progress");
    } while (advanceCursor);
    assert.ok(advanceCount > 2);
    assert.equal(
      (JSON.parse(advanceJson) as { content: string }).content,
      content,
      "advance fragments must have no overlap or gap",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transcript truncation rotates history and invalidates old fixed watermarks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-truncate-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "truncate-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    await store.append(message("first", sessionId, "user", "first"));
    await store.append(message("second", sessionId, "user", "second"));
    const old = await store.append(message("third", sessionId, "user", "third"));
    const truncated = await store.appendTranscriptEvent(
      sessionId,
      {
        eventId: "truncate-event",
        sequence: 1,
        createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
        type: "transcript.truncated",
        entryCount: 1,
        operationId: "truncate-operation",
      },
      { eventId: "runtime-truncate" },
    );
    assert.notEqual(
      truncated.transcriptWatermark?.historyEpoch,
      old.transcriptWatermark?.historyEpoch,
    );
    await assert.rejects(
      () =>
        store.readTranscriptProjectionPage({
          sessionId,
          through: old.transcriptWatermark!,
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
    await assert.rejects(
      () =>
        store.readTranscriptAdvancePage({
          sessionId,
          after: old.transcriptWatermark!,
          through: truncated.transcriptWatermark!,
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
    const current = await store.readTranscriptProjectionPage({
      sessionId,
      through: truncated.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      current.items.map(({ itemId }) => itemId),
      ["message:first:user"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool projection updates one source-stable item revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-tool-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "tool-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const started = await store.appendTranscriptEvent(
      sessionId,
      {
        eventId: "transcript-tool-started",
        sequence: 1,
        createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
        type: "tool.started",
        entryId: "entry-tool",
        toolCallId: "call-1",
        providerCallId: "provider-1",
        name: "read",
        args: '{"path":"README.md"}',
      },
      { eventId: "runtime-tool-started" },
    );
    const settled = await store.append(toolResult("runtime-tool-result", sessionId, "provider-1"));
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: started.transcriptWatermark!,
      through: settled.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.equal(advance.changes.length, 1);
    const change = advance.changes[0]!;
    assert.equal(change.op, "upsert");
    if (change.op === "upsert") {
      assert.equal(change.record.itemId, "tool:call-1");
      assert.equal(change.record.itemRevision, 2);
      assert.deepEqual(change.record.payload, {
        args: '{"path":"README.md"}',
        at: Date.parse("2026-08-23T00:00:00.000Z"),
        data: {
          toolCallId: "call-1",
          providerCallId: "provider-1",
          entryId: "entry-tool",
        },
        id: "tool:call-1",
        kind: "tool",
        name: "read",
        result: {
          deliveryTruncated: false,
          projection: {
            mode: "full",
            strategy: "inline",
            text: "tool result",
            truncated: false,
            version: 1,
          },
          rawSizeBytes: 11,
          sha256: createHash("sha256").update("tool result").digest("hex"),
          status: "succeeded",
          toolCallId: "provider-1",
          toolName: "read",
          version: 1,
        },
        status: "success",
      });
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured interactions and goals update stable projection items in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-stable-items-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "stable-item-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const interactions = [
      { kind: "approval", stableKey: "approvalId", stableId: "approval-1", state: "waiting" },
      { kind: "approval", stableKey: "approvalId", stableId: "approval-1", state: "allow" },
      { kind: "prompt", stableKey: "promptId", stableId: "prompt-1", state: "waiting" },
      { kind: "prompt", stableKey: "promptId", stableId: "prompt-1", state: "resolved" },
      { kind: "changes", stableKey: "runId", stableId: "run-1", state: "ready" },
      { kind: "changes", stableKey: "runId", stableId: "run-1", state: "applied" },
    ] as const;
    let transcriptSequence = 0;
    for (const interaction of interactions) {
      transcriptSequence += 1;
      await store.appendTranscriptEvent(sessionId, {
        eventId: `interaction-${transcriptSequence}`,
        sequence: transcriptSequence,
        createdAt: Date.parse("2026-08-23T00:00:00.000Z") + transcriptSequence,
        type: "entry.appended",
        entryId: `entry-${transcriptSequence}`,
        entry: {
          kind: interaction.kind,
          title: `${interaction.kind} ${interaction.state}`,
          state: interaction.state,
          data: { [interaction.stableKey]: interaction.stableId },
        },
      });
    }
    const interactionPage = await store.readTranscriptProjectionPage({
      sessionId,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      interactionPage.items.map(({ itemId, itemRevision, payload }) => [
        itemId,
        itemRevision,
        (payload as { state: string }).state,
      ]),
      [
        ["approval:approval-1", 2, "allow"],
        ["prompt:prompt-1", 2, "resolved"],
        ["changes:run-1", 2, "applied"],
      ],
    );

    const goal = {
      id: "goal-1",
      title: "Ship continuity",
      description: "Finish the projection path",
      status: "active" as const,
      createdAt: 1,
      budgetUsage: { turns: 0, tokens: 0, costCNY: 0, startedAt: 1 },
    };
    const active = await store.appendSessionState(sessionId, {
      goal: { stateVersion: 1, sequence: 1, activeGoalId: goal.id, goals: [goal] },
    });
    const activePage = await store.readTranscriptProjectionPage({
      sessionId,
      through: active.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.equal(activePage.items.at(-1)?.itemId, "goal:goal-1");
    assert.deepEqual(activePage.items.at(-1)?.payload, {
      id: "goal:goal-1",
      kind: "goal",
      title: goal.title,
      detail: goal.description,
      state: "active",
      data: { goalId: goal.id },
    });

    const completed = await store.appendSessionState(sessionId, {
      goal: {
        stateVersion: 1,
        sequence: 2,
        activeGoalId: null,
        goals: [{ ...goal, status: "complete" }],
      },
    });
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: active.transcriptWatermark!,
      through: completed.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(advance.changes, [{ op: "remove", itemId: "goal:goal-1", itemRevision: 1 }]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lazy rebuild rotates history and requires bootstrap from the rebuilt head", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-rebuild-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  try {
    const sessionId = "rebuild-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const appended = await store.append(message("old-event", sessionId, "user", "durable"));
    const oldWatermark = appended.transcriptWatermark!;
    store.close();

    const database = new DatabaseSync(operationalDatabasePath(storage));
    database
      .prepare("DELETE FROM runtime_transcript_projection_state WHERE session_id = ?")
      .run(sessionId);
    database.close();

    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const rebuilt = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 16_384 });
    assert.notEqual(rebuilt.watermark.historyEpoch, oldWatermark.historyEpoch);
    assert.equal(rebuilt.watermark.throughSequence, 1);
    assert.deepEqual(
      rebuilt.items.map(({ itemId }) => itemId),
      ["message:old-event:user"],
    );
    await assert.rejects(
      () =>
        store.readTranscriptAdvancePage({
          sessionId,
          after: oldWatermark,
          through: rebuilt.watermark,
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projector v3 rebuild removes durable Graph control history but keeps same-name linear tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-graph-upgrade-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  const sessionId = "graph-upgrade-session";
  const graphRunId = "historical-graph-root-run";
  const linearRunId = "ordinary-linear-run";
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  const graphStore = new SqliteAgentGraphControlStore({ storageRoot: storage });
  try {
    await store.initializeSession({ sessionId, workDir: workspace });
    graphStore.createGraph({ graphId: "graph-upgrade", rootSessionId: sessionId, epoch: 1 });
    graphStore.commitScheduleRevision({
      graphId: "graph-upgrade",
      expectedRevision: 0,
      operationId: "graph-upgrade-operation",
      requestFingerprint: "graph-upgrade-fingerprint",
      kind: "add",
      command: { kind: "add" },
      sourceSessionId: sessionId,
      sourceTurnId: "graph-turn",
      sourceRunId: "historical-initial-root-run",
      sourceToolCallId: "graph-provider-call",
    });
    graphStore.enqueueSupervisorWake({
      wakeId: "historical-wake",
      graphId: "graph-upgrade",
      dedupeKey: "runtime-terminal:historical-operator-run",
      wakeFingerprint: "historical-wake-fingerprint",
      cause: "runtime_terminal",
      payload: { claimId: "historical-claim" },
    });
    graphStore.claimSupervisorWake({
      wakeId: "historical-wake",
      expectedWakeVersion: 1,
      attemptId: "historical-wake-attempt",
      rootSessionId: sessionId,
      targetTurnId: "graph-turn",
      targetRunId: graphRunId,
    });

    await store.append(started("graph-start", sessionId, workspace, graphRunId));
    await store.append(
      message(
        "graph-user",
        sessionId,
        "user",
        "[Graph Supervisor wake] historical internal input",
        graphRunId,
        "graph-turn",
      ),
    );
    await store.append(
      transcriptToolStarted(
        "graph-tool-start",
        sessionId,
        graphRunId,
        "graph-turn",
        "graph-tool",
        "graph-provider-call",
        "view_agent_graph",
        1,
      ),
    );
    await store.append(
      toolResult(
        "graph-tool-result",
        sessionId,
        "graph-provider-call",
        "view_agent_graph",
        graphRunId,
      ),
    );
    await store.appendTranscriptEvent(sessionId, {
      eventId: "graph-boundary-transcript",
      sequence: 2,
      createdAt: 5,
      type: "entry.appended",
      entryId: "graph-boundary",
      entry: {
        kind: "run-boundary",
        runId: graphRunId,
        status: "running",
        startedAt: 1,
      },
    });
    await store.append(
      message(
        "graph-final",
        sessionId,
        "assistant",
        "final Graph answer remains visible",
        graphRunId,
        "graph-final-turn",
      ),
    );

    await store.append(started("linear-start", sessionId, workspace, linearRunId));
    await store.append(
      transcriptToolStarted(
        "linear-tool-start",
        sessionId,
        linearRunId,
        "linear-turn",
        "linear-tool",
        "linear-provider-call",
        "view_agent_graph",
        3,
      ),
    );
    await store.append(
      toolResult(
        "linear-tool-result",
        sessionId,
        "linear-provider-call",
        "view_agent_graph",
        linearRunId,
      ),
    );
    const before = await store.readTranscriptWatermark(sessionId);
    store.close();
    graphStore.close();

    const database = new DatabaseSync(operationalDatabasePath(storage));
    const leakedPayloads = [
      {
        itemId: "message:graph-user:user",
        position: 2,
        payload: {
          id: "message:graph-user:user",
          kind: "userMessage",
          content: "[Graph Supervisor wake] historical internal input",
        },
      },
      {
        itemId: "tool:graph-tool",
        position: 3,
        payload: {
          id: "tool:graph-tool",
          kind: "tool",
          name: "view_agent_graph",
          args: "{}",
          status: "success",
        },
      },
      {
        itemId: "entry:graph-boundary",
        position: 4,
        payload: {
          id: "entry:graph-boundary",
          kind: "runBoundary",
          runId: graphRunId,
          status: "running",
          startedAt: 1,
        },
      },
    ];
    for (const leaked of leakedPayloads) {
      const payloadJson = JSON.stringify(leaked.payload);
      database
        .prepare(
          `INSERT INTO runtime_transcript_item_versions (
             session_id, item_id, item_revision, valid_from_sequence, valid_to_sequence,
             position_sequence, position_ordinal, payload_json, payload_digest
           ) VALUES (?, ?, 1, ?, NULL, ?, 0, ?, ?)`,
        )
        .run(
          sessionId,
          leaked.itemId,
          leaked.position,
          leaked.position,
          payloadJson,
          createHash("sha256").update(payloadJson).digest("hex"),
        );
    }
    database
      .prepare(
        "UPDATE runtime_transcript_projection_state SET projector_version = 2 WHERE session_id = ?",
      )
      .run(sessionId);
    assert.equal(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_transcript_item_versions WHERE session_id = ? AND valid_to_sequence IS NULL",
          )
          .get(sessionId) as { count: number }
      ).count >= leakedPayloads.length,
      true,
    );
    database.close();

    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const rebuilt = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 64 * 1024 });
    assert.equal(rebuilt.watermark.projectorVersion, 3);
    assert.notEqual(rebuilt.watermark.historyEpoch, before.historyEpoch);
    const visible = JSON.stringify(rebuilt.items.map((item) => item.payload));
    assert.doesNotMatch(visible, /Graph Supervisor wake/u);
    assert.equal(
      rebuilt.items.some(
        (item) =>
          typeof item.payload === "object" &&
          item.payload !== null &&
          "kind" in item.payload &&
          item.payload.kind === "runBoundary" &&
          "runId" in item.payload &&
          item.payload.runId === graphRunId,
      ),
      false,
    );
    assert.match(visible, /final Graph answer remains visible/u);
    assert.equal(
      rebuilt.items.filter(
        (item) =>
          typeof item.payload === "object" &&
          item.payload !== null &&
          "kind" in item.payload &&
          item.payload.kind === "tool" &&
          "name" in item.payload &&
          item.payload.name === "view_agent_graph",
      ).length,
      1,
    );
  } finally {
    store.close();
    graphStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projector rechecks a legacy run after its Graph identity becomes durable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-graph-late-identity-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  const sessionId = "graph-late-identity-session";
  const runId = "legacy-graph-run";
  const store = new SqliteRuntimeEventStore({ storageRoot: storage });
  const graphStore = new SqliteAgentGraphControlStore({ storageRoot: storage });
  try {
    await store.initializeSession({ sessionId, workDir: workspace });

    // A legacy host can append the start before its durable Graph schedule fact.
    // The initial negative lookup must not remain cached for later run events.
    await store.append(started("legacy-start", sessionId, workspace, runId));
    graphStore.createGraph({ graphId: "graph-late-identity", rootSessionId: sessionId, epoch: 1 });
    graphStore.commitScheduleRevision({
      graphId: "graph-late-identity",
      expectedRevision: 0,
      operationId: "late-identity-operation",
      requestFingerprint: "late-identity-fingerprint",
      kind: "add",
      command: { kind: "add" },
      sourceSessionId: sessionId,
      sourceTurnId: "legacy-turn",
      sourceRunId: runId,
      sourceToolCallId: "legacy-provider-call",
    });
    await store.append(
      transcriptToolStarted(
        "legacy-tool-start",
        sessionId,
        runId,
        "legacy-turn",
        "legacy-tool",
        "legacy-provider-call",
        "view_agent_graph",
        1,
      ),
    );

    const projection = await store.readTranscriptProjectionPage({
      sessionId,
      maxBytes: 16_384,
    });
    assert.equal(
      projection.items.some(
        (item) =>
          typeof item.payload === "object" &&
          item.payload !== null &&
          "kind" in item.payload &&
          item.payload.kind === "tool",
      ),
      false,
    );
  } finally {
    store.close();
    graphStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal append and advance do not decode canonical full history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-suffix-only-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  try {
    const sessionId = "suffix-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const first = await store.append(message("first-event", sessionId, "user", "first"));
    store.close();

    // Deliberately make the old canonical payload undecodable after its projection is current.
    // The suffix path must not touch it; a rebuild would fail closed on this same row.
    const database = new DatabaseSync(operationalDatabasePath(storage));
    database
      .prepare("UPDATE runtime_events SET payload_json = '{' WHERE event_id = ?")
      .run("first-event");
    database.close();

    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const second = await store.append(
      message("second-event", sessionId, "assistant", "second", "run-2", "turn-2"),
    );
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: first.transcriptWatermark!,
      through: second.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      advance.changes.map((change) =>
        change.op === "upsert" ? change.record.itemId : change.itemId,
      ),
      ["message:turn-2:assistant"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable finals atomically replace matching assistant and tool partial overlays", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-final-overlay-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "final-overlay-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const initial = await store.append(started("run-start", sessionId, workspace));
    for (const [partialId, itemId] of [
      ["assistant-partial", "message:turn:run-1:1:assistant"],
      ["thinking-partial", "message:turn:run-1:1:thinking"],
      ["unrelated-partial", "message:another-turn:assistant"],
    ] as const) {
      await store.upsertPartialSnapshot({
        sessionId,
        runId: "run-1",
        partialId,
        kind: "assistant",
        expectedVersion: 0,
        payload: { itemId, content: "streaming" },
      });
    }
    await store.appendPartialSegment({
      sessionId,
      runId: "run-1",
      partialId: "assistant-partial",
      segmentIndex: 0,
      payload: { delta: "streaming" },
    });

    const finalAssistant = message(
      "assistant-final",
      sessionId,
      "assistant",
      "done",
      "run-1",
      "turn:run-1:1",
    );
    await assert.rejects(
      () =>
        store.appendBatch([
          finalAssistant,
          terminal("terminal-in-rollback", sessionId),
          message("sealed-tail", sessionId, "user", "must roll back"),
        ]),
      RuntimeEventStoreRunSealedError,
    );
    assert.equal(await store.readSessionEvent(sessionId, "assistant-final"), undefined);
    assert.deepEqual(
      (await store.readRunPartials(sessionId, "run-1")).snapshots.map(({ partialId }) => partialId),
      ["assistant-partial", "thinking-partial", "unrelated-partial"],
    );
    assert.equal((await store.readRunPartials(sessionId, "run-1")).segments.length, 1);
    assert.deepEqual(
      (
        await store.readTranscriptAdvancePage({
          sessionId,
          after: initial.transcriptWatermark!,
          through: await store.readTranscriptWatermark(sessionId),
          maxBytes: 16_384,
        })
      ).changes,
      [],
    );

    const assistantResult = await store.append(finalAssistant);
    const afterAssistantFinal = await store.readRunPartials(sessionId, "run-1");
    assert.deepEqual(
      afterAssistantFinal.snapshots.map(({ partialId }) => partialId),
      ["unrelated-partial"],
    );
    assert.deepEqual(afterAssistantFinal.segments, []);
    const assistantAdvance = await store.readTranscriptAdvancePage({
      sessionId,
      after: initial.transcriptWatermark!,
      through: assistantResult.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      assistantAdvance.changes.map((change) =>
        change.op === "upsert" ? change.record.itemId : change.itemId,
      ),
      ["message:turn:run-1:1:assistant"],
    );

    const toolStart = await store.appendTranscriptEvent(sessionId, {
      eventId: "tool-start",
      sequence: 1,
      createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
      type: "tool.started",
      entryId: "tool-entry-final",
      toolCallId: "canonical-final",
      providerCallId: "provider-final",
      name: "read",
      args: "{}",
    });
    await store.upsertPartialSnapshot({
      sessionId,
      runId: "run-1",
      partialId: "tool-partial",
      kind: "tool",
      expectedVersion: 0,
      payload: { itemId: "tool:canonical-final", status: "running" },
    });
    await store.appendPartialSegment({
      sessionId,
      runId: "run-1",
      partialId: "tool-partial",
      segmentIndex: 0,
      payload: { delta: "output" },
    });
    const toolFinal = await store.append(toolResult("tool-final", sessionId, "provider-final"));
    assert.deepEqual(
      (await store.readRunPartials(sessionId, "run-1")).snapshots.map(({ partialId }) => partialId),
      ["unrelated-partial"],
    );
    const toolAdvance = await store.readTranscriptAdvancePage({
      sessionId,
      after: toolStart.transcriptWatermark!,
      through: toolFinal.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      toolAdvance.changes.map((change) =>
        change.op === "upsert" ? change.record.itemId : change.itemId,
      ),
      ["tool:canonical-final"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
