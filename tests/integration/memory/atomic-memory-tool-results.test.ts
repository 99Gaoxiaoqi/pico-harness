import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { buildMemoryTriggerTools } from "@pico/pico-host/memory-trigger-tools";
import { ToolAccesses } from "@pico/runtime/tool-access";
import type { AtomicMemoryResult } from "@pico/core/atomic-memory-runtime-contracts";

test("memory application failures use the existing tool error path while queued and no-op results remain distinct", async () => {
  let result: AtomicMemoryResult = {
    status: "unavailable",
    reason: "cannot_resolve",
    requestedItems: [],
  };
  const registry = new ToolRegistry();
  for (const tool of buildMemoryTriggerTools({
    remember: async () => result,
    requestExtract: async () => ({ status: "accepted" }),
  }))
    registry.register(tool);
  const call = { id: "remember", name: "memory_remember", arguments: "{}" };
  const failure = await registry.execute(call);
  assert.equal(failure.isError, true);
  assert.match(failure.output, /无法唯一确定|cannot_resolve/u);
  const queued = await registry.execute({ ...call, id: "extract", name: "memory_extract" });
  assert.equal(queued.isError, false);
  assert.deepEqual(JSON.parse(queued.output), { status: "accepted" });
  result = {
    operationId: "empty",
    sessionId: "session",
    status: "not_applicable",
    requestedItems: [],
    committedAt: 0,
  };
  const noOp = await registry.execute(call);
  assert.equal(noOp.isError, false);
  assert.equal(JSON.parse(noOp.output).status, "not_applicable");
  registry.register({
    name: () => "ordinary_tool",
    definition: () => ({
      name: "ordinary_tool",
      description: "ordinary",
      inputSchema: { type: "object" },
    }),
    accesses: () => ToolAccesses.none(),
    execute: async () => JSON.stringify({ status: "unavailable" }),
  });
  assert.equal((await registry.execute({ ...call, name: "ordinary_tool" })).isError, false);
});
