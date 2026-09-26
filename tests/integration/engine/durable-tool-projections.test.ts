import { contextSummaryMessage } from "../../fixtures/context-summary.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/runtime/runtime-run";
import { bindToolResultArchiveReader } from "@pico/runtime/tool-result-archive";
import {
  readRuntimeModelHistorySnapshot,
  materializeRuntimeHistoryEntries,
} from "@pico/runtime/session-runtime-read-model";
import { createSessionForkRuntimePort } from "@pico/pico-host/session-fork-runtime-port-adapter";
import { estimateMessagesTokens } from "@pico/runtime/context-budget";
import { computeCheckpointSourceDigest, type ToolDefinition } from "@pico/core";

const tools: ToolDefinition[] = [
  { name: "archive_read", description: "read durable archive", inputSchema: {} },
];
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pico-durable-projection-"));
  const session = new Session("projection", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "home"),
  });
  await session.recover();
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  run.setToolResultArchiveAvailable(true);
  return { session, run };
}
async function result(
  session: Session,
  run: RuntimeRun,
  id: string,
  content: string,
  toolName = "fixture",
  args = "{}",
) {
  await run.commitMessages(session, [
    { role: "assistant", content: "", toolCalls: [{ id, name: toolName, arguments: args }] },
  ]);
  await run.recordToolStarted(id, toolName, args);
  const message = run.registerToolResult({
    toolCallId: id,
    toolName,
    status: "succeeded",
    body: {
      storage: "inline",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content),
    },
    projection: { version: 1, mode: "full", strategy: "original", truncated: false, text: content },
  });
  await run.commitMessages(session, [message]);
}

