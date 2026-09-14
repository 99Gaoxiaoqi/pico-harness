import assert from "node:assert/strict";
import test from "node:test";

import { waitForDelay } from "@pico/runtime/deadline";
import { HookRewakeCoordinator, HookRewakeQueue } from "@pico/runtime/hook-rewake";

test("HookRewakeQueue retains a failed batch and seals admission on close", async () => {
  let failDelivery = true;
  const delivered: string[][] = [];
  const queue = new HookRewakeQueue(async (entries) => {
    if (failDelivery) throw new Error("synthetic delivery failure");
    delivered.push(entries.map(({ id }) => id));
  }, 2);

  assert.equal(queue.enqueue("first"), true);
  assert.equal(queue.enqueue("second"), true);
  assert.equal(queue.enqueue("overflow"), false);
  const ids = queue.pendingIds();
  await assert.rejects(queue.deliverPending(ids), /synthetic delivery failure/u);
  assert.deepEqual(queue.pendingIds(), ids, "failed delivery must retain the complete batch");

  failDelivery = false;
  const entries = await queue.deliverPending(ids);
  assert.deepEqual(entries.map(({ message }) => message), ["first", "second"]);
  assert.deepEqual(delivered, [ids]);
  assert.deepEqual(queue.pendingIds(), []);

  queue.close();
  assert.equal(queue.enqueue("late"), false);
});

test("HookRewakeCoordinator waits for idle and serially reschedules a late batch", async () => {
  const delivered: string[][] = [];
  const queue = new HookRewakeQueue(async (entries) => {
    delivered.push(entries.map(({ message }) => message));
  });
  let idle = false;
  let active = 0;
  let maxActive = 0;
  const finished = Promise.withResolvers<void>();
  const coordinator = new HookRewakeCoordinator({
    queue,
    isIdle: () => idle,
    resume: async (_ids, deliver) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await deliver();
        if (delivered.length === 1) queue.enqueue("late");
        else finished.resolve();
      } finally {
        active--;
      }
    },
    onError: finished.reject,
  });

  assert.equal(queue.enqueue("initial"), true);
  await waitForDelay(0);
  assert.deepEqual(delivered, [], "a busy Host must not resume the pending batch");

  idle = true;
  coordinator.notifyIdle();
  await finished.promise;
  assert.deepEqual(delivered, [["initial"], ["late"]]);
  assert.equal(maxActive, 1, "coordinator must never overlap resume calls");
  coordinator.dispose();
});
