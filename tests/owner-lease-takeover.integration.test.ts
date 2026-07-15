import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LeaseConflictError,
  OwnerLease,
  type OwnerLeaseRecord,
  resolveOwnerLeaseTombstonePath,
} from "../src/storage/owner-lease.js";

const CONTENDER_COUNT = 48;
const DEAD_PID = 2_147_483_647;

describe("owner lease stale takeover integration", () => {
  const cleanup: string[] = [];
  const children = new Set<ChildProcessWithoutNullStreams>();

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("fails closed when an existing lease owner is missing or malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-invalid-"));
    cleanup.push(root);
    const leaseDirectory = join(root, "leases", "session-a");

    await mkdir(leaseDirectory, { recursive: true });
    await expect(
      OwnerLease.acquire({ leaseDirectory, ownerId: "contender" }),
    ).rejects.toBeInstanceOf(LeaseConflictError);

    await writeFile(join(leaseDirectory, "owner.json"), "{malformed", "utf8");
    await expect(
      OwnerLease.acquire({ leaseDirectory, ownerId: "contender" }),
    ).rejects.toBeInstanceOf(LeaseConflictError);
  });

  it("recovers after a claimant crashes with a tombstone and candidate left behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-crashed-takeover-"));
    cleanup.push(root);
    const leaseDirectory = join(root, "leases", "session-a");
    const staleOwner = createDeadOwner("stale-lease");
    await mkdir(leaseDirectory, { recursive: true });
    await writeFile(join(leaseDirectory, "owner.json"), JSON.stringify(staleOwner), "utf8");

    const tombstonePath = resolveOwnerLeaseTombstonePath(leaseDirectory, staleOwner.leaseId);
    await rename(leaseDirectory, tombstonePath);
    const abandonedCandidate = join(root, "leases", ".session-a.candidate-abandoned");
    await mkdir(abandonedCandidate);
    await writeFile(
      join(abandonedCandidate, "owner.json"),
      JSON.stringify(createDeadOwner("abandoned-candidate")),
      "utf8",
    );

    const lease = await OwnerLease.acquire({ leaseDirectory, ownerId: "recovered" });
    await lease.assertOwnership();
    await expect(stat(abandonedCandidate)).resolves.toBeDefined();
    await expect(readFile(join(tombstonePath, "owner.json"), "utf8")).resolves.toContain(
      staleOwner.leaseId,
    );

    // A delayed contender for staleOwner cannot ABA-move the newly published live lease:
    // the fixed, non-empty tombstone for that old leaseId already exists.
    await expect(rename(leaseDirectory, tombstonePath)).rejects.toBeDefined();
    await lease.assertOwnership();
    await lease.release();
  });

  it("signals lost ownership when the heartbeat can no longer verify its lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-lost-signal-"));
    cleanup.push(root);
    const leaseDirectory = join(root, "leases", "session-a");
    const displacedDirectory = join(root, "leases", "session-a-displaced");
    const lease = await OwnerLease.acquire({
      leaseDirectory,
      ownerId: "original-owner",
      heartbeatIntervalMs: 10,
    });

    await rename(leaseDirectory, displacedDirectory);
    await mkdir(leaseDirectory);
    await writeFile(
      join(leaseDirectory, "owner.json"),
      JSON.stringify(createDeadOwner("replacement-owner")),
      "utf8",
    );
    await waitForAbort(lease.lostSignal);

    expect(lease.lostSignal.aborted).toBe(true);
    expect(lease.lostSignal.reason).toBeInstanceOf(LeaseConflictError);
    await expect(lease.assertOwnership()).rejects.toBe(lease.lostSignal.reason);
    await lease.release();
    await expect(stat(displacedDirectory)).resolves.toBeDefined();
  });

  it("allows only one of 48 processes to enter after observing the same dead owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-owner-lease-race-"));
    cleanup.push(root);
    const leaseDirectory = join(root, "lease");
    const readyDirectory = join(root, "ready");
    const outcomeDirectory = join(root, "outcomes");
    const verifiedDirectory = join(root, "verified");
    const startPath = join(root, "start");
    const releasePath = join(root, "release");
    await Promise.all([
      mkdir(leaseDirectory, { recursive: true }),
      mkdir(readyDirectory),
      mkdir(outcomeDirectory),
      mkdir(verifiedDirectory),
    ]);
    await writeFile(
      join(leaseDirectory, "owner.json"),
      JSON.stringify(createDeadOwner("shared-dead-owner")),
      "utf8",
    );

    const moduleUrl = pathToFileURL(join(process.cwd(), "src", "storage", "owner-lease.ts")).href;
    const executions = Array.from({ length: CONTENDER_COUNT }, (_, index) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", CONTENDER_SCRIPT],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PICO_OWNER_LEASE_MODULE_URL: moduleUrl,
            PICO_OWNER_LEASE_DIRECTORY: leaseDirectory,
            PICO_OWNER_LEASE_READY_PATH: join(readyDirectory, `${index}.ready`),
            PICO_OWNER_LEASE_OUTCOME_PATH: join(outcomeDirectory, `${index}.json`),
            PICO_OWNER_LEASE_VERIFIED_PATH: join(verifiedDirectory, `${index}.verified`),
            PICO_OWNER_LEASE_START_PATH: startPath,
            PICO_OWNER_LEASE_RELEASE_PATH: releasePath,
            PICO_OWNER_LEASE_CONTENDER_ID: String(index),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(child);
      return waitForChild(child).finally(() => children.delete(child));
    });

    await waitForFileCount(readyDirectory, CONTENDER_COUNT);
    await writeFile(startPath, "start\n", "utf8");
    await waitForFileCount(outcomeDirectory, CONTENDER_COUNT, ".json");

    const outcomes = await readJsonDirectory<{ status: string }>(outcomeDirectory);
    expect(outcomes.filter((outcome) => outcome.status === "acquired")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "conflict")).toHaveLength(
      CONTENDER_COUNT - 1,
    );

    await writeFile(releasePath, "release\n", "utf8");
    const exits = await Promise.all(executions);
    expect(exits).toEqual(
      Array.from({ length: CONTENDER_COUNT }, () => expect.objectContaining({ code: 0 })),
    );
    await expect(readdir(verifiedDirectory)).resolves.toHaveLength(1);
  }, 60_000);
});

