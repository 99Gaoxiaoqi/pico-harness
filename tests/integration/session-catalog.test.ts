import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCliSessionSummary, listCliSessionSummaries } from "../../src/cli/session-resolver.js";
import {
  RuntimeEventStore,
  readExistingRuntimeSessionProjection,
} from "../../src/storage/runtime-event-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { summaryFromRuntimeSession } from "../../src/engine/session-summary.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";

/**
 * 会话目录（catalog）集成测试：
 * 三方全等（catalog / B 批读现算）、损坏重建、水位兜底、写后立读、
 * deleteSession 行清理与幽灵行过滤。
 */

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly store: RuntimeEventStore;
  readonly catalogPath: () => string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-session-catalog-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const picoHome = join(root, "pico-home");
  const storageRoot = resolvePicoPaths(workspace, { picoHome }).workspace.root;
  return {
    root,
    workspace,
    picoHome,
    store: new RuntimeEventStore({ storageRoot }),
    catalogPath: () => join(storageRoot, "control", "session-catalog.json"),
  };
}

function event(input: {
  eventId: string;
  sessionId: string;
  runId: string;
  at: string;
  kind: RuntimeEvent["kind"];
  data: unknown;
  visibility?: RuntimeEvent["visibility"];
}): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId: input.eventId,
    sessionId: input.sessionId,
    invocationId: "inv-1",
    runId: input.runId,
    turnId: "turn-1",
    at: input.at,
    partial: false,
    visibility: input.visibility ?? "model",
    kind: input.kind,
    data: input.data,
  } as RuntimeEvent;
}

function userMessage(eventId: string, sessionId: string, at: string, content: string): RuntimeEvent {
  return event({
    eventId,
    sessionId,
    runId: "run-1",
    at,
    kind: "message.committed",
    data: { message: { role: "user", content } },
  });
}

async function seedSession(
  fixture: Fixture,
  sessionId: string,
  events: readonly RuntimeEvent[],
): Promise<void> {
  await fixture.store.initializeSession({ sessionId, workDir: fixture.workspace });
  if (events.length > 0) await fixture.store.appendBatch(events);
}

