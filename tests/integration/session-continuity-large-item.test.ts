import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_RUNTIME_FRAME_BYTES,
  parseDesktopRuntimeResult,
  type RuntimeSession,
  type RuntimeTranscriptItemFragment,
  type RuntimeTranscriptItemRecord,
  type RuntimeTranscriptWatermark,
} from "@pico/protocol";
import { TranscriptReplica } from "@pico/transcript-replica";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import { SqliteSessionContinuitySource } from "../../src/daemon/sqlite-session-continuity-source.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

function message(
  eventId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  turnId: string,
): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "invocation-large-item",
    runId: "run-large-item",
    turnId,
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role, content } },
  };
}

test("continuity source and replica reassemble oversized UTF-8 open/page/advance items", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-continuity-large-item-"));
  const workspacePath = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  mkdirSync(workspacePath, { recursive: true });
  const sessionId = "large-item-session";
  const storageRoot = resolvePicoPaths(workspacePath, { picoHome }).workspace.root;
  const store = new SqliteRuntimeEventStore({ storageRoot });
  const session = {
    sessionId,
    workspacePath,
    title: "Large transcript",
    status: "active",
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
  } as RuntimeSession;
  const source = new SqliteSessionContinuitySource({
    picoHome,
    readMetadata: async () => ({ session, queuedInputs: [] }),
  });
  try {
    await store.initializeSession({ sessionId, workDir: workspacePath });
    await store.append(message("older", sessionId, "user", "older", "turn-older"));
    const openContent = "你🙂好🌍".repeat(1_500);
    await store.append(
      message("open-large", sessionId, "assistant", openContent, "turn-open-large"),
    );

    const openSnapshot = await source.readOpenSnapshot({
      workspacePath,
      sessionId,
      tailLimit: 2,
      maxBytes: 1_024,
    });
    assert.equal(openSnapshot.durableTail.length, 0);
    assert.equal(openSnapshot.durableTailFragments?.length, 1);
    assert.ok(openSnapshot.olderCursor);
    assert.ok(
      Buffer.byteLength(JSON.stringify(openSnapshot)) < MAX_RUNTIME_FRAME_BYTES,
      "oversized open tail must remain below one Runtime frame",
    );

    const replica = new TranscriptReplica(sessionId);
    const openToken = replica.beginOpen();
    const openResult = parseDesktopRuntimeResult("session.subscription.open", {
      ...openSnapshot,
      hostEpoch: "host-large-item",
      subscriptionId: "subscription-large-item",
      nextSequence: 1,
    });
    assert.equal(replica.installOpen(openToken, openResult), true);
    assert.deepEqual(replica.view.records, [], "partial open fragment must not leak as a record");

    const pageOffsets = new Map<string, number>();
    inspectFragments(openSnapshot.durableTailFragments ?? [], pageOffsets);
    let olderRequest = replica.beginOlderPage();
    let olderPages = 0;
    while (olderRequest) {
      const page = parseDesktopRuntimeResult(
        "session.transcript.page",
        await source.readTranscriptPage({
          workspacePath,
          sessionId,
          through: olderRequest.through,
          cursor: olderRequest.cursor,
          limit: 2,
          maxBytes: 1_024,
        }),
      );
      inspectFragments(page.fragments ?? [], pageOffsets);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_RUNTIME_FRAME_BYTES);
      assert.equal(replica.applyOlderPage(olderRequest, page), "applied");
      olderRequest = replica.beginOlderPage();
      olderPages += 1;
      assert.ok(olderPages < 100, "older fragment cursor must make progress");
    }
    assert.ok(olderPages > 2);
    assert.deepEqual(
      replica.view.records.map(({ itemId }) => itemId),
      ["message:older:user", "message:turn-open-large:assistant"],
    );
    const openRecord = replica.view.records[1];
    assert.equal(assistantContent(openRecord), openContent);

    const advanceContent = "漢字🤖字节".repeat(1_600);
    const appended = await store.append(
      message("advance-large", sessionId, "assistant", advanceContent, "turn-advance-large"),
    );
    assert.ok(appended.transcriptWatermark);
    const advanceWatermark: RuntimeTranscriptWatermark = {
      historyEpoch: appended.transcriptWatermark.historyEpoch,
      projectorVersion: appended.transcriptWatermark.projectorVersion,
      throughSequence: appended.transcriptWatermark.throughSequence,
    };
    const advanceRequest = replica.beginAdvance(advanceWatermark);
    assert.ok(advanceRequest);
    let request = advanceRequest;
    const advanceOffsets = new Map<string, number>();
    let advancePages = 0;
    for (;;) {
      const page = parseDesktopRuntimeResult(
        "session.transcript.advance",
        await source.readTranscriptAdvance({
          workspacePath,
          sessionId,
          after: request.after,
          through: request.through,
          ...(request.cursor ? { cursor: request.cursor } : {}),
          limit: 2,
          maxBytes: 1_024,
        }),
      );
      inspectFragments(page.fragments ?? [], advanceOffsets);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_RUNTIME_FRAME_BYTES);
      const outcome = replica.applyAdvancePage(request, page);
      advancePages += 1;
      assert.ok(advancePages < 100, "advance fragment cursor must make progress");
      if (outcome.kind === "next") {
        assert.equal(
          replica.view.records.some(
            ({ itemId }) => itemId === "message:turn-advance-large:assistant",
          ),
          false,
          "no advance fragment may become visible before the final page succeeds",
        );
        request = outcome.request;
        continue;
      }
      assert.deepEqual(outcome, { kind: "applied" });
      break;
    }
    assert.ok(advancePages > 2);
    const advanceRecord = replica.view.records.at(-1);
    assert.equal(assistantContent(advanceRecord), advanceContent);
    assert.deepEqual(replica.view.watermark, advanceWatermark);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function inspectFragments(
  fragments: readonly RuntimeTranscriptItemFragment[],
  offsets: Map<string, number>,
): void {
  for (const fragment of fragments) {
    const expected = offsets.get(fragment.itemId) ?? 0;
    assert.equal(fragment.byteOffset, expected, "fragment ranges must be contiguous");
    assert.equal(Buffer.byteLength(fragment.json), fragment.byteLength);
    offsets.set(fragment.itemId, expected + fragment.byteLength);
  }
}

function assistantContent(record: RuntimeTranscriptItemRecord | undefined): string | undefined {
  return record?.item.kind === "assistantMessage" ? record.item.content : undefined;
}
