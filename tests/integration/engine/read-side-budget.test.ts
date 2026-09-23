/** Model history retains committed content; transport paging remains bounded. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { materializeRuntimeHistoryEntries } from "@pico/runtime/session-runtime-read-model";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import {
  createCanonicalTranscriptToolStart,
  createRuntimeTranscriptToolStartEvent,
} from "@pico/core/transcript-tool-start";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import type { Message } from "@pico/core";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

function messageJsonBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

test("readModelHistory: 大全文会话不再隐式按1MiB裁剪，原始内容完整", async (t) => {
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
  assert.ok(totalBytes > 1024 * 1024);
  assert.deepEqual(
    gated,
    raw.map((entry) => entry.message),
  );
  assert.equal(gated[1]!.content, bigOutput);
  assert.equal(gated[1]!.toolCallId, "call-big");
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

test("materializeRuntimeHistoryEntries 保留大全文及工具配对", () => {
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
  const messages = entries.map(({ message }) => message);
  assert.equal(messages[1]!.content, big);
  assert.equal(messages[1]!.toolCallId, "call-pair");
  assert.deepEqual(
    messages[0]!.toolCalls?.map((call) => call.id),
    ["call-pair"],
  );
});
