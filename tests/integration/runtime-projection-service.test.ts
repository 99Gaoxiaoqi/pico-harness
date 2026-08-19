import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { computeCheckpointSourceDigest } from "../../src/context/runtime-compaction-checkpoint.js";
import { RuntimeProjectionService } from "../../src/engine/runtime-projection-service.js";
import {
  materializeRuntimeHistory,
  materializeRuntimeHistoryEntries,
  materializeRuntimeHistoryProjection,
} from "../../src/engine/session-runtime-read-model.js";
import {
  projectRuntimeSessionForkSeedEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionTranscriptEventEntries,
  projectRuntimeSessionUsage,
} from "../../src/engine/session-runtime-projection.js";
import type { Message } from "../../src/schema/message.js";
import {
  createRuntimeEventId,
  type RuntimeEventStoreEntry,
} from "../../src/storage/runtime-event-store-contracts.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
  type RuntimeMessageCommittedEvent,
  type RuntimeModelCallSettledEvent,
  type RuntimeToolResultRecordedEvent,
} from "../../src/storage/runtime-event.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

const SESSION_ID = "projection-service-equivalence";
const WORK_DIR = join(tmpdir(), "projection-service-workdir");
const AT = "2026-08-10T00:00:00.000Z";
const RUN_ID = "run-1";
const TURN_ID = "turn-1";
const INVOCATION_ID = "invocation-1";

/**
 * RuntimeProjectionService 是底层投影函数的纯包装：每个方法仅做
 * `store.readSession(sessionId)` + 调对应投影函数。本测试验证 service 各方法
 * 的输出与直接调原投影函数 isDeepStrictEqual 一致，覆盖：
 * - getSessionView  vs  materializeRuntimeHistoryProjection
 * - getMessages()   vs  materializeRuntimeHistory          (checkpoint 默认)
 * - getMessages({checkpoint:false}) vs projectRuntimeSessionMessages
 * - getMessageEntries vs materializeRuntimeHistoryEntries
 * - getState        vs  projectRuntimeSessionState
 * - getUsage        vs  projectRuntimeSessionUsage
 * - getTranscriptEntries vs projectRuntimeSessionTranscriptEventEntries
 * - getSequencedMessages vs projectRuntimeSessionSequencedMessageEntries
 * - getForkSeed     vs  projectRuntimeSessionForkSeedEntries
 *
 * fixture 含 message.committed / tool.result.recorded / session.state.committed /
 * model.call.settled / transcript.event.recorded / 一个有效 checkpoint，能触发
 * checkpoint 替换 + 用量统计 + state 投影 + transcript 投影等所有路径。
 */
