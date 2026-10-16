import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TaskExperienceCandidate } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { executeAgentRuntime } from "../../../packages/pico-host/src/agent-runtime.js";
import { WorkspaceTrustStore } from "../../../packages/pico-host/src/workspace-trust.js";
import { resolvePicoPaths } from "../../../packages/pico-host/src/pico-paths.js";
import { globalSessionManager } from "../../../packages/pico-host/src/session.js";
import { closeExecutionLearningWorker } from "../../../packages/pico-host/src/execution-learning-worker.js";

test("Host memory_search case branch records actual case carrier without adoption or a Memory Item", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-case-host-")));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "case-host";
  await mkdir(workDir);
  await mkdir(picoHome);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const lifecycle = new AtomicMemoryLifecycle();
  t.after(async () => {
    await lifecycle.close();
    await closeExecutionLearningWorker(picoHome);
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const settings = await store.readSettings(paths.workspace.id);
  await store.updateSettings({
    workspaceKey: paths.workspace.id,
    expectedVersion: settings.version,
    autoExtract: false,
  });
  const candidate: TaskExperienceCandidate = {
    candidateId: "nebula-case",
    contentVersion: 1,
    recordRevision: 1,
    representation: "case",
    usagePolicy: "case_only",
    kind: "task-lesson",
    state: "saved",
    lifecycleState: "active",
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    requiredConditions: [],
    matchHints: ["Nebula"],
    goal: "Nebula history",
    content: "Nebula historical marker: CASE-CARRIER-417.",
    taskId: "historical-task",
    taskVersion: 1,
    workspaceKey: paths.workspace.id,
    workDir,
    sessionId: "historical-session",
    runId: "historical-run",
    failureKey: "nebula-failure",
    inputEpoch: 0,
    settingsVersion: 1,
    deletionRevision: 0,
    sources: [],
    observationIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
  db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    candidate.candidateId,
    paths.workspace.id,
    candidate.sessionId,
    candidate.runId,
    candidate.failureKey,
    candidate.state,
    1,
    null,
    1,
    JSON.stringify(candidate),
  );
  let turn = 0;
  await executeAgentRuntime(
    {
      prompt: "搜索Nebula历史案例。",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "fixture/model",
      permissionMode: "full-access",
      allowedTools: ["memory_search"],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      reporter: new SilentReporter(),
      atomicMemoryLifecycle: lifecycle,
      provider: {
        generate: async (messages) => {
          if (turn++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "case-search",
                  name: "memory_search",
                  arguments: JSON.stringify({ query: "Nebula", record_type: "case" }),
                },
              ],
            };
          assert.ok(
            messages.some(
              (message) =>
                message.toolCallId === "case-search" &&
                message.content.includes("CASE-CARRIER-417"),
            ),
          );
          return { role: "assistant", content: "已找到历史案例。" };
        },
      },
      atomicMemoryModelFactory: async () => {
        throw new Error("Auxiliary calls forbidden");
      },
    },
  );
  const journal = await events.readSession(sessionId);
  const traces = journal.filter(
    (event) => event.kind === "memory.recall.recorded" && event.data.recordType === "case",
  );
  assert.equal(traces.length, 1);
  const trace = traces[0]!;
  assert.equal(trace.kind, "memory.recall.recorded");
  if (trace.kind !== "memory.recall.recorded") return;
  assert.equal(trace.data.version, 2);
  assert.equal(trace.data.caseSelected?.[0]?.candidateId, candidate.candidateId);
  assert.deepEqual(trace.data.selected, []);
  assert.equal(trace.data.queryRef?.toolCallId, "case-search");
  assert.equal((await store.listItems({ workspaceKey: paths.workspace.id })).length, 0);
  assert.equal(
    (await store.taskExperiences.listTaskExperienceReuse(paths.workspace.id, sessionId)).length,
    0,
  );
  assert.equal(turn, 2);
});
