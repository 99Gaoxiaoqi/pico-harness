import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRuntimeNotification, parseRuntimeResult } from "@pico/protocol";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createSessionForkRuntimePort } from "@pico/pico-host/session-fork-runtime-port-adapter";
import { ingestDesktopRuntimeNotification } from "@pico/pico-host/desktop-transcript-persistence";
import { projectTranscriptEvents } from "@pico/pico-host/transcript-event-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { operationalDatabasePath } from "@pico/storage";
import type { RuntimeTranscriptProjectionPage } from "@pico/storage/runtime-event-store-contracts";

function validatePage(page: RuntimeTranscriptProjectionPage): void {
  parseRuntimeResult("session.transcript.page", {
    watermark: page.watermark,
    items: page.items.map(({ payload, ...record }) => ({ ...record, item: payload })),
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? "旧" : "新"}取消记录重开后可读取并继续，真实失败信息保留`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-cancel-history-"));
    const options = {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    };
    let session = new Session("cancel-history", root, options);
    context.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    for (const [index, status] of (["cancelled", "failed"] as const).entries()) {
      const error = status === "cancelled" ? "cancelled by user" : "provider failed";
      if (legacy) {
        await session.recordTranscriptEvent({
          eventId: `legacy-${status}`,
          sequence: index + 1,
          createdAt: index + 2,
          type: "entry.appended",
          entryId: `legacy-${status}`,
          entry: {
            kind: "run-boundary",
            runId: status,
            status,
            startedAt: 1,
            finishedAt: 2,
            error,
          },
        });
      } else {
        await ingestDesktopRuntimeNotification(
          session,
          createRuntimeNotification({
            eventId: `notify-${status}`,
            topic: "run.finished",
            scope: { workspacePath: root, sessionId: session.id, runId: status },
            resourceVersion: 1,
            at: index + 2,
            payload: {
              run: {
                runId: status,
                sessionId: session.id,
                status,
                version: 1,
                startedAt: 1,
                finishedAt: 2,
                error,
              },
            },
          }),
          projectTranscriptEvents,
        );
      }
    }
    const storageRoot = session.runtimeEventStore!.storageRoot;
    if (!legacy) {
      const snapshot = await session.readHydrationSnapshot();
      const cancelled = snapshot.transcriptEvents.find(
        (event) =>
          event.type === "entry.appended" &&
          event.entry.kind === "run-boundary" &&
          event.entry.status === "cancelled",
      );
      assert.ok(cancelled?.type === "entry.appended" && cancelled.entry.kind === "run-boundary");
      assert.equal(cancelled.entry.error, undefined);
    }
    await session.close();
    if (legacy) {
      const database = new DatabaseSync(operationalDatabasePath(storageRoot));
      try {
        // Reproduce the actual v5 cache, including its rejected cancelled error.
        const row = database
          .prepare(
            "SELECT item_id, payload_json FROM runtime_transcript_item_versions WHERE session_id = ? AND item_id = 'entry:legacy-cancelled'",
          )
          .get(session.id) as { item_id: string; payload_json: string };
        const payload = JSON.stringify({
          ...JSON.parse(row.payload_json),
          error: "cancelled by user",
        });
        database
          .prepare(
            "UPDATE runtime_transcript_item_versions SET payload_json = ?, payload_digest = ? WHERE session_id = ? AND item_id = ?",
          )
          .run(
            payload,
            createHash("sha256").update(payload).digest("hex"),
            session.id,
            row.item_id,
          );
        database
          .prepare(
            "UPDATE runtime_transcript_projection_state SET projector_version = 5 WHERE session_id = ?",
          )
          .run(session.id);
      } finally {
        database.close();
      }
    }
    session = new Session("cancel-history", root, options);
    await session.recover();
    const store = session.runtimeEventStore!;
    const page = await store.readTranscriptProjectionPage({
      sessionId: session.id,
      maxBytes: 64 * 1024,
    });
    validatePage(page);
    const boundaries = page.items.map(
      ({ payload }) => payload as { status: string; error?: string },
    );
    assert.equal(boundaries.find((item) => item.status === "cancelled")?.error, undefined);
    assert.equal(boundaries.find((item) => item.status === "failed")?.error, "provider failed");
    if (legacy) {
      assert.match(
        JSON.stringify(await store.readSession(session.id)),
        /cancelled by user/u,
        "兼容读取不改写旧事实",
      );
    }
    await session.commitMessages(
      { role: "user", content: "继续" },
      { role: "assistant", content: "已继续" },
    );
    const continued = await store.readTranscriptProjectionPage({
      sessionId: session.id,
      maxBytes: 64 * 1024,
    });
    validatePage(continued);
    assert.match(JSON.stringify(continued.items), /已继续/u);
    assert.equal(
      continued.watermark.historyEpoch,
      page.watermark.historyEpoch,
      "后续追加不重复重建",
    );
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? "旧投影重建" : "新分叉"}保留多轮回答与推理顺序且重试不重复`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-fork-history-"));
    const source = new Session("source", root, {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    });
    let reopened: SqliteRuntimeEventStore | undefined = undefined;
    context.after(async () => {
      reopened?.close();
      await source.close();
      await rm(root, { recursive: true, force: true });
    });
    await source.recover();
    for (let round = 1; round <= 3; round++) {
      await source.commitMessages({ role: "user", content: `问题${round}` });
      if (round === 2) {
        const intermediate = {
          role: "assistant" as const,
          content: "中间步骤",
          reasoning: "步骤推理",
        };
        await source.commitMessageOnce("intermediate-step", intermediate);
        await source.commitMessageOnce("intermediate-step", intermediate);
      }
      await source.commitMessages({
        role: "assistant",
        content: `回答${round}`,
        reasoning: `推理${round}`,
      });
    }
    const store = source.runtimeEventStore!;
    const port = createSessionForkRuntimePort();
    const bootstrap = {
      sourceSessionId: source.id,
      targetSessionId: "fork",
      operationId: "history-fork",
      operationCreatedAt: "2026-09-15T00:00:00.000Z",
      seedEntries: (await source.readDurableForkSnapshot()).runtimeSeedEntries,
      workDir: root,
      runtimeAuthority: store,
      publication: { async assertOwned() {} },
    };
    await port.bootstrapFork(bootstrap);
    const originalEvents = await store.readSession("fork");
    await port.bootstrapFork(bootstrap);
    assert.deepEqual(await store.readSession("fork"), originalEvents);
    const firstPage = await store.readTranscriptProjectionPage({
      sessionId: "fork",
      maxBytes: 64 * 1024,
    });
    const storageRoot = store.storageRoot;
    await source.close();
    if (legacy) {
      const database = new DatabaseSync(operationalDatabasePath(storageRoot));
      try {
        // v5 retained only the final assistant/thinking versions in this bootstrap turn.
        database
          .prepare(
            "DELETE FROM runtime_transcript_item_versions WHERE session_id = 'fork' AND json_extract(payload_json, '$.kind') IN ('assistantMessage', 'thinking') AND json_extract(payload_json, '$.content') NOT IN ('回答3', '推理3')",
          )
          .run();
        database
          .prepare(
            "UPDATE runtime_transcript_projection_state SET projector_version = 5 WHERE session_id = 'fork'",
          )
          .run();
      } finally {
        database.close();
      }
    }
    reopened = new SqliteRuntimeEventStore({ storageRoot });
    const page = await reopened.readTranscriptProjectionPage({
      sessionId: "fork",
      maxBytes: 64 * 1024,
    });
    validatePage(page);
    assert.deepEqual(
      page.items.map(({ payload }) => (payload as { content: string }).content),
      [
        "问题1",
        "推理1",
        "回答1",
        "问题2",
        "步骤推理",
        "中间步骤",
        "推理2",
        "回答2",
        "问题3",
        "推理3",
        "回答3",
      ],
    );
    assert.equal(new Set(page.items.map((item) => item.itemId)).size, 11);
    assert.deepEqual(
      await reopened.readSession("fork"),
      originalEvents,
      "重建不改写不可变分叉事实",
    );
    assert.equal(page.watermark.historyEpoch === firstPage.watermark.historyEpoch, !legacy);
    assert.deepEqual(
      await reopened.readTranscriptProjectionPage({ sessionId: "fork", maxBytes: 64 * 1024 }),
      page,
      "再次读取复用投影和epoch",
    );
  });
}
