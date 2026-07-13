import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { replaySessionRecords } from "../engine/session-reducer.js";
import {
  SessionStore,
  type LegacySessionRecord,
  type SessionCursor,
  type SessionEvent,
  type SessionJournalSnapshot,
  type SessionLineage,
  type SessionMetaV3,
} from "../engine/session-store.js";
import { createSessionIdentity, type SessionIdentity } from "../engine/session-identity.js";
import { logger } from "../observability/logger.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import { readVersionedJson, writeJsonAtomic } from "./atomic-json.js";
import {
  SessionCatalog,
  type SessionCatalogEntry,
  type SessionCatalogLineage,
} from "./session-catalog.js";

const PROJECTION_HEALTH_VERSION = 1 as const;
const CATALOG_RECOMMENDATION =
  "Run /sessions to rebuild the derived catalog from JSONL; use /doctor to inspect remaining failures.";

export type SessionCatalogProjectionState = "healthy" | "stale" | "degraded";

export interface SessionCatalogProjectionHealth {
  readonly schemaVersion: typeof PROJECTION_HEALTH_VERSION;
  readonly state: SessionCatalogProjectionState;
  readonly checkedAt: string;
  readonly recommendation: string;
  readonly diagnostic?: string;
}

export interface SessionCatalogProjectionResult {
  readonly entry?: SessionCatalogEntry;
  readonly health: SessionCatalogProjectionHealth;
}

export interface SessionCatalogWorkspaceSyncResult {
  readonly entries: readonly SessionCatalogEntry[];
  readonly health: SessionCatalogProjectionHealth;
}

interface JournalCandidate {
  entry: SessionCatalogEntry;
  readonly forkFrom?: string;
  readonly needsWrite: boolean;
}

/**
 * JSONL -> Session Catalog 单向投影。任何 Catalog 故障都只会降级索引，
 * 不能改变已 fdatasync 的 Session 提交结果。
 */
export class SessionCatalogProjector {
  private readonly healthByWorkDir = new Map<string, SessionCatalogProjectionHealth>();

  constructor(readonly catalog: SessionCatalog = new SessionCatalog()) {}

  /** durable commit 热路径：直接写 Session 已维护的 O(1) 摘要，不重放 JSONL。 */
  async projectEntry(entry: SessionCatalogEntry): Promise<SessionCatalogProjectionResult> {
    const workDir = workDirFromLogPath(entry.logPath);
    try {
      const projected = {
        ...entry,
        health: "healthy",
        diagnostic: undefined,
      } satisfies SessionCatalogEntry;
      await this.catalog.upsert(projected);
      const health = await this.recordHealthy(workDir);
      return { entry: projected, health };
    } catch (error) {
      const health = await this.recordFailure(workDir, error);
      logger.warn(
        { logId: entry.logId, error: describeError(error) },
        "[session-catalog] 增量目录投影失败，JSONL 提交保持有效",
      );
      return { health };
    }
  }

  async projectJournal(
    logPath: string,
    options: { openedAt?: string } = {},
  ): Promise<SessionCatalogProjectionResult> {
    const normalizedLogPath = resolve(logPath).normalize("NFC");
    const workDir = workDirFromLogPath(normalizedLogPath);
    try {
      const existing = await this.catalog.list({
        sessionProjectDir: workDir,
        includeUnhealthy: true,
      });
      const existingBySession = new Map(existing.map((entry) => [entry.sessionId, entry]));
      const prior = existing.find((entry) => entry.logPath === normalizedLogPath);
      const candidate = await deriveJournalCandidate(normalizedLogPath, workDir, prior, options);
      candidate.entry = resolveCandidateLineage(candidate, existingBySession);
      await this.catalog.upsert(candidate.entry);
      const health = await this.recordHealthy(workDir);
      return { entry: candidate.entry, health };
    } catch (error) {
      const health = await this.recordFailure(workDir, error);
      logger.warn(
        { logPath: normalizedLogPath, error: describeError(error) },
        "[session-catalog] 目录投影失败，JSONL 提交保持有效",
      );
      return { health };
    }
  }

