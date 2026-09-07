import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { AtomicMemoryRuntime } from "../../src/runtime/atomic-memory-runtime.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  memorySessionKey,
  type MemoryExtractionModel,
} from "../../src/memory/atomic/runtime-contracts.js";
import type { ToolCall } from "../../src/schema/message.js";

const prompt = "请记住：我偏好简洁的中文回答。";

test("atomic memory runtime saves before the next model call and rejects sibling tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-runtime-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "atomic-runtime";
  await mkdir(workDir);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const paths = resolvePicoPaths(workDir, { picoHome });
  t.after(async () => {
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  let modelCalls = 0;
  const model: MemoryExtractionModel = {
    async call(request) {
      modelCalls++;
      const item = {
        content: "用户偏好简洁的中文回答。",
        kind: "preference",
        statementType: "fact",
        temporalType: "undated",
        eventStartedAt: null,
        eventEndedAt: null,
        scope: "global",
        keys: [{ key: "中文", type: "concept" }],
      };
      if (request.stage === "canonicalize")
        return JSON.stringify({
          results: [{ candidateId: "candidate_0", status: "accepted", item }],
        });
      const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
      try {
        const entries = await events.readSessionEntries(sessionId);
        assert.equal(
          entries.some((e) => e.event.kind === "run.terminal"),
          false,
          "remember must settle before terminal",
        );
        const user = entries.find(
          (e) => e.event.kind === "message.committed" && e.event.data.message.content === prompt,
        )!;
        return JSON.stringify({
          status: "complete",
          coverageStatus: "processed",
          requestedStatus: "resolved",
          requestedItems: [
            {
              ...item,
              evidence: [
                { sourceRef: `event:${user.event.eventId}`, quote: "我偏好简洁的中文回答。" },
              ],
            },
          ],
          incidentalItems: [],
        });
      } finally {
        events.close();
      }
    },
  };
  let calls = 0;
  const toolCalls: ToolCall[] = [
    { id: "remember", name: "memory_remember", arguments: "{}" },
    { id: "extract", name: "memory_extract", arguments: "{}" },
  ];
  const result = await executeAgentRuntime(
    {
      prompt,
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      allowedTools: ["memory_remember", "memory_extract"],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      reporter: new SilentReporter(),
      atomicMemoryModelFactory: async () => ({ model }),
      provider: {
        async generate(messages) {
          if (calls++ === 0) return { role: "assistant", content: "", toolCalls };
          const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
          try {
            assert.equal(
              (await store.listItems({ workspaceKey: paths.workspace.id })).length,
              1,
              JSON.stringify({ modelCalls, replies: messages.filter((m) => m.toolCallId) }),
            );
          } finally {
            store.close();
          }
          const replies = messages.filter((m) => m.toolCallId);
          assert.ok(
            replies.some(
              (m) => m.toolCallId === "remember" && m.content.includes('"status":"remembered"'),
            ),
          );
          assert.ok(replies.some((m) => m.toolCallId === "extract" && m.content.includes("独占")));
          return { role: "assistant", content: "已经记住。" };
        },
      },
    },
  );
  assert.equal(result.finalMessage, "已经记住。");
  assert.equal(modelCalls, 2);
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const entries = await events.readSessionEntries(sessionId);
  events.close();
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const cursor = await store.readExtractionCursor(memorySessionKey(paths.workspace.id, sessionId));
  store.close();
  assert.ok(
    cursor &&
      cursor.processedOrdinal < entries.find((e) => e.event.kind === "run.terminal")!.sequence,
  );
});

test("atomic memory extraction waits for a successful durable terminal and stops after session deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-trigger-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "atomic-extract";
  await mkdir(workDir);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const paths = resolvePicoPaths(workDir, { picoHome });
  t.after(async () => {
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  let modelCalls = 0;
  const runtime = new AtomicMemoryRuntime({
    workDir,
    picoHome,
    sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: async () => ({
      model: {
        async call() {
          modelCalls++;
          return JSON.stringify({
            status: "complete",
            coverageStatus: "processed",
            requestedStatus: "not_applicable",
            requestedItems: [],
            incidentalItems: [],
          });
        },
      },
    }),
  });
  await runtime.requestExtract();
  await runtime.completed("missing-run");
  await runtime.drain();
  assert.equal(modelCalls, 0);
  let calls = 0;
  await executeAgentRuntime(
    {
      prompt: "你好",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      allowedTools: [],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      reporter: new SilentReporter(),
      provider: {
        async generate() {
          calls++;
          return { role: "assistant", content: "你好" };
        },
      },
    },
  );
  assert.equal(calls, 1);
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const entries = await events.readSessionEntries(sessionId);
  const terminal = entries.find((e) => e.event.kind === "run.terminal")!;
  await runtime.requestExtract();
  await runtime.completed(terminal.event.runId);
  await runtime.drain();
  assert.equal(modelCalls, 1);
  // Already committed memory remains independent of Session lifecycle; new work must stop.
  await events.deleteSession(sessionId);
  events.close();
  await runtime.requestExtract();
  await runtime.completed(terminal.event.runId);
  await runtime.drain();
  assert.equal(modelCalls, 1);
});