test("Tool projection decisions are durable, read-only on replay, and bound to the checkpoint digest", async (t) => {
  const { session, run } = await fixture(t);
  const raw = "正文".repeat(5_000);
  await run.run(async () => {
    await run.commitMessages(session, [{ role: "user", content: "inspect" }]);
    await result(session, run, "large", raw);
    await run.prepareToolResultProjections({ stepNumber: 0, tools });
    assert.equal((await run.readModelHistory()).at(-1)?.content, raw);
    const store = session.runtimeEventStore!;
    const append = store.appendBatch;
    store.appendBatch = async (...args) => {
      if (args[0].some((event) => event.kind === "tool.result.projection.recorded"))
        throw new Error("injected projection commit failure");
      return append.apply(store, args);
    };
    try {
      await assert.rejects(
        run.prepareToolResultProjections({ stepNumber: 1, tools }),
        /injected projection commit failure/,
      );
      assert.equal((await run.readModelHistory()).at(-1)?.content, raw);
    } finally {
      store.appendBatch = append;
    }
    await run.prepareToolResultProjections({ stepNumber: 1, tools });
    const before = await session.runtimeEventStore!.readSession(session.id);
    assert.equal(before.filter((e) => e.kind === "tool.result.projection.recorded").length, 1);
    const broken = structuredClone(before);
    const invalid = broken.find((event) => event.kind === "tool.result.projection.recorded");
    assert.ok(invalid?.kind === "tool.result.projection.recorded");
    const invalidIndex = broken.indexOf(invalid);
    broken[invalidIndex] = {
      ...invalid,
      data: { ...invalid.data, sourceProjectionSha256: "0".repeat(64) },
    };
    assert.throws(() => materializeRuntimeHistoryEntries(broken), /invalid source or digest/);
    const original = before.find((e) => e.kind === "tool.result.recorded");
    assert.ok(original?.kind === "tool.result.recorded");
    assert.equal(original.data.projection.text, raw);
    run.setToolResultArchiveAvailable(false);
    const replay = await run.readModelHistory();
    assert.match(replay.at(-1)!.content, /工具结果已归档/);
    const ref = replay.at(-1)!.content.match(/pico:\/\/archive\/[^"\s]+/)![0];
    assert.equal(
      await bindToolResultArchiveReader(session.runtimeEventStore!, session.id).readRaw(ref),
      raw,
    );
    assert.deepEqual(
      (await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, session.id)).messages,
      replay,
    );
    run.setToolResultArchiveAvailable(true);
    await run.prepareToolResultProjections({ stepNumber: 2, tools });
    assert.deepEqual(await session.runtimeEventStore!.readSession(session.id), before);
    const covered = await run.readModelHistoryEntries();
    await run.recordCheckpoint({
      checkpointId: "checkpoint",
      coveredEventCount: covered.length,
      throughEventId: covered.at(-1)!.eventId,
      sourceDigest: computeCheckpointSourceDigest(covered),
      summary: contextSummaryMessage("Archived the large result."),
    });
    assert.deepEqual(await run.readContextCompactionBoundary(), {
      checkpointId: "checkpoint",
      coveredEventCount: covered.length,
      throughEventId: covered.at(-1)!.eventId,
    });
    assert.equal((await run.readModelHistory()).length, 1);
    const persisted = await session.runtimeEventStore!.readSession(session.id);
    const oldFormat = persisted.map((event) =>
      event.kind === "context.checkpoint.recorded"
        ? {
            ...event,
            data: {
              ...event.data,
              summary: { role: "assistant" as const, content: "unmarked legacy summary" },
            },
          }
        : event,
    );
    assert.throws(() => materializeRuntimeHistoryEntries(oldFormat), /invalid sectioned summary/);
    // Once a source has been folded, a later transition must never rewrite that prefix.
    const transition = before.find((event) => event.kind === "tool.result.projection.recorded")!;
    assert.throws(
      () =>
        materializeRuntimeHistoryEntries([
          ...persisted,
          { ...transition, eventId: "late-transition" },
        ]),
      /invalid source or digest|outside current model history/,
    );
  });
  await session.recover();
  assert.equal(
    (await run.readModelHistory())[0]?.content,
    contextSummaryMessage("Archived the large result.").content,
  );
});

test("Tool projection active 2048/256 thresholds and stale two-user-turn protection", async (t) => {
  const { session, run } = await fixture(t);
  await run.run(async () => {
    await run.commitMessages(session, [{ role: "user", content: "first user turn" }]);
    await result(session, run, "old", "old".repeat(3000));
    await run.commitMessages(session, [{ role: "user", content: "second user turn" }]);
    await result(session, run, "recent", "recent".repeat(2000));
    await run.commitMessages(session, [{ role: "user", content: "third user turn" }]);
  });
  const next = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  next.setToolResultArchiveAvailable(true);
  await next.run(async () => {
    await next.prepareToolResultProjections({ stepNumber: 0, tools });
    const history = await next.readModelHistory();
    assert.match(history.find((m) => m.toolCallId === "old")!.content, /已归档/);
    assert.equal(history.find((m) => m.toolCallId === "recent")!.content, "recent".repeat(2000));
    await next.recordTurnStarted(0);
    await result(session, next, "duplicate1", "a".repeat(1024));
    await next.recordTurnStarted(1);
    await result(session, next, "duplicate2", "a".repeat(1024));
    await result(session, next, "boundary", "b".repeat(8190));
    await next.prepareToolResultProjections({ stepNumber: 2, tools });
    const projected = await next.readModelHistory();
    assert.match(projected.find((m) => m.toolCallId === "duplicate1")!.content, /exact_duplicate/);
    assert.equal(projected.find((m) => m.toolCallId === "duplicate2")!.content, "a".repeat(1024));
    assert.equal(projected.find((m) => m.toolCallId === "boundary")!.content, "b".repeat(8190));
    assert.equal(
      estimateMessagesTokens([
        { role: "user", content: "中" },
        { role: "assistant", content: "a" },
      ]),
      1,
    );
    assert.equal(
      estimateMessagesTokens([
        {
          role: "user",
          content: "abcd",
          toolCallId: "x",
          images: [{ type: "image_url", url: "https://example.com/image" }],
        },
      ]),
      2001,
    );
    const forkPort = createSessionForkRuntimePort();
    const seed = (await session.readDurableForkSnapshot()).runtimeSeedEntries;
    const fork = {
      sourceSessionId: session.id,
      targetSessionId: "small-archive-fork",
      operationId: "small-archive-fork",
      seedEntries: seed,
      workDir: session.workDir,
      runtimeAuthority: session.runtimeEventStore!,
      publication: { async assertOwned() {} },
    };
    await forkPort.bootstrapFork(fork);
    await forkPort.bootstrapFork(fork);
    const forkHistory = (
      await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, fork.targetSessionId)
    ).messages;
    const forked = forkHistory.find((message) => message.toolCallId === "duplicate1")!.content;
    assert.match(forked, /exact_duplicate/);
    const ref = forked.match(/pico:\/\/archive\/[^"\s]+/)![0];
    assert.equal(
      await bindToolResultArchiveReader(session.runtimeEventStore!, fork.targetSessionId).readRaw(
        ref,
      ),
      "a".repeat(1024),
    );
  });
});
