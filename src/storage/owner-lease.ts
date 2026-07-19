import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";

const LEASE_SCHEMA_VERSION = 1 as const;
const ACQUIRE_RETRY_LIMIT = 8;

export interface OwnerLeaseOptions {
  leaseDirectory: string;
  ownerId: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  /** Host filesystem seam; production defaults to recursive rm. */
  removeLeaseDirectory?: (leaseDirectory: string) => Promise<void>;
}

export interface OwnerLeaseRecord {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  leaseId: string;
  ownerId: string;
  pid: number;
  hostname: string;
  processStartedAt: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export class LeaseConflictError extends Error {
  constructor(
    message: string,
    readonly owner?: OwnerLeaseRecord,
  ) {
    super(message);
    this.name = "LeaseConflictError";
  }
}

export class OwnerLease {
  private readonly leaseId = randomUUID();
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly ownerPath: string;
  private readonly lostController = new AbortController();
  private heartbeatTimer?: NodeJS.Timeout;
  private released = false;
  private releasePromise?: Promise<void>;
  private releaseCleanupStarted = false;

  private constructor(private readonly options: OwnerLeaseOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.ownerPath = join(options.leaseDirectory, "owner.json");
  }

  static async acquire(options: OwnerLeaseOptions): Promise<OwnerLease> {
    const lease = new OwnerLease(options);
    const candidateDirectory = await lease.prepareCandidate();
    let published = false;
    try {
      await lease.acquireDirectory(candidateDirectory);
      published = true;
      lease.startHeartbeat();
      return lease;
    } finally {
      if (!published) {
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  get id(): string {
    return this.leaseId;
  }

  /** heartbeat 或显式校验无法继续证明所有权时触发，供集成层中断长任务。 */
  get lostSignal(): AbortSignal {
    return this.lostController.signal;
  }

  async assertOwnership(): Promise<void> {
    if (this.released) throw new LeaseConflictError("Lease has already been released");
    if (this.lostSignal.aborted) throw leaseLossReason(this.lostSignal);
    try {
      const current = await readLeaseRecord(this.ownerPath);
      if (current?.leaseId !== this.leaseId) {
        throw new LeaseConflictError("Lease ownership changed", current);
      }
    } catch (error) {
      this.markLost(error);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.releasePromise) return this.releasePromise;
    const release = this.releaseOnce();
    this.releasePromise = release;
    try {
      await release;
    } catch (error) {
      if (this.releasePromise === release) this.releasePromise = undefined;
      if (!this.released && !this.lostSignal.aborted) this.startHeartbeat();
      throw error;
    }
  }

  private async releaseOnce(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;

    const current = await readLeaseRecord(this.ownerPath);
    if (current && current.leaseId !== this.leaseId) {
      this.released = true;
      return;
    }
    if (!current && !(await pathExists(this.options.leaseDirectory))) {
      this.released = true;
      return;
    }
    if (!current && !this.releaseCleanupStarted) {
      this.released = true;
      this.markLost(new LeaseConflictError("Lease ownership can no longer be verified"));
      return;
    }
    const remove =
      this.options.removeLeaseDirectory ??
      ((leaseDirectory: string) => rm(leaseDirectory, { recursive: true, force: true }));
    this.releaseCleanupStarted = true;
    await remove(this.options.leaseDirectory);
    this.released = true;
  }

  private async prepareCandidate(): Promise<string> {
    const parentDirectory = dirname(this.options.leaseDirectory);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    const candidateDirectory = join(
      parentDirectory,
      `.${basename(this.options.leaseDirectory)}.candidate-${this.leaseId}`,
    );
    await mkdir(candidateDirectory, { mode: 0o700 });
    try {
      await this.writeRecord(join(candidateDirectory, "owner.json"));
      return candidateDirectory;
    } catch (error) {
      await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async acquireDirectory(candidateDirectory: string): Promise<void> {
    for (let attempt = 0; attempt < ACQUIRE_RETRY_LIMIT; attempt += 1) {
      const existing = await inspectLease(this.options.leaseDirectory, this.ownerPath);
      if (existing.state === "absent") {
        if (await publishCandidate(candidateDirectory, this.options.leaseDirectory)) return;
        continue;
      }
      if (existing.state === "unverifiable") {
        throw new LeaseConflictError("Lease directory exists but its owner cannot be verified");
      }
      if (!canProveOwnerIsDead(existing.owner, this.now(), this.staleAfterMs)) {
        throw leaseConflict(existing.owner);
      }

      await moveStaleLeaseToTombstone({
        leaseDirectory: this.options.leaseDirectory,
        ownerPath: this.ownerPath,
        expectedOwner: existing.owner,
        now: this.now(),
        staleAfterMs: this.staleAfterMs,
      });
      if (await publishCandidate(candidateDirectory, this.options.leaseDirectory)) return;

      const current = await inspectLease(this.options.leaseDirectory, this.ownerPath);
      if (current.state === "absent") continue;
      if (current.state === "unverifiable") {
        throw new LeaseConflictError("Lease directory exists but its owner cannot be verified");
      }
      throw leaseConflict(current.owner);
    }
    throw new LeaseConflictError("Lease acquisition did not converge");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || this.released || this.lostSignal.aborted) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error: unknown) => {
        this.markLost(error);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private async heartbeat(): Promise<void> {
    await this.assertOwnership();
    await this.writeRecord();
  }

  private markLost(reason: unknown): void {
    if (this.released || this.lostSignal.aborted) return;
    this.lostController.abort(
      reason instanceof Error ? reason : new LeaseConflictError(String(reason)),
    );
  }

  private async writeRecord(path = this.ownerPath): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const existing = await readLeaseRecord(path).catch(() => undefined);
    const record: OwnerLeaseRecord = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      leaseId: this.leaseId,
      ownerId: this.options.ownerId,
      pid: process.pid,
      hostname: hostname(),
      processStartedAt:
        existing?.leaseId === this.leaseId
          ? existing.processStartedAt
          : new Date(this.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: existing?.leaseId === this.leaseId ? existing.acquiredAt : now,
      heartbeatAt: now,
    };
    await writeJsonAtomic(path, record);
  }
}

function leaseLossReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new LeaseConflictError("Lease ownership was lost");
}

type LeaseInspection =
  | { state: "absent" }
  | { state: "unverifiable" }
  | { state: "owned"; owner: OwnerLeaseRecord };

async function inspectLease(leaseDirectory: string, ownerPath: string): Promise<LeaseInspection> {
  const owner = await readLeaseRecord(ownerPath);
  if (owner) return { state: "owned", owner };
  return (await pathExists(leaseDirectory)) ? { state: "unverifiable" } : { state: "absent" };
}

async function publishCandidate(
  candidateDirectory: string,
  leaseDirectory: string,
): Promise<boolean> {
  // Node does not expose renameat2(RENAME_NOREPLACE). All directories published by this
  // protocol are non-empty, while the explicit existence check preserves fail-closed
  // behavior for a legacy empty/malformed lease directory.
  if (await pathExists(leaseDirectory)) return false;
  try {
    await rename(candidateDirectory, leaseDirectory);
    return true;
  } catch (error) {
    if (await pathExists(leaseDirectory)) return false;
    throw error;
  }
}

interface MoveStaleLeaseOptions {
  leaseDirectory: string;
  ownerPath: string;
  expectedOwner: OwnerLeaseRecord;
  now: number;
  staleAfterMs: number;
}

async function moveStaleLeaseToTombstone(options: MoveStaleLeaseOptions): Promise<boolean> {
  const current = await readLeaseRecord(options.ownerPath);
  if (
    current?.leaseId !== options.expectedOwner.leaseId ||
    !canProveOwnerIsDead(current, options.now, options.staleAfterMs)
  ) {
    return false;
  }

  const tombstonePath = resolveOwnerLeaseTombstonePath(
    options.leaseDirectory,
    options.expectedOwner.leaseId,
  );
  // Tombstones are intentionally retained. A delayed contender for the old leaseId can
  // therefore never rename a newly-published lease into the old tombstone (ABA).
  if (await pathExists(tombstonePath)) return false;
  try {
    await rename(options.leaseDirectory, tombstonePath);
    return true;
  } catch (error) {
    if ((await pathExists(tombstonePath)) || !(await pathExists(options.leaseDirectory))) {
      return false;
    }
    throw error;
  }
}

export function resolveOwnerLeaseTombstonePath(leaseDirectory: string, leaseId: string): string {
  const leaseIdDigest = createHash("sha256").update(leaseId).digest("hex");
  return join(dirname(leaseDirectory), `.${basename(leaseDirectory)}.tombstone-${leaseIdDigest}`);
}

function leaseConflict(owner: OwnerLeaseRecord): LeaseConflictError {
  return new LeaseConflictError(
    `Lease is owned by ${owner.ownerId} (${owner.hostname}:${owner.pid})`,
    owner,
  );
}

async function readLeaseRecord(path: string): Promise<OwnerLeaseRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return parseLeaseRecord(parsed);
}

function parseLeaseRecord(value: unknown): OwnerLeaseRecord | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== LEASE_SCHEMA_VERSION) return undefined;
  const pid = value["pid"];
  if (
    typeof value["leaseId"] !== "string" ||
    typeof value["ownerId"] !== "string" ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof value["hostname"] !== "string" ||
    typeof value["processStartedAt"] !== "string" ||
    typeof value["acquiredAt"] !== "string" ||
    typeof value["heartbeatAt"] !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: value["leaseId"],
    ownerId: value["ownerId"],
    pid,
    hostname: value["hostname"],
    processStartedAt: value["processStartedAt"],
    acquiredAt: value["acquiredAt"],
    heartbeatAt: value["heartbeatAt"],
  };
}

function canProveOwnerIsDead(owner: OwnerLeaseRecord, now: number, staleAfterMs: number): boolean {
  if (owner.hostname !== hostname()) return false;
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt < staleAfterMs) return false;
  return !isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeCode(error, "ESRCH");
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
