import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { access, mkdtemp, rm, unlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OwnerLease } from "../../../packages/storage/src/owner-lease.js";

test(
  "OwnerLease release drains an in-flight heartbeat before admitting a new owner",
  { timeout: 5_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-heartbeat-release-"));
    const leaseDirectory = join(root, "lease");
    const ownerPath = join(leaseDirectory, "owner.json");
    const heartbeatRead = Promise.withResolvers<void>();
    const resumeHeartbeat = Promise.withResolvers<void>();
    const readFile = fsPromises.readFile;
    let ownerReads = 0;
    let removals = 0;
    const replacements: OwnerLease[] = [];
    context.mock.timers.enable({ apis: ["setInterval"] });
    const lease = await OwnerLease.acquire({
      leaseDirectory,
      ownerId: "heartbeat-release",
      heartbeatIntervalMs: 10,
      removeLeaseDirectory: async (path) => {
        removals++;
        await rm(path, { recursive: true, force: true });
      },
    });
    context.after(async () => {
      resumeHeartbeat.resolve();
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await Promise.all(replacements.map((owner) => owner.release()));
      await lease.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    context.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
      const result = await readFile(...args);
      // assertOwnership's read completes; hold writeRecord after it read the old owner.
      if (args[0] === ownerPath && ++ownerReads === 2) {
        heartbeatRead.resolve();
        await resumeHeartbeat.promise;
      }
      return result;
    });
    syncBuiltinESMExports();
    context.mock.timers.tick(10);
    await heartbeatRead.promise;
    const releasing = lease.release();
    const concurrentRelease = lease.release();
    const early = await Promise.race([
      releasing.then(() => "released"),
      delay(50).then(() => "waiting"),
    ]);
    assert.equal(early, "waiting", "release must not finish while a heartbeat can still publish");
    assert.equal(removals, 0, "the owner directory must survive until the writer drains");
    context.mock.timers.tick(100);
    assert.equal(ownerReads, 2, "closing must not admit another interval heartbeat");
    resumeHeartbeat.resolve();
    await Promise.all([releasing, concurrentRelease]);
    assert.equal(removals, 1, "concurrent release calls share one cleanup");
    await assert.rejects(access(leaseDirectory));
    const replacement = await OwnerLease.acquire({ leaseDirectory, ownerId: "replacement" });
    replacements.push(replacement);
    context.mock.timers.tick(100);
    assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).leaseId, replacement.id);
  },
);

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
