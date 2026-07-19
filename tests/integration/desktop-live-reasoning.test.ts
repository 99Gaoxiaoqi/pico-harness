import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_LIVE_REASONING_CHARS,
  applyLiveReasoningUpdate,
  mergeHydratedConversationItems,
} from "../../apps/desktop/src/renderer/conversation/items.js";
import { DesktopReporter } from "../../src/daemon/desktop-reporter.js";
import { publishDesktopReporterEvent } from "../../src/daemon/production-host.js";
import {
  createRuntimeNotification,
  isEphemeralRuntimeNotificationTopic,
  isRunLiveRuntimeNotification,
  parseDesktopRuntimeResult,
  RuntimeNotificationBuffer,
} from "../../src/daemon/protocol.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";

test("Desktop reasoning uses a bounded live item that can be completed or cleared", () => {
  const streamId = "thinking:live:run-1:1";
  const initial = applyLiveReasoningUpdate([], {
    runId: "run-1",
    turnId: "turn:run-1:1",
    operation: "append",
    streamId,
    delta: "先检查",
    at: 1,
  });
  const appended = applyLiveReasoningUpdate(initial, {
    runId: "run-1",
    operation: "append",
    streamId,
    delta: "配置。",
    at: 2,
  });
  assert.deepEqual(appended, [
    {
      id: streamId,
      kind: "thinking",
      text: "先检查配置。",
      streaming: true,
      runId: "run-1",
      turnId: "turn:run-1:1",
      at: 1,
    },
  ]);

  const oversized = applyLiveReasoningUpdate([], {
    runId: "run-2",
    operation: "append",
    streamId: "thinking:live:run-2:1",
    delta: "x".repeat(MAX_LIVE_REASONING_CHARS + 100),
  });
  assert.equal(oversized[0]?.kind, "thinking");
  assert.equal(oversized[0]?.truncated, true);
  assert.equal(
    oversized[0]?.kind === "thinking" ? oversized[0].text.length : 0,
    MAX_LIVE_REASONING_CHARS,
  );

  const completed = applyLiveReasoningUpdate(appended, {
    runId: "run-1",
    operation: "complete",
  });
  assert.equal(completed[0]?.kind === "thinking" ? completed[0].streaming : true, false);
  assert.equal(completed[0]?.kind === "thinking" ? completed[0].liveTerminal : false, true);
  assert.deepEqual(
    applyLiveReasoningUpdate(completed, {
      runId: "run-1",
      operation: "append",
      streamId,
      delta: "迟到内容",
    }),
    completed,
  );
  const cleared = applyLiveReasoningUpdate(completed, {
    runId: "run-1",
    operation: "clear",
  });
  assert.equal(cleared[0]?.kind === "thinking" ? cleared[0].cleared : false, true);

  const delayedOtherRun = applyLiveReasoningUpdate(appended, {
    runId: "run-old",
    operation: "append",
    streamId,
    delta: "不应串入",
  });
  assert.deepEqual(delayedOtherRun, appended);
  assert.deepEqual(mergeHydratedConversationItems([], appended, "run-1"), appended);
  assert.deepEqual(mergeHydratedConversationItems([], appended, "run-2"), []);
  const currentUser = { id: "user:current", kind: "userMessage" as const, text: "继续" };
  const hydratedCurrentReasoning = [
    currentUser,
    {
      id: "thinking:durable",
      kind: "thinking" as const,
      text: "先检查配置。",
      runId: "run-1",
      turnId: "turn:run-1:1",
    },
  ];
  assert.deepEqual(
    mergeHydratedConversationItems(hydratedCurrentReasoning, [currentUser, ...appended], "run-1"),
    hydratedCurrentReasoning,
  );
  assert.deepEqual(
    mergeHydratedConversationItems(
      [{ id: "thinking:durable", kind: "thinking", text: "先检查配置。" }],
      completed,
      "run-1",
    ),
    [{ id: "thinking:durable", kind: "thinking", text: "先检查配置。" }],
  );

  const historical = [{ id: "thinking:historical", kind: "thinking" as const, text: "检查配置" }];
  const liveBeforeFirstHydration = applyLiveReasoningUpdate([], {
    runId: "run-3",
    operation: "append",
    streamId: "thinking:live:run-3:1",
    delta: "检查",
  });
  assert.deepEqual(mergeHydratedConversationItems(historical, liveBeforeFirstHydration, "run-3"), [
    ...historical,
    ...liveBeforeFirstHydration,
  ]);
  const repeatedPrefixLive = applyLiveReasoningUpdate([...historical, currentUser], {
    runId: "run-3",
    turnId: "turn:run-3:2",
    operation: "append",
    streamId: "thinking:live:run-3:1",
    delta: "检查",
  });
  assert.deepEqual(
    mergeHydratedConversationItems([...historical, currentUser], repeatedPrefixLive, "run-3"),
    repeatedPrefixLive,
  );
  const newDurable = {
    id: "thinking:new-durable",
    kind: "thinking" as const,
    text: "检查配置文件",
    runId: "run-3",
    turnId: "turn:run-3:1",
  };
  assert.deepEqual(
    mergeHydratedConversationItems(
      [...historical, currentUser, newDurable],
      repeatedPrefixLive,
      "run-3",
    ),
    [...historical, currentUser, newDurable, repeatedPrefixLive.at(-1)!],
  );
  const exactLive = applyLiveReasoningUpdate([...historical, currentUser], {
    runId: "run-3",
    turnId: "turn:run-3:2",
    operation: "append",
    streamId: "thinking:live:run-3:2",
    delta: "检查配置文件",
  });
  const currentDurable = {
    id: "thinking:current-durable",
    kind: "thinking" as const,
    text: "检查配置文件",
    runId: "run-3",
    turnId: "turn:run-3:2",
  };
  assert.deepEqual(
    mergeHydratedConversationItems(
      [...historical, currentUser, newDurable, currentDurable],
      exactLive,
      "run-3",
    ),
    [...historical, currentUser, newDurable, currentDurable],
  );

  const repeatedContentLive = applyLiveReasoningUpdate([...historical, currentUser], {
    runId: "run-3",
    turnId: "turn:run-3:2",
    operation: "append",
    streamId: "thinking:live:run-3:2",
    delta: "检查配置",
  });
  const previousTurnSameContent = {
    id: "thinking:previous-turn",
    kind: "thinking" as const,
    text: "检查配置",
    runId: "run-3",
    turnId: "turn:run-3:1",
  };
  assert.deepEqual(
    mergeHydratedConversationItems(
      [currentUser, previousTurnSameContent],
      repeatedContentLive,
      "run-3",
    ),
    [currentUser, previousTurnSameContent, repeatedContentLive.at(-1)!],
  );

  const longReasoning = "长".repeat(MAX_LIVE_REASONING_CHARS + 100);
  const longLive = applyLiveReasoningUpdate([currentUser], {
    runId: "run-4",
    operation: "append",
    streamId: "thinking:live:run-4:1",
    delta: longReasoning,
  });
  const longDurable = { id: "thinking:long", kind: "thinking" as const, text: longReasoning };
  assert.deepEqual(mergeHydratedConversationItems([currentUser, longDurable], longLive, "run-4"), [
    currentUser,
    longDurable,
  ]);
});