async function renameSession(fixture: Fixture, sessionId: string, title: string): Promise<void> {
  // settings 是整体替换语义：合法补丁必须携带完整 settings 对象。
  await fixture.store.appendSessionState(sessionId, {
    settings: {
      title,
      provider: "claude",
      model: "claude-sonnet-4",
      modelRouteId: "claude/claude-sonnet-4",
      mode: "default",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
  });
}

test("三方全等：catalog 行、批读现算、summaryFromRuntimeSession 口径一致", async () => {
  const fixture = await createFixture();
  try {
    const a = "catalog-consistency-a";
    const b = "catalog-consistency-b";
    await seedSession(fixture, a, [
      userMessage(`${a}-u1`, a, "2026-08-18T00:00:00.000Z", "第一条用户消息"),
      event({
        eventId: `${a}-m1`,
        sessionId: a,
        runId: "run-1",
        at: "2026-08-18T00:00:01.000Z",
        kind: "message.committed",
        data: { message: { role: "assistant", content: "回复一" } },
      }),
      // 隐藏消息：不计入 first/lastMessage，但计入 messageCount
      event({
        eventId: `${a}-h1`,
        sessionId: a,
        runId: "run-1",
        at: "2026-08-18T00:00:02.000Z",
        kind: "message.committed",
        data: {
          message: {
            role: "user",
            content: "[SYSTEM REMINDER 隐藏]",
          },
        },
      }),
    ]);
    // settings 标题：title 覆盖 firstMessage 回退
    await renameSession(fixture, a, "手工命名的会话");
    await fixture.store.appendBatch([
      userMessage(`${a}-u2`, a, "2026-08-18T00:00:04.000Z", "第二条用户消息"),
    ]);
    await seedSession(fixture, b, [userMessage(`${b}-u1`, b, "2026-08-18T01:00:00.000Z", "B 会话")]);

    // 路径 1：catalog（list/find 走的就是它）
    const listed = await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome });
    // 路径 2：B 批读 + 现算（readExistingRuntimeSessionProjection 为 daemon 同源读取）
    const fromLedger = new Map<string, ReturnType<typeof summaryFromRuntimeSession>>();
    for (const id of [a, b]) {
      const projection = await readExistingRuntimeSessionProjection({
        storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace.root,
        sessionId: id,
      });
      assert.ok(projection, `projection 应存在: ${id}`);
      fromLedger.set(id, summaryFromRuntimeSession(projection.manifest, projection.entries));
    }

    assert.equal(listed.length, 2);
    for (const id of [a, b]) {
      const row = listed.find((summary) => summary.id === id);
      const ledger = fromLedger.get(id)!.summary;
      assert.ok(row, `list 应包含 ${id}`);
      assert.equal(row.title, ledger.title, `${id} title`);
      assert.equal(row.messageCount, ledger.messageCount, `${id} messageCount`);
      assert.equal(row.firstMessage, ledger.firstMessage, `${id} firstMessage`);
      assert.equal(row.lastMessage, ledger.lastMessage, `${id} lastMessage`);
      assert.equal(row.updatedAt.getTime(), ledger.updatedAt.getTime(), `${id} updatedAt`);
    }
    const aRow = listed.find((summary) => summary.id === a)!;
    assert.equal(aRow.title, "手工命名的会话");
    assert.equal(aRow.firstMessage, "第一条用户消息");
    assert.equal(aRow.lastMessage, "第二条用户消息");
    assert.equal(aRow.messageCount, 4); // 含隐藏用户消息、assistant 与 settings 事件不计入
    // updatedAt = 最后事件时间
    assert.equal(aRow.updatedAt.toISOString(), "2026-08-18T00:00:04.000Z");

    const direct = await findCliSessionSummary(fixture.workspace, a, { picoHome: fixture.picoHome });
    assert.equal(direct?.title, aRow.title);
    assert.equal(direct?.messageCount, aRow.messageCount);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("catalog 缺失/损坏/版本不符 → 列表仍正确并自动重建", async () => {
  const fixture = await createFixture();
  try {
    const id = "catalog-rebuild";
    await seedSession(fixture, id, [userMessage(`${id}-u1`, id, "2026-08-18T00:00:00.000Z", "重建测试")]);
    const baseline = await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome });
    assert.equal(baseline.length, 1);

    // 1. 缺失
    await rm(fixture.catalogPath(), { force: true });
    assert.deepEqual(
      await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome }),
      baseline,
    );
    // 重建顺带落盘
    const afterMissing = await readFile(fixture.catalogPath(), "utf8");
    assert.ok(afterMissing.includes(id));

    // 2. 损坏 JSON
    await writeFile(fixture.catalogPath(), "{ not json", "utf8");
    assert.deepEqual(
      await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome }),
      baseline,
    );

    // 3. 版本不符
    await writeFile(
      fixture.catalogPath(),
      JSON.stringify({ schemaVersion: 999, sessions: {} }, null, 2),
      "utf8",
    );
    assert.deepEqual(
      await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome }),
      baseline,
    );
    // find 在 catalog 损坏时回落 A 路径仍正确
    const direct = await findCliSessionSummary(fixture.workspace, id, { picoHome: fixture.picoHome });
    assert.equal(direct?.title, "重建测试");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("写后立读：create→find、settings 改名→find 新标题、append→find 新计数", async () => {
  const fixture = await createFixture();
  try {
    const id = "catalog-write-then-read";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    let found = await findCliSessionSummary(fixture.workspace, id, { picoHome: fixture.picoHome });
    assert.ok(found, "initialize 后立即可见");
    assert.equal(found.messageCount, 0);

    await fixture.store.appendBatch([
      userMessage(`${id}-u1`, id, "2026-08-18T00:00:00.000Z", "初始消息"),
    ]);
    found = await findCliSessionSummary(fixture.workspace, id, { picoHome: fixture.picoHome });
    assert.equal(found?.messageCount, 1);
    assert.equal(found?.title, "初始消息");

    await renameSession(fixture, id, "改名后的标题");
    found = await findCliSessionSummary(fixture.workspace, id, { picoHome: fixture.picoHome });
    assert.equal(found?.title, "改名后的标题");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deleteSession 行清理 + 幽灵行被列表过滤 + find 水位兜底", async () => {
  const fixture = await createFixture();
  try {
    const keep = "catalog-delete-keep";
    const drop = "catalog-delete-drop";
    await seedSession(fixture, keep, [userMessage(`${keep}-u1`, keep, "2026-08-18T00:00:00.000Z", "保留")]);
    await seedSession(fixture, drop, [userMessage(`${drop}-u1`, drop, "2026-08-18T01:00:00.000Z", "删除")]);

    const deleted = await fixture.store.deleteSession(drop);
    assert.equal(deleted, true);
    const listed = await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, keep);
    assert.equal(await findCliSessionSummary(fixture.workspace, drop, { picoHome: fixture.picoHome }), undefined);

    // 模拟 deleteSession 崩溃窗口：手工把被删会话的行塞回 catalog（ledger 已不存在）
    const catalogText = await readFile(fixture.catalogPath(), "utf8");
    const tampered = JSON.parse(catalogText) as {
      schemaVersion: number;
      sessions: Record<string, unknown>;
    };
    tampered.sessions[drop] = {
      summary: {
        id: drop,
        cwd: fixture.workspace,
        createdAt: "2026-08-18T01:00:00.000Z",
        updatedAt: "2026-08-18T01:00:00.000Z",
      },
      headSequence: 1,
      ledgerByteLength: 1,
      hasForkFacts: false,
      completedBootstrap: false,
    };
    await writeFile(fixture.catalogPath(), JSON.stringify(tampered, null, 2), "utf8");

    // list：幽灵行被 readdir 存在性过滤
    const afterGhost = await listCliSessionSummaries(fixture.workspace, { picoHome: fixture.picoHome });
    assert.equal(afterGhost.length, 1);
    assert.equal(afterGhost[0]?.id, keep);
    // find：水位校验（ledger 缺失）回落 A 路径 → undefined
    assert.equal(
      await findCliSessionSummary(fixture.workspace, drop, { picoHome: fixture.picoHome }),
      undefined,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("水位不符：catalog 行陈旧时 find 回落现算并返回新鲜摘要", async () => {
  const fixture = await createFixture();
  try {
    const id = "catalog-stale-row";
    await seedSession(fixture, id, [userMessage(`${id}-u1`, id, "2026-08-18T00:00:00.000Z", "旧消息")]);
    const staleCatalog = await readFile(fixture.catalogPath(), "utf8");

    await fixture.store.appendBatch([
      userMessage(`${id}-u2`, id, "2026-08-18T00:00:09.000Z", "新消息"),
    ]);

    // 手工回滚 catalog 到追加前（模拟任何原因的行陈旧）
    await writeFile(fixture.catalogPath(), staleCatalog, "utf8");

    const found = await findCliSessionSummary(fixture.workspace, id, { picoHome: fixture.picoHome });
    assert.equal(found?.messageCount, 2, "find 应回落现算拿到新计数");
    assert.equal(found?.lastMessage, "新消息");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