test("RuntimeProjectionService outputs are deepStrictEqual with the underlying projection functions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-projection-service-"));
  context.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });

  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  await store.initializeSession({ sessionId: SESSION_ID, workDir: WORK_DIR });

  // 构造一组多样化的 RuntimeEvent：user -> assistant(toolCall) -> toolResult -> state -> usage -> transcript
  const userMessageId = createRuntimeEventId("msg-user");
  const assistantMessageId = createRuntimeEventId("msg-assistant");
  const toolResultId = createRuntimeEventId("tool-result");
  const checkpointEventId = createRuntimeEventId("checkpoint");
  const stateEventId = createRuntimeEventId("session-state");
  const modelSettledId = createRuntimeEventId("model-settled");
  const transcriptEventId = createRuntimeEventId("transcript");

  const userMessage: Message = { role: "user", content: "请帮我读取 marker" };
  const assistantMessage: Message = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "read_marker", arguments: "{}" }],
  };

  const userMessageEvent: RuntimeMessageCommittedEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: userMessageId,
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    at: AT,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: userMessage },
  };
  const assistantMessageEvent: RuntimeMessageCommittedEvent = {
    ...userMessageEvent,
    eventId: assistantMessageId,
    data: { message: assistantMessage },
  };
  const toolResultEvent: RuntimeToolResultRecordedEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: toolResultId,
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    at: AT,
    partial: false,
    visibility: "model",
    kind: "tool.result.recorded",
    refs: { toolCallId: "call-1" },
    data: {
      toolName: "read_marker",
      status: "succeeded",
      ...inlineBody("marker"),
      projection: {
        version: 1,
        mode: "full",
        strategy: "bounded-inline",
        truncated: false,
        text: "marker",
      },
    },
  };

  // 追加前三个事件，随后插入一个有效 checkpoint 覆盖这三个 model 事件。
  await store.appendBatch([userMessageEvent, assistantMessageEvent, toolResultEvent]);

  const coveredEvents = await store.readSession(SESSION_ID);
  const coveredEntries = coveredEvents
    .filter(
      (event): event is RuntimeMessageCommittedEvent | RuntimeToolResultRecordedEvent =>
        (event.kind === "message.committed" || event.kind === "tool.result.recorded") &&
        event.visibility === "model" &&
        !event.partial,
    )
    .map((event) => ({
      eventId: event.eventId,
      message: projectToMessage(event),
    }));
  const checkpointSummary: Message = {
    role: "assistant",
    content: "checkpoint summary",
  };
  await store.append({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: checkpointEventId,
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    at: AT,
    partial: false,
    visibility: "internal",
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: "checkpoint-1",
      coveredEventCount: coveredEntries.length,
      sourceDigest: computeCheckpointSourceDigest(coveredEntries),
      throughEventId: coveredEntries.at(-1)!.eventId,
      summary: checkpointSummary,
    },
  });

  // state + usage + transcript 事件（不参与 model 投影，但参与 state/usage/transcript 投影）。
  const stateEvent: RuntimeEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: stateEventId,
    sessionId: SESSION_ID,
    invocationId: `session:${SESSION_ID}:state`,
    runId: "session-state",
    turnId: "session-state",
    at: AT,
    partial: false,
    visibility: "internal",
    kind: "session.state.committed",
    data: {
      stateVersion: 2,
      patch: {
        settings: {
          provider: "openai",
          model: "test-model",
          modelRouteId: "test/test-model",
          mode: "default",
          thinkingEffort: "off",
          thinkingEffortExplicit: false,
          additionalDirectories: [],
        },
      },
    },
  };
  const modelSettledEvent: RuntimeModelCallSettledEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: modelSettledId,
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    at: AT,
    partial: false,
    visibility: "internal",
    kind: "model.call.settled",
    data: {
      providerCallId: "provider-call-1",
      status: "succeeded",
      latencyMs: 42,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        reportedFields: ["prompt", "completion"],
      },
      costCNY: 0.01,
      costStatus: "estimated",
    },
  };
  await store.appendBatch([stateEvent, modelSettledEvent]);

  await store.appendTranscriptEvent(SESSION_ID, {
    eventId: transcriptEventId,
    sequence: 1,
    createdAt: Date.parse(AT),
    type: "entry.appended",
    entryId: "entry-1",
    entry: { kind: "user", content: "transcript user entry" },
  });

  const service = new RuntimeProjectionService(store);
  const events = await store.readSession(SESSION_ID);
  const entries: readonly RuntimeEventStoreEntry[] = await store.readSessionEntries(SESSION_ID);

  // getSessionView vs materializeRuntimeHistoryProjection
  const serviceView = await service.getSessionView(SESSION_ID);
  const directView = materializeRuntimeHistoryProjection(events);
  assert.ok(
    isDeepStrictEqual(serviceView, directView),
    "getSessionView must equal materializeRuntimeHistoryProjection",
  );
  // 确认 checkpoint 真的被替换了（否则等价性测试可能掩盖 bug）
  assert.equal(serviceView.entries.length, 1, "checkpoint should replace the 3 covered messages");
  assert.equal(serviceView.entries[0]?.eventId, checkpointEventId);

  // getMessages() (checkpoint default) vs materializeRuntimeHistory
  const serviceMessagesDefault = await service.getMessages(SESSION_ID);
  const directMessagesCheckpoint = materializeRuntimeHistory(events);
  assert.ok(
    isDeepStrictEqual(serviceMessagesDefault, directMessagesCheckpoint),
    "getMessages() must equal materializeRuntimeHistory",
  );

  // getMessages({checkpoint:false}) vs projectRuntimeSessionMessages
  const serviceMessagesRaw = await service.getMessages(SESSION_ID, { checkpoint: false });
  const directMessagesRaw = projectRuntimeSessionMessages(events);
  assert.ok(
    isDeepStrictEqual(serviceMessagesRaw, directMessagesRaw),
    "getMessages({checkpoint:false}) must equal projectRuntimeSessionMessages",
  );
  // 这两个视图必须不同（一个含 checkpoint 替换，一个不含），否则 fixture 太弱
  assert.ok(
    !isDeepStrictEqual(serviceMessagesDefault, serviceMessagesRaw),
    "checkpoint view and raw view must differ for this fixture",
  );

  // getMessageEntries vs materializeRuntimeHistoryEntries
  const serviceEntries = await service.getMessageEntries(SESSION_ID);
  const directEntries = materializeRuntimeHistoryEntries(events);
  assert.ok(
    isDeepStrictEqual(serviceEntries, directEntries),
    "getMessageEntries must equal materializeRuntimeHistoryEntries",
  );

  // getState vs projectRuntimeSessionState
  const serviceState = await service.getState(SESSION_ID);
  const directState = projectRuntimeSessionState(events);
  assert.ok(
    isDeepStrictEqual(serviceState, directState),
    "getState must equal projectRuntimeSessionState",
  );
  assert.equal(serviceState.usage.totalProviderCalls, 1);

  // getUsage vs projectRuntimeSessionUsage
  const serviceUsage = await service.getUsage(SESSION_ID);
  const directUsage = projectRuntimeSessionUsage(events);
  assert.ok(
    isDeepStrictEqual(serviceUsage, directUsage),
    "getUsage must equal projectRuntimeSessionUsage",
  );

  // getTranscriptEntries vs projectRuntimeSessionTranscriptEventEntries
  const serviceTranscript = await service.getTranscriptEntries(SESSION_ID);
  const directTranscript = projectRuntimeSessionTranscriptEventEntries(entries);
  assert.ok(
    isDeepStrictEqual(serviceTranscript, directTranscript),
    "getTranscriptEntries must equal projectRuntimeSessionTranscriptEventEntries",
  );
  assert.equal(serviceTranscript.length, 1);

  // getSequencedMessages vs projectRuntimeSessionSequencedMessageEntries
  const serviceSequenced = await service.getSequencedMessages(SESSION_ID);
  const directSequenced = projectRuntimeSessionSequencedMessageEntries(entries);
  assert.ok(
    isDeepStrictEqual(serviceSequenced, directSequenced),
    "getSequencedMessages must equal projectRuntimeSessionSequencedMessageEntries",
  );

  // getForkSeed vs projectRuntimeSessionForkSeedEntries
  const serviceForkSeed = await service.getForkSeed(SESSION_ID);
  const directForkSeed = projectRuntimeSessionForkSeedEntries(entries);
  assert.ok(
    isDeepStrictEqual(serviceForkSeed, directForkSeed),
    "getForkSeed must equal projectRuntimeSessionForkSeedEntries",
  );

  store.close();
});