  /** 浏览会话前的增量 backfill；损坏目录项会由 SessionCatalog 隔离。 */
  async syncWorkspace(workDir: string): Promise<SessionCatalogWorkspaceSyncResult> {
    const normalizedWorkDir = resolve(workDir).normalize("NFC");
    try {
      const existing = await this.catalog.list({
        sessionProjectDir: normalizedWorkDir,
        includeUnhealthy: true,
      });
      const existingByPath = new Map(existing.map((entry) => [entry.logPath, entry]));
      const candidates: JournalCandidate[] = [];
      const staleDiagnostics: string[] = [];

      for (const logPath of await listSessionLogPaths(normalizedWorkDir)) {
        const info = await stat(logPath);
        const prior = existingByPath.get(logPath);
        if (
          prior?.health === "healthy" &&
          prior.updatedAt === info.mtime.toISOString() &&
          prior.journalSchemaVersion >= 0
        ) {
          candidates.push({ entry: prior, needsWrite: false });
          continue;
        }
        candidates.push(await deriveJournalCandidate(logPath, normalizedWorkDir, prior));
      }

      const bySession = new Map(
        candidates.map((candidate) => [candidate.entry.sessionId, candidate.entry]),
      );
      for (const candidate of candidates) {
        const resolved = resolveCandidateLineage(candidate, bySession);
        const lineageChanged =
          JSON.stringify(resolved.lineage) !== JSON.stringify(candidate.entry.lineage);
        candidate.entry = resolved;
        if (resolved.health === "stale" && resolved.diagnostic) {
          staleDiagnostics.push(resolved.diagnostic);
        }
        if (candidate.needsWrite || lineageChanged) await this.catalog.upsert(candidate.entry);
        bySession.set(candidate.entry.sessionId, candidate.entry);
      }

      const livePaths = new Set(candidates.map((candidate) => candidate.entry.logPath));
      for (const orphan of existing) {
        if (livePaths.has(orphan.logPath)) continue;
        staleDiagnostics.push(`Missing JSONL for catalog log ${orphan.logId}.`);
        if (orphan.health === "stale") continue;
        await this.catalog.upsert({
          ...orphan,
          health: "stale",
          diagnostic: "Session JSONL is not present in the indexed workspace.",
        });
      }

      const health =
        staleDiagnostics.length > 0
          ? await this.recordStale(normalizedWorkDir, staleDiagnostics.join(" "))
          : await this.recordHealthy(normalizedWorkDir);
      return {
        entries: candidates.map((candidate) => candidate.entry),
        health,
      };
    } catch (error) {
      const health = await this.recordFailure(normalizedWorkDir, error);
      logger.warn(
        { workDir: normalizedWorkDir, error: describeError(error) },
        "[session-catalog] 工作区 backfill 失败，浏览器将继续扫描 JSONL",
      );
      return { entries: [], health };
    }
  }

  async getHealth(workDir: string): Promise<SessionCatalogProjectionHealth> {
    const normalized = resolve(workDir).normalize("NFC");
    const inMemory = this.healthByWorkDir.get(normalized);
    if (inMemory) return inMemory;
    return readSessionCatalogProjectionHealth(normalized);
  }

  private async recordHealthy(workDir: string): Promise<SessionCatalogProjectionHealth> {
    const previous = this.healthByWorkDir.get(workDir) ?? (await readPersistedHealth(workDir));
    const health = healthyProjectionHealth();
    this.healthByWorkDir.set(workDir, health);
    if (previous && previous.state !== "healthy") {
      await persistProjectionHealth(workDir, health).catch(() => undefined);
    }
    return health;
  }

  private async recordFailure(
    workDir: string,
    error: unknown,
  ): Promise<SessionCatalogProjectionHealth> {
    const health = {
      schemaVersion: PROJECTION_HEALTH_VERSION,
      state: "degraded",
      checkedAt: new Date().toISOString(),
      recommendation: CATALOG_RECOMMENDATION,
      diagnostic: describeError(error),
    } satisfies SessionCatalogProjectionHealth;
    this.healthByWorkDir.set(workDir, health);
    await persistProjectionHealth(workDir, health).catch((persistError: unknown) => {
      logger.warn(
        { workDir, error: describeError(persistError) },
        "[session-catalog] 投影诊断状态无法落盘",
      );
    });
    return health;
  }

  private async recordStale(
    workDir: string,
    diagnostic: string,
  ): Promise<SessionCatalogProjectionHealth> {
    const health = {
      schemaVersion: PROJECTION_HEALTH_VERSION,
      state: "stale",
      checkedAt: new Date().toISOString(),
      recommendation: CATALOG_RECOMMENDATION,
      diagnostic,
    } satisfies SessionCatalogProjectionHealth;
    this.healthByWorkDir.set(workDir, health);
    await persistProjectionHealth(workDir, health).catch(() => undefined);
    return health;
  }
}

