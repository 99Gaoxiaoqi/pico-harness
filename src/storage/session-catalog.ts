import { homedir } from "node:os";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionIdentity } from "../engine/session-identity.js";
import { quarantineCorruptJson, writeJsonAtomic } from "./atomic-json.js";

const SESSION_CATALOG_VERSION = 1 as const;
const SAFE_LOG_ID = /^[A-Za-z0-9._-]+$/u;

export type SessionCatalogHealth = "healthy" | "stale" | "quarantined" | "incompatible";

export interface SessionCatalogCursor {
  logId: string;
  epoch: number;
  seq: number;
  eventId: string;
}

export interface SessionCatalogLineage {
  relation: "root" | "fork" | "spawn" | "salvage";
  rootLogId: string;
  parentLogId?: string;
  /** fork 时父日志的 durable head eventId，不是可变的 sessionId别名。 */
  forkEventId?: string;
  parentSessionId?: string;
  parentTaskId?: string;
}

export interface SessionCatalogEntry {
  schemaVersion: typeof SESSION_CATALOG_VERSION;
  logId: string;
  sessionId: string;
  logPath: string;
  identity: SessionIdentity;
  lineage: SessionCatalogLineage;
  title?: string;
  firstUserMessage?: string;
  lastUserMessage?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  journalSchemaVersion: number;
  /** JSONL source marker. Optional only for catalog entries written before this field existed. */
  sourceMtimeMs?: number;
  /** JSONL source marker. Optional only for catalog entries written before this field existed. */
  sourceSizeBytes?: number;
  head?: SessionCatalogCursor;
  health: SessionCatalogHealth;
  diagnostic?: string;
}

export interface SessionCatalogOptions {
  baseDirectory?: string;
}

export class SessionCatalog {
  readonly baseDirectory: string;
  readonly entriesDirectory: string;

  constructor(options: SessionCatalogOptions = {}) {
    this.baseDirectory = resolve(
      options.baseDirectory ?? join(homedir(), ".pico", "session-catalog"),
    );
    this.entriesDirectory = join(this.baseDirectory, "entries");
  }

  async upsert(entry: SessionCatalogEntry): Promise<void> {
    const normalized = normalizeEntry(entry);
    await writeJsonAtomic(this.entryPath(normalized.logId), normalized);
  }

  async get(logId: string): Promise<SessionCatalogEntry | undefined> {
    const path = this.entryPath(logId);
    try {
      const parsed = parseEntry(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (parsed) return parsed;
      await this.quarantineEntry(path, "catalog entry schema is invalid");
      return undefined;
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return undefined;
      await this.quarantineEntry(path, describeError(error)).catch(() => undefined);
      return undefined;
    }
  }

  async list(
    options: {
      sessionProjectDir?: string;
      includeUnhealthy?: boolean;
    } = {},
  ): Promise<SessionCatalogEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.entriesDirectory);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return [];
      throw error;
    }

    const projectDir = options.sessionProjectDir
      ? resolve(options.sessionProjectDir).normalize("NFC")
      : undefined;
    const entries: SessionCatalogEntry[] = [];
    for (const name of names.toSorted()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = parseEntry(
          JSON.parse(await readFile(join(this.entriesDirectory, name), "utf8")) as unknown,
        );
        if (!parsed) {
          await this.quarantineEntry(
            join(this.entriesDirectory, name),
            "catalog entry schema is invalid",
          );
          continue;
        }
        if (!options.includeUnhealthy && parsed.health !== "healthy") continue;
        if (projectDir && parsed.identity.sessionProjectDir !== projectDir) continue;
        entries.push(parsed);
      } catch (error) {
        // Catalog is a derived index. Quarantine malformed entries; JSONL remains recoverable.
        await this.quarantineEntry(join(this.entriesDirectory, name), describeError(error)).catch(
          () => undefined,
        );
      }
    }
    return entries.toSorted(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.sessionId.localeCompare(left.sessionId),
    );
  }

  async remove(logId: string): Promise<void> {
    await rm(this.entryPath(logId), { force: true });
  }

  private entryPath(logId: string): string {
    if (!SAFE_LOG_ID.test(logId)) throw new Error(`Invalid session log ID: ${logId}`);
    return join(this.entriesDirectory, `${logId}.json`);
  }

  private async quarantineEntry(path: string, reason: string): Promise<void> {
    await quarantineCorruptJson(path, {
      component: "session-catalog",
      reason,
      recommendation: "Run /doctor or reopen /sessions to rebuild this derived entry from JSONL.",
    });
  }
}

function normalizeEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
  const parsed = parseEntry(entry);
  if (!parsed) throw new Error("Invalid session catalog entry");
  return parsed;
}