test("DesktopReporter separates provider reasoning from the durable timeline payload", () => {
  const events: Array<{
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }> = [];
  const reporter = new DesktopReporter({
    runId: "run-1",
    sessionId: "session-1",
    now: () => 1,
    publish: (event) => events.push(event),
  });
  reporter.onTurnStart(3);
  reporter.onReasoningDelta("检查配置");
  reporter.onAssistantResponseSuppressed("required-delegation");

  assert.equal(events[1]?.type, "assistant.reasoning.delta");
  assert.deepEqual(events[1]?.payload, {
    delta: "检查配置",
    truncated: false,
    turn: 3,
  });
  assert.deepEqual(events[2]?.payload, { reason: "required-delegation", turn: 3 });
});

test("durable replay result rejects ephemeral run.live events", () => {
  const event = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "run-1" },
    resourceVersion: 1,
    at: 1,
    payload: {
      runId: "run-1",
      item: { kind: "thinking", operation: "append", streamId: "stream-1", delta: "x" },
    },
  });
  assert.throws(
    () => parseDesktopRuntimeResult("events.replay", { events: [event], hasMore: false }),
    /ephemeral Runtime event/u,
  );
});

test("session transcript rejects invalid durable reasoning identities", () => {
  const result = {
    session: {
      sessionId: "session-1",
      workspacePath: "/workspace",
      title: "Session",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    items: [
      {
        id: "thinking-1",
        kind: "thinking",
        content: "检查配置",
        runId: "run-1",
        turnId: "turn:run-1:1",
      },
    ],
    queuedInputs: [],
    revision: "revision-1",
  };
  assert.deepEqual(parseDesktopRuntimeResult("session.transcript", result), result);
  assert.throws(
    () =>
      parseDesktopRuntimeResult("session.transcript", {
        ...result,
        items: [{ ...result.items[0], runId: 123, turnId: { invalid: true } }],
      }),
    /runId|turnId/u,
  );
});

test("run.live rejects mismatched Run identity and terminal payload fields", () => {
  const mismatched = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "scope-run" },
    resourceVersion: 1,
    at: 1,
    payload: {
      runId: "payload-run",
      item: { kind: "thinking", operation: "append", streamId: "stream-1", delta: "x" },
    },
  });
  assert.equal(isRunLiveRuntimeNotification(mismatched), false);
  const buffer = new RuntimeNotificationBuffer();
  assert.equal(buffer.push(mismatched), true);
  assert.equal(buffer.size, 0);
  const invalidTerminal = {
    ...mismatched,
    scope: { ...mismatched.scope, runId: "payload-run" },
    payload: {
      runId: "payload-run",
      item: { kind: "thinking", operation: "complete", delta: "invalid" },
    },
  } as typeof mismatched;
  assert.equal(isRunLiveRuntimeNotification(invalidTerminal), false);
  assert.equal(buffer.push(invalidTerminal), true);
  assert.equal(buffer.size, 0);
});

