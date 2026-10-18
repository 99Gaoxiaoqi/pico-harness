import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeResult,
  type RuntimeRun,
  type RuntimeSession,
} from "../../../packages/protocol/src/mobile.js";
import { buildSessionActivityList } from "../../../apps/mobile/src/screens/session-activity.js";

test("手机使用会话与工作区运行快照排序需检查任务，保留真实归档和未知状态", () => {
  const session = (sessionId: string, extra: Partial<RuntimeSession> = {}): RuntimeSession => ({
    sessionId,
    workspacePath: "/project",
    title: `任务 ${sessionId}`,
    status: "active",
    pinned: false,
    createdAt: 1,
    updatedAt: 10,
    ...extra,
  });
  const run = (
    sessionId: string,
    status: RuntimeRun["status"],
    extra: Partial<RuntimeRun> = {},
  ): RuntimeRun => ({
    runId: `run-${sessionId}`,
    sessionId,
    workspacePath: "/project",
    description: "整理资料",
    status,
    startedAt: 10,
    updatedAt: 20,
    version: 1,
    ...extra,
  });
  // Feed the same validated wire contracts consumed by the mobile remote client.
  const { sessions } = parseRuntimeResult("session.list", {
    sessions: [
      session("idle", { pinned: true, updatedAt: 99 }),
      session("success"),
      session("failed"),
      session("running"),
      session("paused", { pinned: true }),
      session("queued"),
      session("archived", { status: "archived", pinned: true }),
      session("same-id-elsewhere"),
    ],
  });
  const { runs } = parseRuntimeResult("runs.list", {
    runs: [
      run("success", "succeeded", { startedAt: 30, updatedAt: 40 }),
      run("success", "failed", { runId: "older-failure", updatedAt: 90 }),
      run("failed", "failed", { error: "模型连接失败" }),
      run("running", "running"),
      run("paused", "paused"),
      run("queued", "queued", { updatedAt: 15 }),
      run("archived", "failed"),
      run("same-id-elsewhere", "running", { workspacePath: "/another-project" }),
      {
        runId: "workspace-only",
        workspacePath: "/project",
        description: "工作区任务",
        status: "running",
        startedAt: 10,
        updatedAt: 20,
        version: 1,
      },
    ],
  });
  const result = buildSessionActivityList({ sessions, runs });
  assert.deepEqual(
    result.items.map((item) => item.session.sessionId),
    ["paused", "failed", "running", "queued", "idle", "success", "same-id-elsewhere"],
  );
  assert.deepEqual(result.counts, { 全部: 7, 需检查: 2, 进行中: 2, 最近: 3 });
  assert.equal(result.summary, "2 个需检查 · 2 个进行中 · 3 个最近会话");
  assert.equal(result.items[1]?.summary, "模型连接失败");
  assert.equal(result.items.find((item) => item.session.sessionId === "success")?.label, "已完成");
  assert.equal(
    result.items.find((item) => item.session.sessionId === "idle")?.summary,
    "暂无运行记录",
  );
  assert.deepEqual(
    buildSessionActivityList({ sessions, runs, filter: "需检查" }).items.map(
      (item) => item.session.sessionId,
    ),
    ["paused", "failed"],
  );
  const searched = buildSessionActivityList({ sessions, runs, query: " FAILED " });
  assert.deepEqual(
    searched.items.map((item) => item.session.sessionId),
    ["failed"],
  );
  assert.equal(searched.counts.全部, 1);
  const all = buildSessionActivityList({ sessions, runs, includeArchived: true });
  assert.equal(all.items.at(-1)?.group, "已归档");
  assert.equal(all.counts.需检查, 2);
  assert.equal(all.counts.全部, 8);
  assert.equal(all.summary, "2 个需检查 · 2 个进行中 · 3 个最近会话 · 1 个已归档");

  const unknown = buildSessionActivityList({ sessions });
  assert.equal(unknown.activityKnown, false);
  assert.equal(unknown.counts.进行中, 0);
  assert.equal(unknown.counts.需检查, 0);
  assert.equal(unknown.summary, "共 7 个会话 · 运行状态暂不可用");
  assert.ok(unknown.items.every((item) => item.label === "最近会话"));
  assert.ok(unknown.items.every((item) => item.summary === "运行状态暂不可用"));
  assert.equal(buildSessionActivityList({ sessions, runs: [] }).activityKnown, true);
  // The original server responses remain reusable by the screen and event refreshes.
  assert.equal(sessions[0]?.sessionId, "idle");
  assert.equal(runs[0]?.status, "succeeded");
});
