import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message, ToolDefinition } from "@pico/core";
import { AtomicMemoryContextBuilder, AtomicMemoryLifecycle, countTokens } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { buildMemoryReadTool, buildMemorySearchTool } from "@pico/pico-host/memory-trigger-tools";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";

test("t58 exact saved-body interface refuses model offsets and preserves the internal range reader", async () => {
  const store = new SqliteMemoryItemStore(":memory:");
  try {
    const content =
      "🧭Only if the receipt is confirmed, preserve the entire condition; never retry a charged payment.";
    const seeded = await store.applyMutations({
      operationId: "t58-seed",
      mutations: [
        {
          type: "create",
          item: {
            content,
            kind: "note",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: "t58",
            observedAt: 1,
            origin: "user_requested",
            keys: [{ key: "T58Receipt", keyType: "concept", keyOrigin: "user" }],
            sources: [],
          },
        },
      ],
    });
    const itemId = seeded.results[0]!.itemId;
    const builder = new AtomicMemoryContextBuilder(store, "t58");
    let dispatched = 0;
    const tool = buildMemoryReadTool({
      read: async (input) => {
        dispatched++;
        assert.deepEqual(Object.keys(input).sort(), ["expected_version", "item_id"]);
        return (await builder.read(input.item_id, input.expected_version)).block;
      },
    });
    const schema = tool.definition().inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(Object.keys(schema.properties).sort(), ["expected_version", "item_id"]);
    assert.deepEqual(schema.required, ["item_id", "expected_version"]);
    assert.equal(schema.additionalProperties, false);
    for (const extra of [
      { start: 0 },
      { end: 5 },
      { start: 0, end: 5 },
      { scope: "global" },
      { max_tokens: 9000 },
    ])
      await assert.rejects(
        tool.execute(JSON.stringify({ item_id: itemId, expected_version: 1, ...extra })),
        /requires only/,
      );
    assert.equal(dispatched, 0, "no unsupported model field reaches Host");
    const whole = await tool.execute(JSON.stringify({ item_id: itemId, expected_version: 1 }));
    assert.match(whole, /never retry a charged payment/);
    assert.ok(countTokens(whole) <= 5120);
    assert.equal(dispatched, 1);
    const internal = await builder.read(itemId, 1, { start: 0, end: 5 });
    assert.equal(internal.references[0]?.content, Array.from(content).slice(0, 5).join(""));
    assert.deepEqual(internal.references[0]?.range, {
      start: 0,
      end: 5,
      total: Array.from(content).length,
    });
    const search = buildMemorySearchTool({ search: async () => "" }).definition();
    assert.deepEqual((search.inputSchema as { required: string[] }).required, ["query"]);
    assert.ok(
      !JSON.stringify(search).includes("memory_read"),
      "A without read keeps its search interface unchanged",
    );
  } finally {
    store.close();
  }
});

test("t58 real Host exposes only identity fields, rejects an offset before read, then delivers the full saved original", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-t58-interface-")));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "t58-exact-interface";
  await mkdir(workDir);
  await mkdir(picoHome);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const lifecycle = new AtomicMemoryLifecycle();
  t.after(async () => {
    await lifecycle.close();
    await closeExecutionLearningWorker(picoHome);
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const content =
    "T58ExactBody: only confirmed invoices may be released. 🧭A duplicate receipt must never trigger another charge.";
  const seeded = await store.applyMutations({
    operationId: "t58-host-seed",
    mutations: [
      {
        type: "create",
        item: {
          content,
          kind: "note",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: paths.workspace.id,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "T58ExactBody", keyType: "concept", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  const settings = await store.readSettings(paths.workspace.id);
  await store.updateSettings({
    workspaceKey: paths.workspace.id,
    expectedVersion: settings.version,
    autoExtract: false,
  });
  const itemId = seeded.results[0]!.itemId;
  let turn = 0;
  let delivered: Message[] = [];
  let auxiliary = 0;
  await executeAgentRuntime(
    {
      prompt: "Read the known saved invoice note.",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "fixture/test",
      allowedTools: ["memory_read"],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      atomicMemoryLifecycle: lifecycle,
      maxTurns: 3,
      executionLearningWorkerOptions: { idleMs: 600000, pollMs: 600000 },
      reporter: new SilentReporter(),
      provider: {
        generate: async (messages: Message[], tools: ToolDefinition[]) => {
          const definition = tools.find((tool) => tool.name === "memory_read")!;
          assert.deepEqual(
            Object.keys(
              (definition.inputSchema as { properties: Record<string, unknown> }).properties,
            ).sort(),
            ["expected_version", "item_id"],
          );
          if (turn++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "t58-bad-offset",
                  name: "memory_read",
                  arguments: JSON.stringify({ item_id: itemId, expected_version: 1, start: 1 }),
                },
              ],
            };
          if (turn === 2) {
            assert.ok(
              !messages
                .findLast((message) => message.toolCallId === "t58-bad-offset")
                ?.content.includes("duplicate receipt"),
            );
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "t58-full",
                  name: "memory_read",
                  arguments: JSON.stringify({ item_id: itemId, expected_version: 1 }),
                },
              ],
            };
          }
          delivered = messages;
          assert.ok(
            messages
              .findLast((message) => message.toolCallId === "t58-full")
              ?.content.includes(content),
          );
          return { role: "assistant", content: "Saved original received." };
        },
      },
      atomicMemoryModelFactory: async () => ({
        model: {
          call: async () => {
            auxiliary++;
            throw new Error("No model calls in interface integration");
          },
        },
      }),
    },
  );
  assert.equal(auxiliary, 0);
  assert.ok(delivered.length);
  const recorded = (await events.readSession(sessionId)).filter(
    (event) =>
      event.kind === "memory.recall.recorded" && event.data.queryRef?.toolCallId === "t58-full",
  );
  assert.equal(recorded.length, 1);
  if (recorded[0]?.kind === "memory.recall.recorded")
    assert.deepEqual(recorded[0].data.selected[0]?.range, {
      start: 0,
      end: Array.from(content).length,
      total: Array.from(content).length,
    });
});