test("pending Runtime buffer coalesces live deltas and refuses to drop durable events", () => {
  const liveBuffer = new RuntimeNotificationBuffer({
    maxEvents: 2,
    maxBytes: 4096,
    maxLiveReasoningChars: 10,
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      liveBuffer.push(
        createRuntimeNotification({
          topic: "run.live",
          scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "run-1" },
          resourceVersion: index + 1,
          at: index,
          payload: {
            runId: "run-1",
            item: {
              kind: "thinking",
              operation: "append",
              streamId: "stream-1",
              delta: String(index % 10),
            },
          },
        }),
      ),
      true,
    );
  }
  const coalesced = liveBuffer.drain();
  assert.equal(coalesced.length, 1);
  assert.equal(
    coalesced[0]?.topic === "run.live"
      ? (coalesced[0].payload as { item: { delta?: string } }).item.delta
      : undefined,
    "0123456789",
  );

  const truncatedBuffer = new RuntimeNotificationBuffer({
    maxEvents: 4,
    maxBytes: 4096,
    maxLiveReasoningChars: 5,
  });
  const live = (operation: "append" | "clear", delta?: string) =>
    createRuntimeNotification({
      topic: "run.live",
      scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "run-1" },
      resourceVersion: 1,
      at: 1,
      payload: {
        runId: "run-1",
        item: {
          kind: "thinking",
          operation,
          ...(operation === "append" ? { streamId: "stream-1", delta: delta ?? "" } : {}),
        },
      },
    });
  assert.equal(truncatedBuffer.push(live("append", "abc")), true);
  assert.equal(truncatedBuffer.push(live("append", "def")), true);
  const truncated = truncatedBuffer.drain()[0];
  assert.equal(
    truncated?.topic === "run.live"
      ? (truncated.payload as { item: { delta?: string } }).item.delta
      : undefined,
    "abcde",
  );
  assert.equal(
    truncated?.topic === "run.live"
      ? (truncated.payload as { item: { truncated?: boolean } }).item.truncated
      : undefined,
    true,
  );

  assert.equal(truncatedBuffer.push(live("append", "abc")), true);
  assert.equal(truncatedBuffer.push(live("clear")), true);
  assert.equal(truncatedBuffer.push(live("append", "def")), true);
  assert.deepEqual(
    truncatedBuffer
      .drain()
      .map((event) =>
        event.topic === "run.live"
          ? (event.payload as { item: { operation: string } }).item.operation
          : event.topic,
      ),
    ["append", "clear"],
  );

  const malformed = {
    ...live("clear"),
    payload: {},
  } as unknown as ReturnType<typeof live>;
  assert.equal(truncatedBuffer.push(malformed), true);
  assert.equal(truncatedBuffer.size, 0);

  const durableBuffer = new RuntimeNotificationBuffer({ maxEvents: 1, maxBytes: 4096 });
  const durable = (resourceVersion: number) =>
    createRuntimeNotification({
      topic: "run.timeline",
      scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "run-1" },
      resourceVersion,
      at: resourceVersion,
      payload: { runId: "run-1", item: { kind: "fixture" } },
    });
  assert.equal(durableBuffer.push(durable(1)), true);
  assert.equal(durableBuffer.push(durable(2)), false);
  assert.equal(durableBuffer.drain()[0]?.resourceVersion, 1);

  const durableAfterLive = new RuntimeNotificationBuffer({ maxEvents: 1, maxBytes: 4096 });
  assert.equal(durableAfterLive.push(live("append", "ephemeral")), true);
  assert.equal(durableAfterLive.push(durable(3)), true);
  assert.equal(durableAfterLive.drain()[0]?.topic, "run.timeline");

  const ordered = new RuntimeNotificationBuffer({ maxEvents: 4, maxBytes: 4096 });
  assert.equal(ordered.push(live("append", "before")), true);
  assert.equal(ordered.push(durable(4)), true);
  assert.equal(ordered.push(live("append", "after")), true);
  assert.deepEqual(
    ordered
      .drain()
      .map((event) =>
        event.topic === "run.live"
          ? (event.payload as { item: { delta?: string } }).item.delta
          : event.topic,
      ),
    ["before", "run.timeline", "after"],
  );

  const gapped = new RuntimeNotificationBuffer({ maxEvents: 2, maxBytes: 4096 });
  assert.equal(gapped.push(live("append", "prefix")), true);
  assert.equal(gapped.push(durable(5)), true);
  assert.equal(gapped.push(live("append", "suffix")), true);
  const retained = gapped.drain();
  assert.deepEqual(
    retained.map((event) =>
      event.topic === "run.live"
        ? (event.payload as { item: { delta?: string } }).item.delta
        : event.topic,
    ),
    ["run.timeline", "suffix"],
  );
  assert.equal(
    retained[1]?.topic === "run.live"
      ? (retained[1].payload as { item: { truncated?: boolean } }).item.truncated
      : undefined,
    true,
  );

  const upstreamTruncated = new RuntimeNotificationBuffer({ maxEvents: 2, maxBytes: 4096 });
  const truncatedAppend = live("append", "prefix");
  assert.equal(
    upstreamTruncated.push({
      ...truncatedAppend,
      payload: {
        ...truncatedAppend.payload,
        item: { ...truncatedAppend.payload.item, truncated: true },
      },
    }),
    true,
  );
  upstreamTruncated.drain();
  assert.equal(upstreamTruncated.push(live("append", "suffix")), true);
  const continued = upstreamTruncated.drain()[0];
  assert.equal(
    continued?.topic === "run.live"
      ? (continued.payload as { item: { truncated?: boolean } }).item.truncated
      : undefined,
    true,
  );
});