const CONTENDER_SCRIPT = String.raw`
  import { access, rename, writeFile } from "node:fs/promises";
  import { setTimeout as delay } from "node:timers/promises";

  const {
    PICO_OWNER_LEASE_MODULE_URL: moduleUrl,
    PICO_OWNER_LEASE_DIRECTORY: leaseDirectory,
    PICO_OWNER_LEASE_READY_PATH: readyPath,
    PICO_OWNER_LEASE_OUTCOME_PATH: outcomePath,
    PICO_OWNER_LEASE_VERIFIED_PATH: verifiedPath,
    PICO_OWNER_LEASE_START_PATH: startPath,
    PICO_OWNER_LEASE_RELEASE_PATH: releasePath,
    PICO_OWNER_LEASE_CONTENDER_ID: contenderId,
  } = process.env;
  if (
    !moduleUrl || !leaseDirectory || !readyPath || !outcomePath || !verifiedPath ||
    !startPath || !releasePath || !contenderId
  ) throw new Error("missing owner lease contender environment");

  const { LeaseConflictError, OwnerLease } = await import(moduleUrl);
  const waitForPath = async (path) => {
    for (;;) {
      try {
        await access(path);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(2);
    }
  };
  const publishOutcome = async (outcome) => {
    const candidatePath = outcomePath + "." + process.pid + ".tmp";
    await writeFile(candidatePath, JSON.stringify(outcome), "utf8");
    await rename(candidatePath, outcomePath);
  };

  await writeFile(readyPath, "ready\n", "utf8");
  await waitForPath(startPath);
  let lease;
  try {
    lease = await OwnerLease.acquire({
      leaseDirectory,
      ownerId: "contender-" + contenderId,
      staleAfterMs: 1,
    });
  } catch (error) {
    if (error instanceof LeaseConflictError) {
      await publishOutcome({ status: "conflict" });
      process.exit(0);
    }
    await publishOutcome({ status: "error", message: String(error) });
    throw error;
  }

  await publishOutcome({ status: "acquired", leaseId: lease.id });
  await waitForPath(releasePath);
  await lease.assertOwnership();
  await writeFile(verifiedPath, "verified\n", "utf8");
  await lease.release();
`;

function createDeadOwner(leaseId: string): OwnerLeaseRecord {
  return {
    schemaVersion: 1,
    leaseId,
    ownerId: "dead-owner",
    pid: DEAD_PID,
    hostname: hostname(),
    processStartedAt: "2000-01-01T00:00:00.000Z",
    acquiredAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
  };
}

async function waitForFileCount(directory: string, count: number, suffix?: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const names = await readdir(directory);
    if (names.filter((name) => suffix === undefined || name.endsWith(suffix)).length === count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} files in ${directory}`);
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for lease loss")), 1_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

async function readJsonDirectory<T>(directory: string): Promise<T[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as T),
  );
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}
