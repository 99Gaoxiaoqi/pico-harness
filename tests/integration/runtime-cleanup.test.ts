import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeCleanupScope } from "../../src/runtime/runtime-cleanup.js";

test("RuntimeCleanupScope preserves cleanup order and isolates failures", async () => {
  const order: string[] = [];
  const failures: Array<{ resource: string; error: unknown }> = [];
  const scope = new RuntimeCleanupScope((resource, error) => {
    failures.push({ resource, error });
  });

  scope.register("first", () => {
    order.push("first");
  });
  scope.register("failing", async () => {
    order.push("failing");
    throw new Error("cleanup failed");
  });
  scope.register("last", () => {
    order.push("last");
  });

  await scope.dispose();
  await scope.dispose();

  assert.deepEqual(order, ["first", "failing", "last"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.resource, "failing");
  assert.equal((failures[0]?.error as Error).message, "cleanup failed");
});
