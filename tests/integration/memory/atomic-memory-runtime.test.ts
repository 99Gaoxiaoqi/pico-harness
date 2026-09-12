import { AtomicMemoryLifecycle } from "../../../src/runtime/atomic-memory-lifecycle.js";
import { DesktopAtomicMemoryService } from "../../../src/daemon/desktop-atomic-memory-service.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeAgentRuntime } from "../../../src/runtime/agent-runtime.js";
import {
  AtomicMemoryRuntime,
  ProviderAtomicMemoryModel,
} from "../../../src/runtime/atomic-memory-runtime.js";
import { CostTracker } from "../../../src/observability/tracker.js";
import { SqliteRuntimeControlStore } from "../../../src/storage/sqlite/sqlite-runtime-control-store.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { globalSessionManager, Session } from "../../../src/engine/session.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { FullCompactor } from "../../../src/context/full-compactor.js";
import { recordRuntimeCompactionCheckpoint } from "../../../src/context/runtime-compaction-checkpoint.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  memorySessionKey,
  type MemoryExtractionModel,
} from "../../../src/memory/atomic/runtime-contracts.js";
import type { ToolCall } from "../../../src/schema/message.js";

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
        const evidenceJson = request.prompt.match(
          /<memory_evidence>\n([\s\S]*?)\n<\/memory_evidence>/u,
        )?.[1];
        assert.ok(evidenceJson);
        const evidence = JSON.parse(evidenceJson) as Array<{
          sourceRef: string;
          messagePositions?: number[];
          texts?: unknown;
        }>;
        const requestedEvidence = evidence.find(
          (entry) => entry.sourceRef === `event:${user.event.eventId}`,
        );
        assert.ok(requestedEvidence?.messagePositions?.length);
        assert.equal(
          requestedEvidence.texts,
          undefined,
          "indexed evidence must not duplicate the source text",
        );
        assert.ok(
          requestedEvidence.messagePositions.some((position) =>
            request.sourceMessages?.[position]?.content.includes(prompt),
          ),
        );
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
  const management = new DesktopAtomicMemoryService({ picoHome, publish: () => {} });
  const saved = (await management.create(workDir, "A note to delete during the pending run.")).item;
  await runtime.capture([{ role: "user", content: "你好" }], []);
  await runtime.requestExtract();
  await management.delete(workDir, {
    workspacePath: workDir,
    itemId: saved.itemId,
    expectedVersion: saved.version,
    idempotencyKey: "delete-before-terminal",
  });
  management.close();
  assert.equal(
    (await runtime.remember()).status,
    "unavailable",
    "captured foreground work is invalidated",
  );
  await runtime.completed(terminal.event.runId);
  await runtime.drain();
  assert.equal(
    modelCalls,
    0,
    "pre-deletion requests keep their generation through delayed preparation",
  );
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

test("atomic compaction persists its covered boundary and records disabled-policy barriers without waiting for terminal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-compaction-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "atomic-compaction";
  await mkdir(workDir);
  const session = new Session(sessionId, workDir, { persistence: true, picoHome });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.run(async () => {
    await run.commitMessages(session, [
      { role: "user", content: "My old project uses Rust. " + "old context ".repeat(80) },
      { role: "assistant", content: "Understood. " + "old context ".repeat(80) },
      { role: "user", content: "Continue." },
      { role: "assistant", content: "Continuing." },
    ]);
    const checkpoint = await recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: run,
      compactor: new FullCompactor({
        provider: {
          async generate() {
            return { role: "assistant", content: "Summary of old project." };
          },
        },
        maxAttempts: 1,
      }),
      request: { inputBudgetTokens: 4000, targetRetainedTokens: 1, trigger: "manual" },
      memoryDisposition: async () => "policy_denied",
    });
    assert.ok(checkpoint);
    let calls = 0;
    const lifecycle = new AtomicMemoryLifecycle(() => {
      throw new Error("draining compaction must not acquire residency");
    });
    lifecycle.beginDrain();
    const runtime = new AtomicMemoryRuntime({
      lifecycle,
      workDir,
      picoHome,
      sessionId,
      supported: true,
      gate: async () => ({ allowed: false, reason: "memory_disabled" }),
      modelFactory: async () => {
        calls++;
        throw new Error("disabled model factory must not run");
      },
    });
    await runtime.checkpoint(checkpoint.checkpointId);
    await lifecycle.close();
    assert.deepEqual(await runtime.requestExtract(), { status: "unavailable" });
    assert.equal(calls, 0);
    const entries = await session.runtimeEventStore!.readSessionEntries(sessionId);
    const recorded = entries.find(
      ({ event }) =>
        event.kind === "context.checkpoint.recorded" &&
        event.data.checkpointId === checkpoint.checkpointId,
    )?.event;
    assert.ok(recorded?.kind === "context.checkpoint.recorded");
    assert.deepEqual(recorded.data.memoryExtractionBoundary, {
      runtimeEventId: recorded.data.throughEventId,
      disposition: "policy_denied",
    });
    assert.equal(
      entries.some((entry) => entry.event.kind === "run.terminal"),
      false,
    );
  });
});

test("background memory billing can settle after the parent run terminal without appending to that run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-billing-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  const session = new Session("atomic-billing", workDir, { persistence: true, picoHome });
  await session.recover();
  const paths = resolvePicoPaths(workDir, { picoHome });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: paths.workspace.root });
  t.after(async () => {
    ledger.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new ProviderAtomicMemoryModel(
    new CostTracker(
      {
        async generate() {
          await barrier;
          return {
            role: "assistant",
            content: "finished",
            usage: { promptTokens: 10, completionTokens: 2 },
          };
        },
      },
      "test-model",
      undefined,
      { ledger, recordRuntimeEvents: false, context: { purpose: "main", sessionId: session.id } },
    ),
  );
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  let pending!: Promise<string>;
  await run.run(async () => {
    pending = model.call({ stage: "canonicalize", prompt: "test" });
  });
  release();
  assert.equal(await pending, "finished");
  const entries = await session.runtimeEventStore!.readSessionEntries(session.id);
  assert.equal(entries.filter((entry) => entry.event.kind === "model.call.started").length, 0);
  const records = ledger.listProviderCalls({ sessionId: session.id });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.purpose, "memory_review");
});
