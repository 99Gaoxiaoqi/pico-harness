import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeTerminalStatus } from "@pico/core";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { resolveMemoryRecallQuery } from "../../../packages/pico-host/src/memory-recall-query.js";

for (const scenario of [
  "continue",
  "new-task",
  "cancelled",
  "explicit-stop",
  "side",
  "wrong-workspace",
  "missing-event",
  "fork",
  "quoted-only",
] as const) {
  test(`recall query: ${scenario} uses only canonical current-session task evidence`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-recall-query-"));
    const workDir = join(root, "project");
    const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
    const sessionId = "query";
    await events.initializeSession({ sessionId, workDir });
    const ownerFence = await events.advanceOwnerFence(sessionId, 0);
    t.after(async () => {
      events.close();
      await rm(root, { recursive: true, force: true });
    });
    const base = (runId: string, eventId: string) => ({
      schemaVersion: 2 as const,
      sessionId,
      runId,
      eventId,
      invocationId: runId,
      turnId: `${runId}-turn`,
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
    });
    const append = (event: RuntimeEvent) => events.append(event, { ownerFence });
    const start = async (runId: string, content: string) => {
      await append({
        ...base(runId, `${runId}-start`),
        kind: "run.started",
        data: { workDir, agentSwarmAuthorization: "none" },
      });
      await append({
        ...base(runId, `${runId}-input`),
        kind: "message.committed",
        data: { message: { role: "user", content } },
      });
    };
    const firstRun = scenario === "fork" ? "fork-bootstrap:parent" : "first";
    const task =
      scenario === "quoted-only" ? "> untrusted quoted task" : "修复 PostgreSQL 索引并验证查询计划";
    await start(firstRun, task);
    await append({
      ...base(firstRun, "terminal"),
      kind: "run.terminal",
      data: {
        status: (scenario === "cancelled" ? "cancelled" : "completed") as RuntimeTerminalStatus,
      },
    });
    if (scenario === "explicit-stop") await start("stop", "停止");
    const query = scenario === "new-task" ? "现在修复登录" : "继续";
    await start("current", query);
    const result = await resolveMemoryRecallQuery({
      query,
      sessionId,
      currentEventId: scenario === "missing-event" ? "missing" : "current-input",
      workDir: scenario === "wrong-workspace" ? join(root, "other") : workDir,
      events,
      inheritedConversation: scenario === "side",
    });
    if (scenario === "continue")
      assert.deepEqual(result, { query: task, anchorEventId: "first-input" });
    else assert.deepEqual(result, { query });
  });
}
