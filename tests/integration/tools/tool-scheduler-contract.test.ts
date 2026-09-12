import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolAccesses } from "../../../src/tools/tool-access.js";
import { ToolScheduler } from "../../../src/tools/tool-scheduler.js";

test("ToolScheduler 要求调用方显式提供有限的正整数并发上限", async () => {
  assert.throws(() => new ToolScheduler({} as { maxConcurrency: number }), /positive safe integer/);
  assert.throws(() => new ToolScheduler({ maxConcurrency: Infinity }), /positive safe integer/);

  const scheduler = new ToolScheduler<number>({ maxConcurrency: 1 });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let peak = 0;
  const run = async (result: number, gate?: Promise<void>): Promise<number> => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return result;
  };
  const first = scheduler.add({ accesses: ToolAccesses.none(), start: () => run(1, firstGate) });
  const second = scheduler.add({ accesses: ToolAccesses.none(), start: () => run(2) });
  assert.equal(active, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(peak, 1);
});
