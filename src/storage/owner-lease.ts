import { hostname } from "node:os";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "./atomic-json.js";

const LEASE_SCHEMA_VERSION = 1 as const;

export interface OwnerLeaseOptions {
  leaseDirectory: string;
  ownerId: string;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => number;
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
  private heartbeatTimer?: NodeJS.Timeout;
  private released = false;

  private constructor(private readonly options: OwnerLeaseOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.ownerPath = join(options.leaseDirectory, "owner.json");
  }

  static async acquire(options: OwnerLeaseOptions): Promise<OwnerLease> {
    const lease = new OwnerLease(options);
    await lease.acquireDirectory();
    await lease.writeRecord();
    lease.startHeartbeat();
    return lease;
  }

  get id(): string {
    return this.leaseId;
  }

  async assertOwnership(): Promise<void> {
    if (this.released) throw new LeaseConflictError("Lease has already been released");
    const current = await readLeaseRecord(this.ownerPath);
    if (current?.leaseId !== this.leaseId) {
      throw new LeaseConflictError("Lease ownership changed", current);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;

    const current = await readLeaseRecord(this.ownerPath).catch(() => undefined);
    if (current?.leaseId !== this.leaseId) return;
    await rm(this.options.leaseDirectory, { recursive: true, force: true });
  }

  private async acquireDirectory(): Promise<void> {
    try {
      await mkdir(this.options.leaseDirectory);
      return;
    } catch (error) {
      if (!isNodeCode(error, "EEXIST")) throw error;
    }

    const existing = await readLeaseRecord(this.ownerPath).catch(() => undefined);
    if (existing && canProveOwnerIsDead(existing, this.now(), this.staleAfterMs)) {
      await rm(this.options.leaseDirectory, { recursive: true, force: true });
      try {
        await mkdir(this.options.leaseDirectory);
        return;
      } catch (error) {
        if (!isNodeCode(error, "EEXIST")) throw error;
      }
    }

    throw new LeaseConflictError(
      existing
        ? `Lease is owned by ${existing.ownerId} (${existing.hostname}:${existing.pid})`
        : "Lease directory exists but its owner cannot be verified",
      existing,
    );
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => {
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

  private async writeRecord(): Promise<void> {
    const now = new Date(this.now()).toISOString();
    const existing = await readLeaseRecord(this.ownerPath).catch(() => undefined);
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
    await writeJsonAtomic(this.ownerPath, record);
  }
}

async function readLeaseRecord(path: string): Promise<OwnerLeaseRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
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

function canProveOwnerIsDead(
  owner: OwnerLeaseRecord,
  now: number,
  staleAfterMs: number,
): boolean {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