let defaultProjector: SessionCatalogProjector | undefined;

export function getDefaultSessionCatalogProjector(): SessionCatalogProjector {
  defaultProjector ??= new SessionCatalogProjector();
  return defaultProjector;
}

export async function readSessionCatalogProjectionHealth(
  workDir: string,
): Promise<SessionCatalogProjectionHealth> {
  return (
    (await readPersistedHealth(resolve(workDir).normalize("NFC"))) ?? healthyProjectionHealth()
  );
}

function healthyProjectionHealth(): SessionCatalogProjectionHealth {
  return {
    schemaVersion: PROJECTION_HEALTH_VERSION,
    state: "healthy",
    checkedAt: new Date().toISOString(),
    recommendation: CATALOG_RECOMMENDATION,
  };
}

async function deriveJournalCandidate(
  logPath: string,
  workDir: string,
  existing?: SessionCatalogEntry,
  options: { openedAt?: string } = {},
): Promise<JournalCandidate> {
  const info = await stat(logPath);
  const snapshot = await new SessionStore(logPath).inspectJournal();
  const replay = replaySessionRecords(snapshot.records);
  const metadata = snapshot.metadata;
  const v3 = isV3Metadata(metadata) ? metadata : undefined;
  const sessionId = v3?.sessionId ?? metadata?.sessionId ?? basename(logPath, ".jsonl");
  const identity = v3?.identity ?? legacyIdentity(sessionId, workDir, metadata);
  const logId = v3?.logId ?? legacyLogId(logPath);
  const updatedAt = info.mtime.toISOString();
  const createdAt =
    v3?.createdAt ?? new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs).toISOString();
  const visibleUsers = replay.history.filter(
    (message) =>
      message.role === "user" &&
      message.toolCallId === undefined &&
      !isMessageHiddenFromTranscript(message) &&
      message.content.trim().length > 0,
  );
  const firstUserMessage = compactText(visibleUsers[0]?.content);
  const lastUserMessage = compactText(visibleUsers.at(-1)?.content);
  const title = compactText(replay.runtime.settings?.title) ?? firstUserMessage;
  const seededLineage = findSeededLineage(snapshot);
  const lineage = catalogLineage(
    seededLineage ?? v3?.lineage,
    logId,
    replay.runtime.settings?.forkFrom,
  );
  const head = deriveHeadCursor(logId, snapshot.records);
  const entry = {
    schemaVersion: 1,
    logId,
    sessionId,
    logPath,
    identity,
    lineage,
    ...(title ? { title } : {}),
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
    messageCount: replay.history.length,
    createdAt,
    updatedAt,
    lastOpenedAt: options.openedAt ?? existing?.lastOpenedAt ?? updatedAt,
    journalSchemaVersion: metadata?.schemaVersion ?? 0,
    ...(head ? { head } : {}),
    health: "healthy",
  } satisfies SessionCatalogEntry;
  return {
    entry,
    ...(replay.runtime.settings?.forkFrom ? { forkFrom: replay.runtime.settings.forkFrom } : {}),
    needsWrite: true,
  };
}

function resolveCandidateLineage(
  candidate: JournalCandidate,
  bySession: ReadonlyMap<string, SessionCatalogEntry>,
): SessionCatalogEntry {
  if (!candidate.forkFrom) return candidate.entry;
  const parent = bySession.get(candidate.forkFrom);
  if (!parent) {
    return {
      ...candidate.entry,
      lineage: {
        relation: "fork",
        rootLogId: candidate.entry.lineage.rootLogId,
        parentSessionId: candidate.forkFrom,
      },
      health: "stale",
      diagnostic: `Fork parent ${candidate.forkFrom} is not indexed yet.`,
    };
  }
  const existingFork =
    candidate.entry.lineage.relation === "fork" ? candidate.entry.lineage : undefined;
  return {
    ...candidate.entry,
    lineage: {
      relation: "fork",
      rootLogId: parent.lineage.rootLogId,
      parentLogId: existingFork?.parentLogId ?? parent.logId,
      ...((existingFork?.forkEventId ?? parent.head?.eventId)
        ? { forkEventId: existingFork?.forkEventId ?? parent.head?.eventId }
        : {}),
      parentSessionId: candidate.forkFrom,
    },
    health: "healthy",
    diagnostic: undefined,
  };
}