/**
 * 投影层 fail-closed 契约：底层投影抛出的 hard 违规必须原样穿透 service，
 * 不能被 readSession 隐藏。这里用一个悬空的 tool result（无前置 assistant
 * toolCall batch）触发 assertToolCallPairing 抛错，验证 service 不吞错。
 */
test("RuntimeProjectionService propagates underlying projection failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-projection-service-fail-"));
  context.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });

  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  await store.initializeSession({ sessionId: SESSION_ID, workDir: WORK_DIR });

  // 一个悬空 tool result（没有前置 assistant toolCall batch）→ assertToolCallPairing 抛错
  const danglingToolResult: RuntimeToolResultRecordedEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: createRuntimeEventId("dangling-tool-result"),
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    at: AT,
    partial: false,
    visibility: "model",
    kind: "tool.result.recorded",
    refs: { toolCallId: "orphan-call" },
    data: {
      toolName: "read_marker",
      status: "succeeded",
      ...inlineBody("x"),
      projection: {
        version: 1,
        mode: "full",
        strategy: "bounded-inline",
        truncated: false,
        text: "x",
      },
    },
  };
  await store.appendBatch([danglingToolResult]);

  const service = new RuntimeProjectionService(store);
  await assert.rejects(
    () => service.getSessionView(SESSION_ID),
    /tool result|tool-call batch|preceding tool-call batch/ui,
    "getSessionView must surface assertToolCallPairing failures",
  );
  await assert.rejects(
    () => service.getMessages(SESSION_ID),
    /tool result|tool-call batch|preceding tool-call batch/ui,
    "getMessages must surface assertToolCallPairing failures",
  );
  await assert.rejects(
    () => service.getMessageEntries(SESSION_ID),
    /tool result|tool-call batch|preceding tool-call batch/ui,
    "getMessageEntries must surface assertToolCallPairing failures",
  );
  store.close();
});

function projectToMessage(
  event: RuntimeMessageCommittedEvent | RuntimeToolResultRecordedEvent,
): Message {
  if (event.kind === "message.committed") return structuredClone(event.data.message);
  // tool.result.recorded：与 projectRuntimeModelMessage 的 tool-result 分支保持一致
  return {
    role: "user",
    content: event.data.projection.text,
    toolCallId: event.refs.toolCallId,
  };
}

/**
 * 构造合法的 inline tool-result body：sha256 和 sizeBytes 必须与 content 严格匹配，
 * 否则 RuntimeEventStore.appendBatch 的 canonicalizeRuntimeEvent 会拒绝。
 */
function inlineBody(content: string): {
  body: { storage: "inline"; content: string; sha256: string; sizeBytes: number };
} {
  return {
    body: {
      storage: "inline",
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    },
  };
}
