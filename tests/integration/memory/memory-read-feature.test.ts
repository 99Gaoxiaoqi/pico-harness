import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message, PreparedProviderRequest } from "@pico/core";
import { countTokens, AtomicMemoryLifecycle } from "@pico/runtime";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import {
  MemoryRecallRequestTracker,
  capturePreparedMemoryRecall,
} from "../../../packages/runtime/src/memory-recall-request.js";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { resolvePicoPaths } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { buildMemoryReadTool } from "@pico/pico-host/memory-trigger-tools";

test("saved-body reader preserves exact code-point/time/source trace and rejects stale/unsupported/foreign requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-read-feature-"));
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const content =
    "🧭Only within project A, preserve the original condition; never apply it elsewhere.";
  const created = await store.applyMutations({
    operationId: "seed",
    mutations: [
      {
        type: "create",
        item: {
          content,
          kind: "note",
          statementType: "fact",
          temporalType: "interval",
          scopeType: "workspace",
          scopeKey: "a",
          observedAt: 3000,
          eventStartedAt: 1000,
          eventEndedAt: 2000,
          origin: "user_requested",
          keys: [{ key: "fixture-read-marker", keyType: "concept", keyOrigin: "user" }],
          sources: [
            {
              sessionId: "source-session",
              runId: "source-run",
              turnId: "source-turn",
              eventId: "source-event",
            },
          ],
        },
      },
    ],
  });
  const id = created.results[0]!.itemId;
  const builder = new AtomicMemoryContextBuilder(store, "a");
  const full = await builder.read(id, 1, { trace: { queryRef: { toolCallId: "read-1" } } });
  assert.equal(full.references[0]?.content, content);
  assert.deepEqual(full.references[0]?.range, {
    start: 0,
    end: Array.from(content).length,
    total: Array.from(content).length,
  });
  assert.match(full.block, /event-start="1000" event-end="2000"/);
  assert.equal(full.trace?.selected[0]?.sources[0]?.eventId, "source-event");
  assert.ok(full.tokenCount <= 5120);
  assert.equal(countTokens(full.block), full.tokenCount);
  const part = await builder.read(id, 1, { start: 0, end: 5 });
  assert.equal(part.references[0]?.content, Array.from(content).slice(0, 5).join(""));
  await assert.rejects(builder.read(id, 99), /version_changed/);
  await assert.rejects(new AtomicMemoryContextBuilder(store, "b").read(id, 1), /not_available/);
  await assert.rejects(builder.read(id, 1, { end: 9999 }), /invalid_range/);
  await assert.rejects(builder.read(id, 1, { signal: AbortSignal.abort() }), /aborted/);
  const read = store.readItem.bind(store);
  let reads = 0;
  store.readItem = async (itemId) => {
    if (++reads === 2)
      await store.applyMutations({
        operationId: "archive",
        mutations: [{ type: "archive", itemId, expectedVersion: 1 }],
      });
    return read(itemId);
  };
  await assert.rejects(builder.read(id, 1), /not_available/);
  store.readItem = read;
  const tool = buildMemoryReadTool({
    read: async () => {
      assert.fail("invalid input reached Host");
    },
  });
  await assert.rejects(
    tool.execute(JSON.stringify({ item_id: id, expected_version: 1, currentWorkspace: "a" })),
    /requires/,
  );
});

test("real Host memory_read carrier records actual original range, matches prepared bytes and creates no adoption", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-read-host-")));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "read-host";
  await mkdir(workDir);
  await mkdir(picoHome);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const lifecycle = new AtomicMemoryLifecycle();
  t.after(async () => {
    await lifecycle.close();
    await closeExecutionLearningWorker(picoHome);
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const settings = await store.readSettings(paths.workspace.id);
  await store.updateSettings({
    workspaceKey: paths.workspace.id,
    expectedVersion: settings.version,
    autoExtract: false,
  });
  const seeded = await store.applyMutations({
    operationId: "seed-host",
    mutations: [
      {
        type: "create",
        item: {
          content: "Exact saved body READ_CARRIER_492 🧭.",
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: paths.workspace.id,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "fixture-read-marker", keyType: "concept", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  let turn = 0;
  let actual: Message[] = [];
  await executeAgentRuntime(
    {
      prompt: "Read the saved body precisely.",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "fixture/model",
      permissionMode: "full-access",
      allowedTools: ["memory_read"],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      atomicMemoryLifecycle: lifecycle,
      reporter: new SilentReporter(),
      provider: {
        generate: async (messages) => {
          if (turn++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "exact-read",
                  name: "memory_read",
                  arguments: JSON.stringify({
                    item_id: seeded.results[0]!.itemId,
                    expected_version: 1,
                  }),
                },
              ],
            };
          actual = messages;
          assert.match(
            messages.findLast((message) => message.toolCallId === "exact-read")?.content ?? "",
            /READ_CARRIER_492/,
          );
          return { role: "assistant", content: "Read the original saved body." };
        },
      },
      atomicMemoryModelFactory: async () => {
        throw new Error("No auxiliary model allowed");
      },
    },
  );
  const journal = await events.readSession(sessionId);
  const trace = journal.find(
    (event) =>
      event.kind === "memory.recall.recorded" && event.data.queryRef?.toolCallId === "exact-read",
  );
  assert.ok(trace?.kind === "memory.recall.recorded");
  assert.equal(trace.data.selected[0]?.itemId, seeded.results[0]!.itemId);
  const tracker = new MemoryRecallRequestTracker({
    record: async () => undefined,
    readHistory: async () => [{ eventId: trace.eventId, trace: trace.data }],
  });
  const facts = await tracker.context(actual);
  const prepared = {
    provider: "openai",
    model: "fixture",
    body: { messages: actual.map((message) => ({ role: message.role, content: message.content })) },
  } as PreparedProviderRequest;
  const diagnosis = capturePreparedMemoryRecall(prepared, facts);
  assert.equal(diagnosis.recalls[0]?.references[0]?.present, true);
  assert.equal(
    capturePreparedMemoryRecall({ ...prepared, body: { messages: [] } }, facts).recalls[0]
      ?.references[0]?.present,
    false,
  );
  assert.equal(
    (await store.experienceLedger.queryExperienceUses(paths.workspace.id, { sessionId })).uses
      .length,
    0,
  );
  assert.equal(turn, 2);
});
