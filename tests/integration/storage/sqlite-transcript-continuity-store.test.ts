import { agentOutputFingerprint } from "@pico/pico-host/agent-output-tool";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import {
  RuntimeEventStoreRunSealedError,
  RUNTIME_TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeTranscriptChangeCursor,
  type RuntimeTranscriptProjectionCursor,
} from "@pico/storage/runtime-event-store-contracts";
import { operationalDatabasePath } from "@pico/storage";
import {
  RuntimeTranscriptResetRequiredError,
  SqliteRuntimeEventStore,
} from "@pico/pico-host/product-runtime-event-store";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

function toolIdentity(payload: unknown) {
  assert.ok(typeof payload === "object" && payload !== null);
  assert.ok("kind" in payload && payload.kind === "tool");
  assert.ok("name" in payload && typeof payload.name === "string");
  assert.ok("runId" in payload && typeof payload.runId === "string");
  assert.ok("turnId" in payload && typeof payload.turnId === "string");
  return payload;
}

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
    data: { workDir, agentSwarmAuthorization: "none" },
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
  turnId = "turn-1",
): RuntimeEvent {
  const content = "tool result";
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    ...eventBase(eventId, sessionId, runId, turnId),
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const first = await store.append(message("user-event", sessionId, "user", "hello"), {
      ownerFence,
    });
    assert.equal(first.transcriptWatermark?.throughSequence, 1);
    const firstWatermark = first.transcriptWatermark!;

    const second = await store.append(
      message("assistant-event", sessionId, "assistant", "world", "run-a", "turn-a"),
      { ownerFence },
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const before = await store.append(message("older-event", sessionId, "user", "older"), {
      ownerFence,
    });
    const content = "你🙂好🌍".repeat(180);
    const appended = await store.append(
      message("large-event", sessionId, "assistant", content, "run-large", "turn-large"),
      { ownerFence },
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    await store.append(message("first", sessionId, "user", "first"), { ownerFence });
    await store.append(message("second", sessionId, "user", "second"), { ownerFence });
    const old = await store.append(message("third", sessionId, "user", "third"), {
      ownerFence,
    });
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
      { eventId: "runtime-truncate", ownerFence },
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
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
      { eventId: "runtime-tool-started", ownerFence },
    );
    const settled = await store.append(toolResult("runtime-tool-result", sessionId, "provider-1"), {
      ownerFence,
    });
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
        runId: "run-1",
        turnId: "turn-1",
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

test("canonical tool projection preserves run identity for nested results and rebuilds cached history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-tool-turn-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const storageRoot = join(root, "storage");
  let store = new SqliteRuntimeEventStore({ storageRoot });
  try {
    const sessionId = "tool-turn-session";
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const started = await store.append(
      transcriptToolStarted(
        "runtime-tool-turn-started",
        sessionId,
        "run-tool-turn",
        "turn-tool-turn",
        "call-tool-turn",
        "provider-tool-turn",
        "read",
        1,
      ),
      { ownerFence },
    );
    const startPage = await store.readTranscriptProjectionPage({
      sessionId,
      through: started.transcriptWatermark!,
      maxBytes: 16_384,
    });
    const startTool = toolIdentity(startPage.items[0]?.payload);
    assert.equal(startTool.runId, "run-tool-turn");
    assert.equal(startTool.turnId, "turn-tool-turn");

    const settled = await store.append(
      toolResult(
        "runtime-tool-turn-result",
        sessionId,
        "provider-tool-turn",
        "read",
        "run-tool-turn",
        "turn-tool-turn",
      ),
      { ownerFence },
    );
    const settledPage = await store.readTranscriptProjectionPage({
      sessionId,
      through: settled.transcriptWatermark!,
      maxBytes: 16_384,
    });
    const settledTool = toolIdentity(settledPage.items[0]?.payload);
    assert.equal(settledTool.runId, "run-tool-turn");
    assert.equal(settledTool.turnId, "turn-tool-turn");
    assert.ok("status" in settledTool && typeof settledTool.status === "string");
    assert.equal(settledTool.status, "success");

    // exec's nested tools have canonical result events but no transcript tool.started row.
    for (const name of ["grep", "read_file"]) {
      const toolCallId = `code-mode:${name}`;
      await store.append(
        {
          ...toolResult(
            `nested-${name}-result`,
            sessionId,
            toolCallId,
            name,
            "run-tool-turn",
            "turn-tool-turn-2",
          ),
          refs: { toolCallId, parentToolCallId: "provider-tool-turn" },
        },
        { ownerFence },
      );
    }
    const page = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 16_384 });
    assert.deepEqual(
      page.items.map(({ payload }) => {
        const tool = toolIdentity(payload);
        return [tool.name, tool.runId, tool.turnId];
      }),
      [
        ["read", "run-tool-turn", "turn-tool-turn"],
        ["grep", "run-tool-turn", "turn-tool-turn-2"],
        ["read_file", "run-tool-turn", "turn-tool-turn-2"],
      ],
    );

    store.close();
    const database = new DatabaseSync(operationalDatabasePath(storageRoot));
    try {
      database
        .prepare(
          "UPDATE runtime_transcript_projection_state SET projector_version = 7 WHERE session_id = ?",
        )
        .run(sessionId);
      database
        .prepare(
          `UPDATE runtime_transcript_item_versions
         SET payload_json = json_remove(payload_json, '$.runId', '$.turnId')
         WHERE session_id = ? AND item_id LIKE 'tool:code-mode:%'`,
        )
        .run(sessionId);
    } finally {
      database.close();
    }
    store = new SqliteRuntimeEventStore({ storageRoot });
    const rebuilt = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 16_384 });
    assert.notEqual(rebuilt.watermark.historyEpoch, page.watermark.historyEpoch);
    assert.equal(rebuilt.watermark.projectorVersion, RUNTIME_TRANSCRIPT_PROJECTOR_VERSION);
    assert.deepEqual(rebuilt.items, page.items);
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
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
      await store.appendTranscriptEvent(
        sessionId,
        {
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
        },
        { ownerFence },
      );
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
      revision: 1,
      condition: "Ship continuity",
      status: "active" as const,
      createdAt: 1,
      maxIterations: 50,
      blockCap: 8,
      iterations: 0,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
      consecutiveNoProgress: 0,
      armedAt: 1,
    };
    const snapshot = {
      stateVersion: 3 as const,
      currentGoal: goal,
      controlLease: { goalId: goal.id, generation: 1 },
      coordinator: {
        pendingContinuation: null,
        currentExecution: null,
        workTokens: 0,
        accountedRunIds: [],
      },
    };
    const active = await store.appendSessionState(sessionId, { goal: snapshot }, { ownerFence });
    const activePage = await store.readTranscriptProjectionPage({
      sessionId,
      through: active.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.ok(
      activePage.items.every((item) => (item.payload as { kind?: string }).kind !== "goal"),
      "active Goal is displayed by the control plane",
    );
    const terminal = await store.appendTranscriptEvent(
      sessionId,
      {
        eventId: "goal-terminal:goal-1:1",
        sequence: 20,
        createdAt: 2,
        type: "entry.appended",
        entryId: "goal-terminal:goal-1:1",
        entry: {
          kind: "goal",
          title: goal.condition,
          detail: "Done",
          state: "achieved",
          data: { goalId: goal.id, goalRevision: 1 },
        },
      },
      { ownerFence },
    );
    const terminalPage = await store.readTranscriptProjectionPage({
      sessionId,
      through: terminal.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.equal(terminalPage.items.at(-1)?.itemId, "goal-terminal:goal-1:1");
    const replacement = await store.appendSessionState(
      sessionId,
      {
        goal: {
          ...snapshot,
          currentGoal: { ...goal, id: "goal-2" },
          controlLease: { goalId: "goal-2", generation: 1 },
        },
      },
      { ownerFence },
    );
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: terminal.transcriptWatermark!,
      through: replacement.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(advance.changes, [], "replacing the current Goal preserves terminal history");
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const appended = await store.append(message("old-event", sessionId, "user", "durable"), {
      ownerFence,
    });
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

test("projector v4 rebuild removes durable Graph control history but keeps same-name linear tools", async () => {
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
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

    await store.append(started("graph-start", sessionId, workspace, graphRunId), { ownerFence });
    await store.append(
      message(
        "graph-user",
        sessionId,
        "user",
        "[Graph Supervisor wake] historical internal input",
        graphRunId,
        "graph-turn",
      ),
      { ownerFence },
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
      { ownerFence },
    );
    await store.append(
      toolResult(
        "graph-tool-result",
        sessionId,
        "graph-provider-call",
        "view_agent_graph",
        graphRunId,
      ),
      { ownerFence },
    );
    await store.appendTranscriptEvent(
      sessionId,
      {
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
      },
      { ownerFence },
    );
    await store.append(
      message(
        "graph-final",
        sessionId,
        "assistant",
        "final Graph answer remains visible",
        graphRunId,
        "graph-final-turn",
      ),
      { ownerFence },
    );

    await store.append(started("linear-start", sessionId, workspace, linearRunId), { ownerFence });
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
      { ownerFence },
    );
    await store.append(
      toolResult(
        "linear-tool-result",
        sessionId,
        "linear-provider-call",
        "view_agent_graph",
        linearRunId,
      ),
      { ownerFence },
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
    assert.equal(rebuilt.watermark.projectorVersion, RUNTIME_TRANSCRIPT_PROJECTOR_VERSION);
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });

    // A legacy host can append the start before its durable Graph schedule fact.
    // The initial negative lookup must not remain cached for later run events.
    await store.append(started("legacy-start", sessionId, workspace, runId), { ownerFence });
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
      { ownerFence },
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const first = await store.append(message("first-event", sessionId, "user", "first"), {
      ownerFence,
    });
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
      { ownerFence },
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
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    const initial = await store.append(started("run-start", sessionId, workspace), { ownerFence });
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
        ownerFence,
      });
    }
    await store.appendPartialSegment({
      sessionId,
      runId: "run-1",
      partialId: "assistant-partial",
      segmentIndex: 0,
      payload: { delta: "streaming" },
      ownerFence,
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
        store.appendBatch(
          [
            finalAssistant,
            terminal("terminal-in-rollback", sessionId),
            message("sealed-tail", sessionId, "user", "must roll back"),
          ],
          { ownerFence },
        ),
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

    const assistantResult = await store.append(finalAssistant, { ownerFence });
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

    const toolStart = await store.appendTranscriptEvent(
      sessionId,
      {
        eventId: "tool-start",
        sequence: 1,
        createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
        type: "tool.started",
        entryId: "tool-entry-final",
        toolCallId: "canonical-final",
        providerCallId: "provider-final",
        name: "read",
        args: "{}",
      },
      { ownerFence },
    );
    await store.upsertPartialSnapshot({
      sessionId,
      runId: "run-1",
      partialId: "tool-partial",
      kind: "tool",
      expectedVersion: 0,
      payload: { itemId: "tool:canonical-final", status: "running" },
      ownerFence,
    });
    await store.appendPartialSegment({
      sessionId,
      runId: "run-1",
      partialId: "tool-partial",
      segmentIndex: 0,
      payload: { delta: "output" },
      ownerFence,
    });
    const toolFinal = await store.append(toolResult("tool-final", sessionId, "provider-final"), {
      ownerFence,
    });
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

test("Graph child transcript exposes tools and formal output after upgrading an empty v3 projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-graph-child-transcript-"));
  const storage = join(root, "storage");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  const graph = new SqliteAgentGraphControlStore({ storageRoot: storage });
  const sessionId = "child-session";
  try {
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspace,
    });
    graph.createGraph({ graphId: "child-graph", rootSessionId: "parent", epoch: 1 });
    graph.commitScheduleRevision({
      graphId: "child-graph",
      expectedRevision: 0,
      operationId: "add",
      requestFingerprint: "add",
      kind: "add",
      command: { kind: "add" },
      sourceSessionId: "parent",
      sourceTurnId: "parent-turn",
      sourceRunId: "parent-run",
      sourceToolCallId: "parent-tool",
    });
    graph.ensureOperatorProvision({
      provisionId: "provision",
      graphId: "child-graph",
      operatorId: "a",
      generation: 1,
      scheduleRevision: 1,
      provisionFingerprint: "provision",
      childSessionId: sessionId,
      profileSnapshot: {},
      workspaceBinding: { kind: "shared" },
    });
    graph.transitionOperatorProvision({
      provisionId: "provision",
      expectedVersion: 1,
      from: "requested",
      to: "provisioned",
    });
    graph.claimActivation({
      claimId: "claim",
      graphId: "child-graph",
      intentId: "intent",
      operatorId: "a",
      operatorGeneration: 1,
      expectedGraphRevision: 1,
      intentFingerprint: "intent",
      readinessFingerprint: "ready",
      targetSessionId: sessionId,
      targetTurnId: "turn-1",
      targetRunId: "run-1",
      targetInvocationId: "inv-1",
      runStartedEventId: "start",
    });
    await store.append(started("start", sessionId, workspace), { ownerFence });
    await store.append(message("input", sessionId, "user", "hidden operator control input"), {
      ownerFence,
    });
    await store.append(
      transcriptToolStarted(
        "read-start",
        sessionId,
        "run-1",
        "turn-1",
        "read",
        "provider-read",
        "read_file",
        1,
      ),
      { ownerFence },
    );
    await store.append(
      toolResult("read-result", sessionId, "provider-read", "read_file", "run-1"),
      { ownerFence },
    );
    const output = "子任务结果：CUA_BRANCH_A_17";
    const idempotencyKey = `agent-output:${"a".repeat(64)}`;
    const fingerprint = agentOutputFingerprint({
      status: "success",
      output,
      evidenceRefs: [],
      artifactRefs: [],
    });
    await store.append(
      {
        ...eventBase("formal-output", sessionId),
        partial: false,
        kind: "agent.output",
        visibility: "internal",
        refs: { toolCallId: "output-tool" },
        data: {
          toolCallId: "output-tool",
          idempotencyKey,
          fingerprint,
          payload: {
            schemaVersion: "pico.agent_output.v1",
            graphId: "child-graph",
            operatorId: "a",
            operatorGeneration: 1,
            activationId: "claim",
            status: "success",
            output,
            outputBytes: Buffer.byteLength(output),
            evidenceRefs: [],
            artifactRefs: [],
            idempotencyKey,
            fingerprint,
          },
        },
      },
      { ownerFence },
    );
    const before = await store.readTranscriptWatermark(sessionId);
    store.close();
    const db = new DatabaseSync(operationalDatabasePath(storage));
    db.prepare(
      "UPDATE runtime_transcript_projection_state SET projector_version = 3 WHERE session_id = ?",
    ).run(sessionId);
    db.prepare("DELETE FROM runtime_transcript_item_versions WHERE session_id = ?").run(sessionId);
    db.close();
    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const page = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 64 * 1024 });
    assert.notEqual(page.watermark.historyEpoch, before.historyEpoch);
    assert.equal(page.watermark.projectorVersion, RUNTIME_TRANSCRIPT_PROJECTOR_VERSION);
    const serialized = JSON.stringify(page.items);
    assert.match(serialized, /read_file/u);
    assert.match(serialized, /子任务结果：CUA_BRANCH_A_17/u);
    assert.doesNotMatch(serialized, /hidden operator control input/u);
  } finally {
    store.close();
    graph.close();
    rmSync(root, { recursive: true, force: true });
  }
});