test("run.live is delivered but never persisted or replayed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-live-reasoning-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const observed: string[] = [];
  const liveOperations: string[] = [];
  const liveTruncation: boolean[] = [];
  service.subscribe((event) => {
    observed.push(event.topic);
    if (event.topic === "run.live") {
      const payload = event.payload as { item?: { operation?: string; truncated?: boolean } };
      if (payload.item?.operation) liveOperations.push(payload.item.operation);
      if (payload.item?.operation === "append") {
        liveTruncation.push(payload.item.truncated === true);
      }
    }
  });

  assert.equal(isEphemeralRuntimeNotificationTopic("run.live"), true);
  service.publishEphemeralNotification(
    createRuntimeNotification({
      topic: "run.live",
      scope: { workspacePath: canonicalWorkspace, sessionId: "session-1", runId: "run-1" },
      resourceVersion: 1,
      at: 1,
      payload: {
        runId: "run-1",
        item: {
          kind: "thinking",
          operation: "append",
          streamId: "thinking:live:run-1:1",
          delta: "检查配置",
        },
      },
    }),
  );

  assert.deepEqual(observed, ["run.live"]);
  assert.deepEqual(await service.replayEvents({ workspacePath: canonicalWorkspace }), {
    events: [],
    hasMore: false,
  });

  assert.throws(
    () =>
      service.publishDesktopNotification(
        createRuntimeNotification({
          topic: "run.live",
          scope: { workspacePath: canonicalWorkspace, sessionId: "session-1", runId: "run-1" },
          resourceVersion: 2,
          at: 2,
          payload: {
            runId: "run-1",
            item: { kind: "thinking", operation: "clear" },
          },
        }),
      ),
    /cannot be persisted/u,
  );
  assert.deepEqual(observed, ["run.live"]);

  let resourceVersion = 10;
  const publishReporter = (type: string, payload: Readonly<Record<string, unknown>>) =>
    publishDesktopReporterEvent(
      service,
      canonicalWorkspace,
      {
        runId: "run-1",
        sessionId: "session-1",
        type,
        resourceVersion: resourceVersion + 1,
        at: resourceVersion + 1,
        payload,
      },
      () => ++resourceVersion,
    );
  publishReporter("assistant.reasoning.delta", { turn: 1, delta: "继续检查" });
  publishReporter("assistant.reasoning.delta", {
    turn: 1,
    delta: "过长内容",
    truncated: true,
  });
  publishReporter("run.interrupted", { turn: 1 });
  publishReporter("run.finished", {});
  assert.deepEqual(liveOperations, ["append", "append", "append", "clear", "complete"]);
  assert.deepEqual(liveTruncation, [false, false, true]);

  publishReporter("assistant.reasoning.delta", { turn: 1, delta: "迟到思考" });
  assert.deepEqual(liveOperations, ["append", "append", "append", "clear", "complete"]);

  publishDesktopReporterEvent(
    service,
    canonicalWorkspace,
    {
      runId: "run-tool",
      sessionId: "session-1",
      type: "assistant.reasoning.delta",
      resourceVersion: 1,
      at: 1,
      payload: { turn: 2, delta: "工具前思考" },
    },
    () => ++resourceVersion,
  );
  publishDesktopReporterEvent(
    service,
    canonicalWorkspace,
    {
      runId: "run-tool",
      sessionId: "session-1",
      type: "tool.started",
      resourceVersion: 2,
      at: 2,
      payload: { turn: 2, toolName: "read_file", args: "{}" },
    },
    () => ++resourceVersion,
  );
  publishDesktopReporterEvent(
    service,
    canonicalWorkspace,
    {
      runId: "run-tool",
      sessionId: "session-1",
      type: "assistant.reasoning.delta",
      resourceVersion: 3,
      at: 3,
      payload: { turn: 2, delta: "迟到" },
    },
    () => ++resourceVersion,
  );
  assert.deepEqual(liveOperations.slice(-2), ["append", "complete"]);
});

test("durable replay rejects stale cursors instead of reporting progress without events", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-stale-replay-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "run.timeline",
      scope: { workspacePath: canonicalWorkspace, sessionId: "session-1", runId: "run-1" },
      resourceVersion: 1,
      at: 1,
      payload: { runId: "run-1", item: { kind: "status" } },
    }),
  );

  await assert.rejects(
    service.replayEvents({ workspacePath: canonicalWorkspace, afterEventId: "missing" }),
    /afterEventId 已失效/u,
  );
  await assert.rejects(
    service.replayEvents({
      workspacePath: canonicalWorkspace,
      highWatermarkEventId: "missing",
    }),
    /highWatermarkEventId 已失效/u,
  );
});
