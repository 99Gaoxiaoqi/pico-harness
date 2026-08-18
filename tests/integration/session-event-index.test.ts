import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCliSessionSummary } from "../../src/cli/session-resolver.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { summaryFromRuntimeSession } from "../../src/engine/session-summary.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";

/**
 * 事件索引边车 + 写路径瘦身集成测试：
 * 深历史重放幂等、同 id 异载荷 fail-closed、索引删/坏重建、planOperation
 * 重放、catalog 行折叠等价。
 */

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly store: RuntimeEventStore;
  readonly indexPath: (sessionId: string) => string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-event-index-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const storageRoot = resolvePicoPaths(workspace).workspace.root;
  const { createHash: hash } = await import("node:crypto");
  return {
    root,
    workspace,
    store: new RuntimeEventStore({ storageRoot }),
    indexPath: (sessionId) =>
      join(
        storageRoot,
        "sessions",
        hash("sha256").update(sessionId).digest("hex"),
        "events.index.jsonl",
      ),
  };
}

function userMessage(eventId: string, sessionId: string, at: string, content: string): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
    at,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  } as RuntimeEvent;
}

test("深历史重放幂等 + 同 id 异载荷 fail-closed + 索引删/坏重建", async () => {
  const fixture = await createFixture();
  try {
    const id = "index-replay";
    const events = [1, 2, 3, 4, 5].map((n) =>
      userMessage(`${id}-e${n}`, id, `2026-08-18T00:00:0${n}.000Z`, `消息${n}`),
    );
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    // 分五批追加，制造深历史
    for (const event of events) {
      await fixture.store.appendBatch([event]);
    }

    // 深历史重放：最老的事件 e1 幂等返回
    const replay = await fixture.store.appendBatch([events[0]!]);
    assert.equal(replay[0]?.inserted, false);
    assert.equal(replay[0]?.cursor.seq, 1);

    // 同 id 异载荷：fail-closed
    const mutated = { ...events[0]!, data: { message: { role: "user", content: "篡改" } } };
    await assert.rejects(
      () => fixture.store.appendBatch([mutated as RuntimeEvent]),
      /already bound to another payload/,
    );

    // 删除索引后，重放仍幂等（触发 ledger 全量重建索引）
    await rm(fixture.indexPath(id), { force: true });
    const replayAfterRebuild = await fixture.store.appendBatch([events[2]!]);
    assert.equal(replayAfterRebuild[0]?.inserted, false);
    assert.equal(replayAfterRebuild[0]?.cursor.seq, 3);

    // 索引损坏后，追加新事件成功且旧去重语义保持
    await writeFile(fixture.indexPath(id), "{ broken", "utf8");
    const replayAfterCorrupt = await fixture.store.appendBatch([events[4]!]);
    assert.equal(replayAfterCorrupt[0]?.inserted, false);
    const appended = await fixture.store.appendBatch([
      userMessage(`${id}-e6`, id, "2026-08-18T00:00:06.000Z", "新消息"),
    ]);
    assert.equal(appended[0]?.inserted, true);
    assert.equal(appended[0]?.cursor.seq, 6);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planOperation 重放幂等 + 指纹冲突 fail-closed", async () => {
  const fixture = await createFixture();
  try {
    const id = "index-planop";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const fingerprint = `sha256:${createHash("sha256").update("op").digest("hex")}`;
    const opEvent: RuntimeEvent = {
      schemaVersion: 2,
      eventId: `${id}-graph-1`,
      sessionId: id,
      invocationId: "inv-1",
      runId: "run-graph",
      turnId: "turn-1",
      at: "2026-08-18T00:00:00.000Z",
      partial: false,
      visibility: "internal",
      kind: "graph.work.added",
      data: {
        operationId: "op-1",
        fingerprint,
        graphId: "graph-1",
        workId: "work-1",
        instruction: "做一件事",
        inputIds: [],
        mode: "worker",
      },
    } as RuntimeEvent;

    const first = await fixture.store.appendPlanOperation([opEvent], {
      operationId: "op-1",
      fingerprint,
      expectedSessionSequence: 0,
    });
    assert.equal(first[0]?.inserted, true);

    // 同 opId 同指纹重放：幂等（走索引查重，不落盘）
    const replay = await fixture.store.appendPlanOperation([opEvent], {
      operationId: "op-1",
      fingerprint,
      expectedSessionSequence: 0,
    });
    assert.equal(replay[0]?.inserted, false);

    // 同 opId 异指纹：冲突
    const otherFingerprint = `sha256:${createHash("sha256").update("other").digest("hex")}`;
    await assert.rejects(
      () =>
        fixture.store.appendPlanOperation([opEvent], {
          operationId: "op-1",
          fingerprint: otherFingerprint,
          expectedSessionSequence: 0,
        }),
      /Plan operation/,
    );

    // 索引删除后重放仍幂等（重建后 operationId 可查）
    await rm(fixture.indexPath(id), { force: true });
    const replayAfterRebuild = await fixture.store.appendPlanOperation([opEvent], {
      operationId: "op-1",
      fingerprint,
      expectedSessionSequence: 0,
    });
    assert.equal(replayAfterRebuild[0]?.inserted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("catalog 行折叠等价：多批追加+改名+清标题后与全量现算一致", async () => {
  const fixture = await createFixture();
  try {
    const id = "index-fold-equivalence";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const fullSettings = {
      provider: "claude",
      model: "claude-sonnet-4",
      modelRouteId: "claude/claude-sonnet-4",
      mode: "default",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    } as const;
    await fixture.store.appendBatch([
      userMessage(`${id}-u1`, id, "2026-08-18T00:00:00.000Z", "第一条"),
    ]);
    await fixture.store.appendSessionState(id, { settings: { ...fullSettings, title: "标题A" } });
    await fixture.store.appendBatch([
      userMessage(`${id}-u2`, id, "2026-08-18T00:00:02.000Z", "第二条"),
    ]);
    // 清标题：整体替换语义下回退 firstMessage
    await fixture.store.appendSessionState(id, { settings: { ...fullSettings } });

    const fromCatalog = await findCliSessionSummary(fixture.workspace, id);
    const projection = await fixture.store.readSessionManifest(id);
    assert.ok(projection);
    const entries = await fixture.store.readSessionEntries(id);
    const fromLedger = summaryFromRuntimeSession(projection, entries).summary;

    assert.equal(fromCatalog?.title, fromLedger.title);
    assert.equal(fromCatalog?.title, "第一条", "清标题后回退 firstMessage");
    assert.equal(fromCatalog?.messageCount, fromLedger.messageCount);
    assert.equal(fromCatalog?.lastMessage, fromLedger.lastMessage);
    assert.equal(fromCatalog?.updatedAt.getTime(), fromLedger.updatedAt.getTime());
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