function catalogLineage(
  lineage: SessionLineage | undefined,
  ownLogId: string,
  parentSessionId: string | undefined,
): SessionCatalogLineage {
  if (!lineage || lineage.relation === "root") {
    return {
      relation: "root",
      rootLogId: lineage?.rootLogId ?? ownLogId,
    };
  }
  return {
    relation: lineage.relation,
    rootLogId: lineage.rootLogId,
    ...(lineage.parent ? { parentLogId: lineage.parent.logId } : {}),
    ...(lineage.relation === "fork" && lineage.parent
      ? { forkEventId: lineage.parent.eventId }
      : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(lineage.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
  };
}

function findSeededLineage(snapshot: SessionJournalSnapshot): SessionLineage | undefined {
  for (let index = snapshot.records.length - 1; index >= 0; index--) {
    const record = snapshot.records[index];
    if (record?.type !== "event" || record.kind !== "session.seeded") continue;
    return record.data.lineage;
  }
  return undefined;
}

function deriveHeadCursor(
  logId: string,
  records: readonly (LegacySessionRecord | SessionEvent)[],
): SessionCursor | undefined {
  const head = records.at(-1);
  if (!head) return undefined;
  let epoch = 0;
  for (const record of records) {
    if (record.type === "event") epoch = Math.max(epoch, record.epoch);
    else if (record.type === "truncate" || record.type === "undo" || record.type === "rewind_to") {
      epoch++;
    }
  }
  return {
    logId,
    seq: head.seq,
    epoch,
    eventId: head.type === "event" ? head.eventId : `legacy:${head.seq}:${head.type}`,
  };
}

function isV3Metadata(metadata: SessionJournalSnapshot["metadata"]): metadata is SessionMetaV3 {
  return metadata?.schemaVersion === 3 && "logId" in metadata && "identity" in metadata;
}

function legacyIdentity(
  sessionId: string,
  workDir: string,
  metadata: SessionJournalSnapshot["metadata"],
): SessionIdentity {
  if (metadata && !isV3Metadata(metadata)) {
    return createSessionIdentity({
      sessionId,
      cwd: metadata.cwd ?? workDir,
      originalCwd: metadata.originalCwd ?? workDir,
      projectRoot: metadata.projectRoot ?? workDir,
      sessionProjectDir: metadata.sessionProjectDir ?? workDir,
    });
  }
  return createSessionIdentity({ sessionId, cwd: workDir });
}

function legacyLogId(logPath: string): string {
  return `legacy-${createHash("sha256").update(resolve(logPath)).digest("hex").slice(0, 24)}`;
}

async function listSessionLogPaths(workDir: string): Promise<string[]> {
  const directory = join(workDir, ".claw", "sessions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = resolve(directory, name).normalize("NFC");
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) paths.push(path);
  }
  return paths;
}

function workDirFromLogPath(logPath: string): string {
  return resolve(dirname(dirname(dirname(logPath)))).normalize("NFC");
}
function projectionHealthPath(workDir: string): string {
  return join(workDir, ".claw", "session-catalog-health.json");
}

async function readPersistedHealth(
  workDir: string,
): Promise<SessionCatalogProjectionHealth | undefined> {
  try {
    return await readVersionedJson(projectionHealthPath(workDir), decodeProjectionHealth);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
    return {
      schemaVersion: PROJECTION_HEALTH_VERSION,
      state: "stale",
      checkedAt: new Date().toISOString(),
      recommendation: CATALOG_RECOMMENDATION,
      diagnostic: `Catalog health sidecar is unreadable: ${describeError(error)}`,
    };
  }
}

async function persistProjectionHealth(
  workDir: string,
  health: SessionCatalogProjectionHealth,
): Promise<void> {
  await writeJsonAtomic(projectionHealthPath(workDir), health);
}

function decodeProjectionHealth(value: unknown): SessionCatalogProjectionHealth {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== PROJECTION_HEALTH_VERSION ||
    !isProjectionState(value["state"]) ||
    typeof value["checkedAt"] !== "string" ||
    typeof value["recommendation"] !== "string" ||
    (value["diagnostic"] !== undefined && typeof value["diagnostic"] !== "string")
  ) {
    throw new Error("invalid session catalog health sidecar");
  }
  return {
    schemaVersion: PROJECTION_HEALTH_VERSION,
    state: value["state"],
    checkedAt: value["checkedAt"],
    recommendation: value["recommendation"],
    ...(typeof value["diagnostic"] === "string" ? { diagnostic: value["diagnostic"] } : {}),
  };
}

function compactText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

function isProjectionState(value: unknown): value is SessionCatalogProjectionState {
  return value === "healthy" || value === "stale" || value === "degraded";
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
