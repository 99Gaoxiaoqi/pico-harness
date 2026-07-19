import assert from "node:assert/strict";
import { access, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerLease } from "../../src/storage/owner-lease.js";

test("OwnerLease release can retry after filesystem deletion fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-release-"));
  const leaseDirectory = join(root, "lease");
  let removals = 0;
  const lease = await OwnerLease.acquire({
    leaseDirectory,
    ownerId: "release-retry",
    heartbeatIntervalMs: 60_000,
    removeLeaseDirectory: async (path) => {
      removals++;
      if (removals === 1) throw new Error("fixture removal failure");
      await rm(path, { recursive: true, force: true });
    },
  });
  context.after(async () => {
    await lease.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(lease.release(), /fixture removal failure/u);
  await lease.assertOwnership();
  await lease.release();
  await assert.rejects(access(leaseDirectory));
  await lease.release();
  assert.equal(removals, 2);
});

test("OwnerLease release retries cleanup after owner record was partially deleted", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-partial-release-"));
  const leaseDirectory = join(root, "lease");
  let removals = 0;
  const lease = await OwnerLease.acquire({
    leaseDirectory,
    ownerId: "partial-release-retry",
    heartbeatIntervalMs: 60_000,
    removeLeaseDirectory: async (path) => {
      removals++;
      if (removals === 1) {
        await unlink(join(path, "owner.json"));
        throw new Error("fixture partial removal failure");
      }
      await rm(path, { recursive: true, force: true });
    },
  });
  context.after(async () => {
    await lease.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(lease.release(), /fixture partial removal failure/u);
  await lease.release();
  await assert.rejects(access(leaseDirectory));
  assert.equal(removals, 2);
});