function parseEntry(value: unknown): SessionCatalogEntry | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== SESSION_CATALOG_VERSION) return undefined;
  const identity = parseIdentity(value["identity"]);
  const lineage = parseLineage(value["lineage"]);
  const head = value["head"] === undefined ? undefined : parseCursor(value["head"]);
  const health = value["health"];
  if (
    typeof value["logId"] !== "string" ||
    !SAFE_LOG_ID.test(value["logId"]) ||
    typeof value["sessionId"] !== "string" ||
    value["sessionId"].length === 0 ||
    typeof value["logPath"] !== "string" ||
    !identity ||
    !lineage ||
    !isNonNegativeInteger(value["messageCount"]) ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    typeof value["lastOpenedAt"] !== "string" ||
    !isNonNegativeInteger(value["journalSchemaVersion"]) ||
    !isOptionalNonNegativeNumber(value["sourceMtimeMs"]) ||
    !isOptionalNonNegativeInteger(value["sourceSizeBytes"]) ||
    !isCatalogHealth(health) ||
    (value["head"] !== undefined && !head) ||
    !isOptionalString(value["title"]) ||
    !isOptionalString(value["firstUserMessage"]) ||
    !isOptionalString(value["lastUserMessage"]) ||
    !isOptionalString(value["diagnostic"])
  ) {
    return undefined;
  }
  return {
    schemaVersion: SESSION_CATALOG_VERSION,
    logId: value["logId"],
    sessionId: value["sessionId"],
    logPath: resolve(value["logPath"]).normalize("NFC"),
    identity,
    lineage,
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(typeof value["firstUserMessage"] === "string"
      ? { firstUserMessage: value["firstUserMessage"] }
      : {}),
    ...(typeof value["lastUserMessage"] === "string"
      ? { lastUserMessage: value["lastUserMessage"] }
      : {}),
    messageCount: value["messageCount"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
    lastOpenedAt: value["lastOpenedAt"],
    journalSchemaVersion: value["journalSchemaVersion"],
    ...(typeof value["sourceMtimeMs"] === "number"
      ? { sourceMtimeMs: value["sourceMtimeMs"] }
      : {}),
    ...(typeof value["sourceSizeBytes"] === "number"
      ? { sourceSizeBytes: value["sourceSizeBytes"] }
      : {}),
    ...(head ? { head } : {}),
    health,
    ...(typeof value["diagnostic"] === "string" ? { diagnostic: value["diagnostic"] } : {}),
  };
}

function parseIdentity(value: unknown): SessionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["sessionId", "originalCwd", "projectRoot", "cwd", "sessionProjectDir"] as const;
  if (!keys.every((key) => typeof value[key] === "string" && value[key].length > 0)) {
    return undefined;
  }
  return {
    sessionId: value["sessionId"] as string,
    originalCwd: resolve(value["originalCwd"] as string).normalize("NFC"),
    projectRoot: resolve(value["projectRoot"] as string).normalize("NFC"),
    cwd: resolve(value["cwd"] as string).normalize("NFC"),
    sessionProjectDir: resolve(value["sessionProjectDir"] as string).normalize("NFC"),
  };
}

function parseLineage(value: unknown): SessionCatalogLineage | undefined {
  if (
    !isRecord(value) ||
    !isRelation(value["relation"]) ||
    typeof value["rootLogId"] !== "string"
  ) {
    return undefined;
  }
  for (const key of ["parentLogId", "forkEventId", "parentSessionId", "parentTaskId"] as const) {
    if (!isOptionalString(value[key])) return undefined;
  }
  return {
    relation: value["relation"],
    rootLogId: value["rootLogId"],
    ...(typeof value["parentLogId"] === "string" ? { parentLogId: value["parentLogId"] } : {}),
    ...(typeof value["forkEventId"] === "string" ? { forkEventId: value["forkEventId"] } : {}),
    ...(typeof value["parentSessionId"] === "string"
      ? { parentSessionId: value["parentSessionId"] }
      : {}),
    ...(typeof value["parentTaskId"] === "string" ? { parentTaskId: value["parentTaskId"] } : {}),
  };
}

function parseCursor(value: unknown): SessionCatalogCursor | undefined {
  if (
    !isRecord(value) ||
    typeof value["logId"] !== "string" ||
    value["logId"].length === 0 ||
    !isNonNegativeInteger(value["epoch"]) ||
    !isNonNegativeInteger(value["seq"]) ||
    typeof value["eventId"] !== "string" ||
    value["eventId"].length === 0
  ) {
    return undefined;
  }
  return {
    logId: value["logId"],
    epoch: value["epoch"],
    seq: value["seq"],
    eventId: value["eventId"],
  };
}

function isRelation(value: unknown): value is SessionCatalogLineage["relation"] {
  return value === "root" || value === "fork" || value === "spawn" || value === "salvage";
}

function isCatalogHealth(value: unknown): value is SessionCatalogHealth {
  return (
    value === "healthy" || value === "stale" || value === "quarantined" || value === "incompatible"
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
