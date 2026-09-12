/**
 * 票 E2(ADR 26 §2.3)读取侧瘦身验收:
 * 1) 模型历史组装(readModelHistory)按字节预算 gate:大输出会话的 provider
 *    消息总字节有界(票面:上下文组装按预算裁剪,provider 消息有界);
 * 2) 超预算降级为带诊断标记的截断视图(事件定位),不静默;末尾工作集永不裁剪;
 * 3) transcript 直接读取 storage projection，在固定 watermark 下按页数和字节预算
 *    返回稳定窗口，超大项使用可续传分片。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyModelHistoryByteBudget,
  MAX_MODEL_HISTORY_BYTES,
  materializeRuntimeHistoryEntries,
  type RuntimeHistoryProjectionEntry,
} from "../../../src/engine/session-runtime-read-model.js";
import { Session } from "../../../src/engine/session.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  createCanonicalTranscriptToolStart,
  createRuntimeTranscriptToolStartEvent,
} from "../../../src/engine/transcript-tool-start.js";
import type { RuntimeEvent } from "../../../src/engine/session-runtime-event.js";
import type { Message } from "../../../src/schema/message.js";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

const DEGRADED_MARKER_PATTERN = /历史输出已按上下文预算裁剪/u;

function historyEntry(
  eventId: string,
  content: string,
  extra: Partial<Message> = {},
): RuntimeHistoryProjectionEntry {
  return { eventId, message: { role: "user", content, ...extra } };
}

function messageJsonBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

// ============================================================
// 1) 预算 gate 纯逻辑(read-model 层)
// ============================================================

test("applyModelHistoryByteBudget: 预算内原样返回,超预算从最旧大内容降级且带标记", () => {
  const smallTail = Array.from({ length: 12 }, (_, index) =>
    historyEntry(`tail-${index}`, `tail content ${index}`),
  );
  const withinBudget = [
    historyEntry("old-1", "x".repeat(2048)),
    historyEntry("old-2", "y".repeat(4096)),
    ...smallTail,
  ];
  assert.deepStrictEqual(
    applyModelHistoryByteBudget(withinBudget, { maxTotalBytes: 1024 * 1024 }),
    withinBudget,
  );

  // 3 条 100KB 旧消息 + 12 条尾部消息,预算 250KB:只降级最旧的 old-1。
  const big = (eventId: string, fill: string) => historyEntry(eventId, fill.repeat(100 * 1024));
  const overBudget = [big("old-1", "a"), big("old-2", "b"), big("old-3", "c"), ...smallTail];
  const budgeted = applyModelHistoryByteBudget(overBudget, { maxTotalBytes: 250 * 1024 });

  const totalBytes = budgeted.reduce((sum, { message }) => sum + messageJsonBytes(message), 0);
  assert.ok(totalBytes <= 250 * 1024, `降级后总字节应落入预算,实际 ${totalBytes}`);
  assert.match(budgeted[0]!.message.content, DEGRADED_MARKER_PATTERN);
  assert.ok(budgeted[0]!.message.content.includes("old-1"), "标记必须定位原始事件,不静默");
  assert.equal(budgeted[1]!.message.content, overBudget[1]!.message.content);
  assert.equal(budgeted[2]!.message.content, overBudget[2]!.message.content);
  for (const [index, entry] of smallTail.entries()) {
    assert.equal(budgeted[3 + index]!.message.content, entry.message.content);
  }
});

test("applyModelHistoryByteBudget: 降级保留 role/toolCallId 配对字段,小消息与末尾大消息不裁", () => {
  const tail = Array.from({ length: 4 }, (_, index) =>
    historyEntry(`tail-${index}`, `tail ${index}`),
  );
  const entries = [
    historyEntry("tool-old", "x".repeat(8192), { toolCallId: "call-1" }),
    historyEntry("small-old", "keep me"),
    historyEntry("huge-tail", "z".repeat(64 * 1024)),
    ...tail,
  ];
  const budgeted = applyModelHistoryByteBudget(entries, {
    maxTotalBytes: 8 * 1024,
    preservedTailMessages: 5,
  });
  // 末尾 5 条(huge-tail + 4 tail)永不裁剪;唯一可降级的是 tool-old。
  assert.match(budgeted[0]!.message.content, DEGRADED_MARKER_PATTERN);
  assert.equal(budgeted[0]!.message.role, "user");
  assert.equal(budgeted[0]!.message.toolCallId, "call-1");
  assert.ok(budgeted[0]!.message.content.includes("call-1"));
  assert.equal(budgeted[1]!.message.content, "keep me");
  assert.equal(budgeted[2]!.message.content, entries[2]!.message.content);
  // 末尾工作集超出预算也不裁(best-effort gate,交给压缩/溢出轨道)。
  const totalBytes = budgeted.reduce((sum, { message }) => sum + messageJsonBytes(message), 0);
  assert.ok(totalBytes > 8 * 1024, "末尾工作集永不裁剪,即使预算装不下");
});

test("applyModelHistoryByteBudget: 非法预算参数 fail-closed", () => {
  const entries = [historyEntry("e-1", "x")];
  assert.throws(() => applyModelHistoryByteBudget(entries, { maxTotalBytes: 0 }), /maxTotalBytes/u);
  assert.throws(
    () => applyModelHistoryByteBudget(entries, { maxTotalBytes: 1.5 }),
    /maxTotalBytes/u,
  );
  assert.throws(
    () => applyModelHistoryByteBudget(entries, { maxTotalBytes: 1024, preservedTailMessages: -1 }),
    /preservedTailMessages/u,
  );
});

// ============================================================
// 2) RuntimeRun.readModelHistory 集成:大输出会话 provider 消息有界
// ============================================================

test("readModelHistory: 大全文会话组装字节有界,末尾工作集完整,降级带事件定位标记", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-e2-history-budget-"));
  const session = new Session("e2-history-budget", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const bigOutput = "x".repeat(300 * 1024);
  await run.run(async () => {
    await run.commitMessages(session, [
      {
        role: "assistant",
        content: "开始调查",
        toolCalls: [{ id: "call-big", name: "bash", arguments: '{"command":"cat big.log"}' }],
      },
    ]);
    await run.recordToolStarted("call-big", "bash", '{"command":"cat big.log"}');
    const toolResultMessage = run.registerToolResult({
      toolCallId: "call-big",
      toolName: "bash",
      status: "succeeded",
      body: {
        storage: "inline",
        content: bigOutput,
        sha256: createHash("sha256").update(bigOutput, "utf8").digest("hex"),
        sizeBytes: Buffer.byteLength(bigOutput, "utf8"),
      },
      projection: {
        version: 1,
        mode: "full",
        text: bigOutput,
        strategy: "original",
        truncated: false,
      },
    });
    await run.commitMessages(session, [toolResultMessage]);
    for (let index = 0; index < 3; index += 1) {
      await run.commitMessages(session, [
        { role: "user", content: `paste-${index}:` + "y".repeat(300 * 1024) },
        { role: "assistant", content: `ack-${index}` },
      ]);
    }
    for (let index = 0; index < 8; index += 1) {
      await run.commitMessages(session, [
        { role: "user", content: `recent-user-${index}` },
        { role: "assistant", content: `recent-assistant-${index}` },
      ]);
    }
  });

  const gated = await run.readModelHistory();
  const raw = await run.readModelHistoryEntries();
  assert.equal(gated.length, raw.length);

  const totalBytes = gated.reduce((sum, message) => sum + messageJsonBytes(message), 0);
  assert.ok(
    totalBytes <= MAX_MODEL_HISTORY_BYTES,
    `provider 消息总字节必须有界(<=${MAX_MODEL_HISTORY_BYTES}),实际 ${totalBytes}`,
  );

  // 最旧的大全文(工具结果,总账第 2 条)被降级:带标记 + 事件定位 + 配对字段保留。
  assert.match(gated[1]!.content, DEGRADED_MARKER_PATTERN);
  assert.ok(gated[1]!.content.includes(raw[1]!.eventId));
  assert.equal(gated[1]!.toolCallId, "call-big");
  assert.equal(raw[1]!.message.content, bigOutput);
  // 预算收敛后,后续大消息保留原文。
  assert.ok(gated[2]!.content.startsWith("paste-0:"));
  assert.ok(gated[4]!.content.startsWith("paste-1:"));
  // 末尾工作集(最后 12 条)逐字完整。
  for (let offset = 1; offset <= 12; offset += 1) {
    assert.equal(gated.at(-offset)!.content, raw.at(-offset)!.message.content);
  }
  assert.equal(gated.at(-1)!.content, "recent-assistant-7");
});

test("readModelHistory: 预算内的常规会话不被 gate 触碰", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-e2-history-fit-"));
  const session = new Session("e2-history-fit", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await run.run(async () => {
    await run.commitMessages(session, [
      { role: "user", content: "常规输入" },
      { role: "assistant", content: "常规回复" },
    ]);
  });
  const gated = await run.readModelHistory();
  const raw = await run.readModelHistoryEntries();
  assert.deepEqual(
    gated,
    raw.map(({ message }) => message),
  );
});

// ============================================================
// 3) storage-backed transcript projection
// ============================================================

interface StoreFixture {
  readonly root: string;
  readonly store: SqliteRuntimeEventStore;
}

function createStoreFixture(prefix: string): StoreFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, store: new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") }) };
}

function messageEvent(
  eventId: string,
  sessionId: string,
  at: string,
  content: string,
): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-e2",
    runId: "run-e2",
    turnId: "turn-e2",
    at,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  } as RuntimeEvent;
}

test("readTranscriptProjectionPage: 字节预算与固定 watermark 分页保持稳定", async (t) => {
  const fixture = createStoreFixture("pico-e2-transcript-budget-");
  t.after(async () => {
    fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const id = "e2-transcript-budget";
  const workspace = join(fixture.root, "workspace");
  const { ownerFence } = await initializeRuntimeEventOwner(fixture.store, {
    sessionId: id,
    workDir: workspace,
  });
  const big = (fill: string) => fill.repeat(60 * 1024);
  const appended = await fixture.store.appendBatch(
    [
      messageEvent(`${id}-e1`, id, "2026-08-19T00:00:01.000Z", "small-early"),
      messageEvent(`${id}-e2`, id, "2026-08-19T00:00:02.000Z", big("a")),
      messageEvent(`${id}-e3`, id, "2026-08-19T00:00:03.000Z", big("b")),
      messageEvent(`${id}-e4`, id, "2026-08-19T00:00:04.000Z", "small-latest"),
    ],
    { ownerFence },
  );
  const through = appended.at(-1)!.transcriptWatermark!;
  const maxBytes = 70 * 1024;
  const latest = await fixture.store.readTranscriptProjectionPage({
    sessionId: id,
    through,
    limit: 2,
    maxBytes,
  });

  assert.deepEqual(latest.watermark, through);
  assert.deepEqual(
    latest.items.map(({ itemId }) => itemId),
    [`message:${id}-e3:user`, `message:${id}-e4:user`],
  );
  assert.ok(latest.nextCursor, "更早记录必须由结构化 cursor 暴露");
  const latestBytes = latest.items.reduce(
    (sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"),
    0,
  );
  assert.ok(latestBytes <= maxBytes, `projection 页必须受字节预算约束，实际 ${latestBytes}`);

  await fixture.store.append(messageEvent(`${id}-e5`, id, "2026-08-19T00:00:05.000Z", "new-head"), {
    ownerFence,
  });
  const older = await fixture.store.readTranscriptProjectionPage({
    sessionId: id,
    through,
    cursor: latest.nextCursor,
    limit: 2,
    maxBytes,
  });
  assert.deepEqual(older.watermark, through, "翻页期间追加事件不得推进已捕获水位");
  assert.deepEqual(
    older.items.map(({ itemId }) => itemId),
    [`message:${id}-e1:user`, `message:${id}-e2:user`],
  );
  assert.equal(older.nextCursor, undefined);
});

test("readTranscriptProjectionPage: 工具开始与结果投影为同一张完成卡", async (t) => {
  const fixture = createStoreFixture("pico-e2-transcript-pairing-");
  t.after(async () => {
    fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const id = "e2-transcript-pairing";
  const workspace = join(fixture.root, "workspace");
  const { ownerFence } = await initializeRuntimeEventOwner(fixture.store, {
    sessionId: id,
    workDir: workspace,
  });
  const bigOutput = "r".repeat(48 * 1024);
  const start = createCanonicalTranscriptToolStart({
    sessionId: id,
    runId: "run-e2",
    turnId: "turn-e2",
    callIndex: 0,
    toolCall: {
      id: "call-budget-pair",
      name: "read_file",
      arguments: JSON.stringify({ path: `a${"x".repeat(8 * 1024)}.txt` }),
    },
    sequence: 1,
    createdAt: 1,
  });
  await fixture.store.appendBatch(
    [
      createRuntimeTranscriptToolStartEvent({
        sessionId: id,
        invocationId: "inv-e2",
        runId: "run-e2",
        turnId: "turn-e2",
        start,
      }),
      {
        schemaVersion: 2,
        eventId: `${id}-result`,
        sessionId: id,
        invocationId: "inv-e2",
        runId: "run-e2",
        turnId: "turn-e2",
        at: "2026-08-19T00:00:02.000Z",
        partial: false,
        visibility: "model",
        refs: { toolCallId: "call-budget-pair" },
        kind: "tool.result.recorded",
        data: {
          toolName: "read_file",
          status: "succeeded",
          body: {
            storage: "inline",
            content: bigOutput,
            sha256: createHash("sha256").update(bigOutput, "utf8").digest("hex"),
            sizeBytes: Buffer.byteLength(bigOutput, "utf8"),
          },
          projection: {
            version: 1,
            mode: "full",
            text: bigOutput,
            strategy: "original",
            truncated: false,
          },
        },
      } as RuntimeEvent,
      messageEvent(`${id}-tail`, id, "2026-08-19T00:00:03.000Z", `tail:${"t".repeat(1024)}`),
    ],
    { ownerFence },
  );

  const page = await fixture.store.readTranscriptProjectionPage({
    sessionId: id,
    maxBytes: 104 * 1024,
  });
  const toolRecord = page.items.find(({ itemId }) => itemId === `tool:${start.toolCallId}`);
  const toolItem = toolRecord?.payload as { readonly kind?: unknown; readonly status?: unknown };
  assert.equal(
    toolItem.kind === "tool" ? toolItem.status : undefined,
    "success",
    "storage projection 应在同一稳定项内完成工具配对",
  );
  assert.ok(
    page.items.some(
      ({ payload }) =>
        (payload as { readonly kind?: unknown; readonly content?: unknown }).kind ===
          "userMessage" &&
        String((payload as { readonly content?: unknown }).content).startsWith("tail:"),
    ),
  );
  assert.equal(page.watermark.throughSequence, 3);
});

test("materializeRuntimeHistoryEntries 与 gate 组合后仍满足工具配对不变量(降级保留 toolCallId)", () => {
  // 组合校验:纯投影 + gate 输出的消息序列,assistant 工具批次与观察结果
  // 的先后配对不被降级破坏(降级只替换 content)。
  const big = "r".repeat(32 * 1024);
  const events: RuntimeEvent[] = [
    {
      schemaVersion: 2,
      eventId: "pair-e1",
      sessionId: "pair",
      invocationId: "inv",
      runId: "run",
      turnId: "turn",
      at: "2026-08-19T00:00:00.000Z",
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: {
        message: {
          role: "assistant",
          content: "need data",
          toolCalls: [{ id: "call-pair", name: "bash", arguments: "{}" }],
        },
      },
    } as RuntimeEvent,
    {
      schemaVersion: 2,
      eventId: "pair-e2",
      sessionId: "pair",
      invocationId: "inv",
      runId: "run",
      turnId: "turn",
      at: "2026-08-19T00:00:01.000Z",
      partial: false,
      visibility: "model",
      refs: { toolCallId: "call-pair" },
      kind: "tool.result.recorded",
      data: {
        toolName: "bash",
        status: "succeeded",
        body: {
          storage: "inline",
          content: big,
          sha256: createHash("sha256").update(big, "utf8").digest("hex"),
          sizeBytes: Buffer.byteLength(big, "utf8"),
        },
        projection: { version: 1, mode: "full", text: big, strategy: "original", truncated: false },
      },
    } as RuntimeEvent,
  ];
  const entries = materializeRuntimeHistoryEntries(events);
  // preservedTailMessages: 0 使 2 条消息的历史也可降级(默认 12 会保护短历史)。
  const budgeted = applyModelHistoryByteBudget(entries, {
    maxTotalBytes: 1024,
    preservedTailMessages: 0,
  });
  const messages = budgeted.map(({ message }) => message);
  assert.match(messages[1]!.content, DEGRADED_MARKER_PATTERN);
  assert.equal(messages[1]!.toolCallId, "call-pair");
  assert.deepEqual(
    messages[0]!.toolCalls?.map((call) => call.id),
    ["call-pair"],
  );
});
