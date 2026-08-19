import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCliSessionSummary, listCliSessionSummaries } from "../../src/cli/session-resolver.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";

/**
 * 窄路径集成测试：findCliSessionSummary（requireSession 的单会话直读路径）
 * 与 listCliSessionSummaries 在同一真实存储上产出一致的摘要，且对
 * 不存在的会话返回 undefined（保持 NOT_FOUND 语义）。
 */
test("findCliSessionSummary 单会话直读与全列表摘要一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-cli-session-resolver-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const picoHome = join(root, "pico-home");
  const eventStore = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workspace, { picoHome }).workspace.root,
  });

  try {
    const sessionIds = ["resolver-session-a", "resolver-session-b"];
    for (const [index, sessionId] of sessionIds.entries()) {
      await eventStore.initializeSession({ sessionId, workDir: workspace });
      const events: RuntimeEvent[] = [
        {
          schemaVersion: 2,
          eventId: `${sessionId}-evt-1`,
          sessionId,
          invocationId: "inv-1",
          runId: `run-${index}`,
          turnId: "turn-1",
          at: `2026-08-18T00:00:0${index}.000Z`,
          partial: false,
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "user", content: `会话 ${sessionId} 的第一条消息` } },
        } as RuntimeEvent,
        {
          schemaVersion: 2,
          eventId: `${sessionId}-evt-2`,
          sessionId,
          invocationId: "inv-1",
          runId: `run-${index}`,
          turnId: "turn-1",
          at: `2026-08-18T00:00:1${index}.000Z`,
          partial: false,
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "assistant", content: `会话 ${sessionId} 的回复` } },
        } as RuntimeEvent,
      ];
      await eventStore.appendBatch(events);
    }

    const summaries = await listCliSessionSummaries(workspace, { picoHome });
    assert.equal(summaries.length, 2);

    for (const sessionId of sessionIds) {
      const fromList = summaries.find((summary) => summary.id === sessionId);
      assert.ok(fromList, `list 应包含 ${sessionId}`);
      const direct = await findCliSessionSummary(workspace, sessionId, { picoHome });
      assert.ok(direct, `直读应找到 ${sessionId}`);
      assert.equal(direct.messageCount, fromList.messageCount);
      assert.equal(direct.title, fromList.title);
      assert.equal(direct.logId, sessionId);
      assert.equal(
        direct.updatedAt.getTime(),
        fromList.updatedAt.getTime(),
        "updatedAt 应与全列表口径一致",
      );
    }

    assert.equal(
      await findCliSessionSummary(workspace, "no-such-session", { picoHome }),
      undefined,
      "不存在的会话应返回 undefined（requireSession 据此抛 NOT_FOUND）",
    );
  } finally {
    eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
