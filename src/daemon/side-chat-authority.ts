import type { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import { withWorkspaceSqliteLease } from "../storage/sqlite/workspace-scopes.js";

const SIDE_CHAT_LEASES_KEY = "desktop.side-chat.leases.v1";
const DEFAULT_LIVE_LEASE_TTL_MS = 2 * 60 * 1000;

export type SideChatLeaseState = "creating" | "live" | "cleanup";

export interface SideChatLease {
  readonly panelId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly throughEventId: string;
  readonly state: SideChatLeaseState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SideChatForkInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly throughEventId: string;
}

export class SideChatNoSettledTurnError extends Error {
  constructor(readonly sourceSessionId: string) {
    super(`Session ${sourceSessionId} has no completed turn for a side conversation`);
    this.name = "SideChatNoSettledTurnError";
  }
}

export function latestCompletedTurnBoundary(
  events: readonly RuntimeEvent[],
): RuntimeEvent | undefined {
  return [...events]
    .reverse()
    .find((event) => event.kind === "run.terminal" && event.data.status === "completed");
}

export class SideChatAuthority {
  constructor(
    private readonly options: {
      readonly storageRoot: string;
      readonly now?: () => Date;
      readonly liveLeaseTtlMs?: number;
      readonly fork: (input: SideChatForkInput) => Promise<void>;
      readonly markSideConversation: (targetSessionId: string) => Promise<void>;
      readonly removeSession: (targetSessionId: string) => Promise<void>;
    },
  ) {}

  list(): readonly SideChatLease[] {
    return readSideChatLeases(this.options.storageRoot);
  }

  async create(input: {
    readonly panelId: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly sourceEvents: readonly RuntimeEvent[];
  }): Promise<SideChatLease> {
    const existing = this.list().find(
      (lease) => lease.panelId === input.panelId && lease.sourceSessionId === input.sourceSessionId,
    );
    if (existing?.state === "live") {
      const refreshed = { ...existing, updatedAt: this.now() };
      writeSideChatLease(this.options.storageRoot, refreshed);
      return refreshed;
    }
    if (existing) await this.cleanup(existing.targetSessionId);

    const boundary = latestCompletedTurnBoundary(input.sourceEvents);
    if (!boundary) throw new SideChatNoSettledTurnError(input.sourceSessionId);
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    let lease: SideChatLease = {
      panelId: input.panelId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      throughEventId: boundary.eventId,
      state: "creating",
      createdAt: now,
      updatedAt: now,
    };
    writeSideChatLease(this.options.storageRoot, lease);
    try {
      await this.options.fork({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        throughEventId: boundary.eventId,
      });
      await this.options.markSideConversation(input.targetSessionId);
      lease = { ...lease, state: "live", updatedAt: this.now() };
      writeSideChatLease(this.options.storageRoot, lease);
      return lease;
    } catch (error) {
      writeSideChatLease(this.options.storageRoot, {
        ...lease,
        state: "cleanup",
        updatedAt: this.now(),
      });
      await this.options.removeSession(input.targetSessionId).catch(() => undefined);
      throw error;
    }
  }

  async cleanup(targetSessionId: string): Promise<void> {
    const lease = this.list().find((candidate) => candidate.targetSessionId === targetSessionId);
    if (!lease) return;
    writeSideChatLease(this.options.storageRoot, {
      ...lease,
      state: "cleanup",
      updatedAt: this.now(),
    });
    await this.options.removeSession(targetSessionId);
    deleteSideChatLease(this.options.storageRoot, targetSessionId);
  }

  async recover(): Promise<void> {
    for (const lease of this.list()) {
      if (
        lease.state === "live" &&
        Date.parse(lease.updatedAt) + (this.options.liveLeaseTtlMs ?? DEFAULT_LIVE_LEASE_TTL_MS) >
          (this.options.now ?? (() => new Date()))().getTime()
      ) {
        continue;
      }
      await this.options.removeSession(lease.targetSessionId).catch(() => undefined);
      deleteSideChatLease(this.options.storageRoot, lease.targetSessionId);
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}

export function readSideChatLeases(storageRoot: string): readonly SideChatLease[] {
  return withWorkspaceSqliteLease(storageRoot, ({ database }) => readLeases(database));
}

function writeSideChatLease(storageRoot: string, lease: SideChatLease): void {
  withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    const leases = readLeases(database).filter(
      (candidate) =>
        candidate.targetSessionId !== lease.targetSessionId &&
        !(
          candidate.panelId === lease.panelId && candidate.sourceSessionId === lease.sourceSessionId
        ),
    );
    leases.push(lease);
    writeLeases(database, leases);
  });
}

function deleteSideChatLease(storageRoot: string, targetSessionId: string): void {
  withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    writeLeases(
      database,
      readLeases(database).filter((lease) => lease.targetSessionId !== targetSessionId),
    );
  });
}

function readLeases(database: DatabaseSync): SideChatLease[] {
  const row = database
    .prepare("SELECT value_json FROM workspace_kv WHERE key = ?")
    .get(SIDE_CHAT_LEASES_KEY) as { readonly value_json?: unknown } | undefined;
  if (!row || typeof row.value_json !== "string") return [];
  try {
    const value: unknown = JSON.parse(row.value_json);
    return Array.isArray(value) ? value.filter(isSideChatLease) : [];
  } catch {
    return [];
  }
}

function writeLeases(database: DatabaseSync, leases: readonly SideChatLease[]): void {
  database
    .prepare(
      `INSERT INTO workspace_kv(key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(SIDE_CHAT_LEASES_KEY, JSON.stringify(leases));
}

function isSideChatLease(value: unknown): value is SideChatLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return (
    typeof lease["panelId"] === "string" &&
    typeof lease["sourceSessionId"] === "string" &&
    typeof lease["targetSessionId"] === "string" &&
    typeof lease["throughEventId"] === "string" &&
    (lease["state"] === "creating" || lease["state"] === "live" || lease["state"] === "cleanup") &&
    typeof lease["createdAt"] === "string" &&
    typeof lease["updatedAt"] === "string"
  );
}
