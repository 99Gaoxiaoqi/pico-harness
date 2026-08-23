import assert from "node:assert/strict";
import test from "node:test";
import { retainBrowserAgentLease } from "../../apps/desktop/src/renderer/workbar-panels/browser-agent-lease-controller.js";

test("Browser panel immediately releases a lease acquired after effect disposal", async () => {
  const acquisition = Promise.withResolvers<{
    readonly leaseId: string;
    readonly expiresAt: number;
  }>();
  const released: string[] = [];
  let current = true;
  const retaining = retainBrowserAgentLease({
    acquire: () => acquisition.promise,
    isCurrent: () => current,
    release: async (leaseId) => {
      released.push(leaseId);
    },
  });

  current = false;
  acquisition.resolve({ leaseId: "late-lease", expiresAt: 10_000 });
  assert.equal(await retaining, null);
  assert.deepEqual(released, ["late-lease"]);
});

test("Browser panel releases a lease when Main confirmation observes a replaced generation", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  const released: string[] = [];
  const retaining = retainBrowserAgentLease({
    acquire: async () => ({ leaseId: "replaced-generation", expiresAt: 10_000 }),
    isCurrent: () => confirmation.promise,
    release: async (leaseId) => {
      released.push(leaseId);
    },
  });

  confirmation.resolve(false);
  assert.equal(await retaining, null);
  assert.deepEqual(released, ["replaced-generation"]);
});
