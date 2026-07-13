import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "pathe";
import { isDeepStrictEqual } from "node:util";
import { logger } from "../observability/logger.js";
import type {
  SessionSummaryBasis,
  SessionSummaryStore,
  StoredSessionSummary,
} from "./memory-store.js";

const LEGACY_SUMMARY_FILE_VERSION = 1;
const SUMMARY_FILE_VERSION = 2 as const;

interface SummaryFileV2 {
  schemaVersion: typeof SUMMARY_FILE_VERSION;
  sessionId: string;
  summary: StoredSessionSummary & { basis: SessionSummaryBasis };
}

interface SummaryCompatibilityIndexV2 {
  schemaVersion: typeof SUMMARY_FILE_VERSION;
  summaries: Record<string, StoredSessionSummary>;
}

export interface SessionSummaryStoreOptions {
  persistent: boolean;
  /** legacy 聚合文件路径；v2 会在同级 summaries/ 中按 session 分文件保存。 */
  filePath: string;
}

export class SummaryCloneConflictError extends Error {
  constructor(
    readonly sourceSessionId: string,
    readonly targetSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "SummaryCloneConflictError";
  }
}

export class SummaryIntegrityError extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SummaryIntegrityError";
  }
}

export interface SummaryCloneResult {
  sourceSessionId: string;
  targetSessionId: string;
  created: boolean;
  summary: StoredSessionSummary | null;
}

/** Process-local summary storage used when durable persistence is disabled. */
export class InMemorySessionSummaryStore implements SessionSummaryStore {
  protected readonly summaries = new Map<string, StoredSessionSummary>();

  get persistent(): boolean {
    return false;
  }

  save(
    sessionId: string,
    summary: string,
    messageCount: number,
    basis: SessionSummaryBasis = {
      throughEventId: null,
      messageCount,
      prefixDigest: null,
    },
  ): void {
    assertSummaryBasis(basis, messageCount);
    const now = new Date().toISOString();
    const existing = this.summaries.get(sessionId);
    this.summaries.set(sessionId, {
      sessionId,
      summary,
      messageCount,
      basis: { ...basis },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  get(sessionId: string): StoredSessionSummary | null {
    const summary = this.summaries.get(sessionId);
    return summary ? cloneSummary(summary) : null;
  }
}

/**
 * v2 以每个 Session 一个原子 JSON 文件为权威状态。legacy 聚合文件只用于
 * 首次导入与一个兼容周期的可见索引，损坏时不会破坏已发布的 per-session 文件。
 */
export class FileSessionSummaryStore
  extends InMemorySessionSummaryStore
  implements SessionSummaryStore
{
  private persistenceAvailable = true;
  private temporaryFileSequence = 0;
  private readonly summariesDirectory: string;
  private readonly compatibilityFallbacks = new Map<string, StoredSessionSummary>();
  private compatibilityIndexError: unknown;

  constructor(private readonly filePath: string) {
    super();
    this.summariesDirectory = join(dirname(filePath), basename(filePath, ".json"));
    this.loadCompatibilityIndex();
  }

  override get persistent(): boolean {
    return this.persistenceAvailable;
  }

  override save(
    sessionId: string,
    summary: string,
    messageCount: number,
    basis?: SessionSummaryBasis,
  ): void {
    super.save(sessionId, summary, messageCount, basis);
    this.compatibilityFallbacks.delete(sessionId);
    const stored = this.summaries.get(sessionId)!;
    if (!stored.basis) throw new Error("Summary basis was not initialized");
    try {
      writeJsonAtomicSync(
        this.sessionPath(sessionId),
        {
          schemaVersion: SUMMARY_FILE_VERSION,
          sessionId,
          summary: { ...stored, basis: stored.basis },
        } satisfies SummaryFileV2,
        this.temporaryFileSequence++,
      );
      this.persistCompatibilityIndex();
      this.persistenceAvailable = true;
    } catch (error) {
      this.persistenceAvailable = false;
      logger.warn(
        { error, sessionId, filePath: this.sessionPath(sessionId) },
        "持久化会话摘要 v2 失败，保留进程内最新摘要",
      );
    }
  }

  override get(sessionId: string): StoredSessionSummary | null {
    const cached = super.get(sessionId);
    if (cached) return cached;
    try {
      const path = this.sessionPath(sessionId);
      if (existsSync(path)) {
        const file = parseSummaryFileV2(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
          sessionId,
        );
        this.summaries.set(sessionId, file.summary);
        return cloneSummary(file.summary);
      }
      const fallback = this.compatibilityFallbacks.get(sessionId);
      return fallback ? cloneSummary(fallback) : null;
    } catch (error) {
      this.persistenceAvailable = false;
      logger.warn({ error, sessionId }, "读取 per-session 会话摘要失败");
      return null;
    }
  }

  /** Rewind 截断到 basis 之前时使摘要失效，不猜测修剪摘要文本。 */
  invalidateIfBeyond(sessionId: string, boundary: SessionSummaryBasis): boolean {
    const summary = this.get(sessionId);
    if (!summary?.basis || isSummaryBasisCovered(summary.basis, boundary)) return false;
    this.summaries.delete(sessionId);
    this.compatibilityFallbacks.delete(sessionId);
    try {
      try {
        unlinkSync(this.sessionPath(sessionId));
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") throw error;
      }
      this.persistCompatibilityIndex();
      return true;
    } catch (error) {
      this.persistenceAvailable = false;
      logger.warn({ error, sessionId }, "使会话摘要失效时持久化失败");
      return false;
    }
  }

  /** Fork 保留摘要的 basis，但为目标会话发布独立 commit marker。 */
  cloneSession(sourceSessionId: string, targetSessionId: string): SummaryCloneResult {
    const source = this.resolveCloneSource(sourceSessionId);
    if (!source) {
      return { sourceSessionId, targetSessionId, created: false, summary: null };
    }
    const clonedSummary: StoredSessionSummary & { basis: SessionSummaryBasis } = {
      ...source.summary,
      sessionId: targetSessionId,
      basis: { ...source.summary.basis },
    };
    const targetFile = {
      schemaVersion: SUMMARY_FILE_VERSION,
      sessionId: targetSessionId,
      summary: clonedSummary,
    } satisfies SummaryFileV2;
    const targetPath = this.sessionPath(targetSessionId);

    if (existsSync(targetPath)) {
      const existing = this.readSummaryFileStrict(targetPath, targetSessionId);
      if (!isDeepStrictEqual(existing, targetFile)) {
        throw new SummaryCloneConflictError(
          sourceSessionId,
          targetSessionId,
          `目标会话已存在不同的摘要: ${targetPath}`,
        );
      }
      this.summaries.set(targetSessionId, clonedSummary);
      return {
        sourceSessionId,
        targetSessionId,
        created: false,
        summary: cloneSummary(clonedSummary),
      };
    }

    writeJsonAtomicSync(targetPath, targetFile, this.temporaryFileSequence++);
    this.summaries.set(targetSessionId, clonedSummary);
    this.compatibilityFallbacks.delete(targetSessionId);
    this.persistCompatibilityIndex();
    return {
      sourceSessionId,
      targetSessionId,
      created: true,
      summary: cloneSummary(clonedSummary),
    };
  }

  private resolveCloneSource(sessionId: string): SummaryFileV2 | undefined {
    const path = this.sessionPath(sessionId);
    if (existsSync(path)) return this.readSummaryFileStrict(path, sessionId);
    if (this.compatibilityIndexError) {
      throw new SummaryIntegrityError(
        sessionId,
        `会话摘要兼容索引损坏，无法判定源摘要是否存在: ${this.filePath}`,
        this.compatibilityIndexError,
      );
    }
    const fallback = this.compatibilityFallbacks.get(sessionId);
    if (!fallback) return undefined;

    const migratedSummary: StoredSessionSummary & { basis: SessionSummaryBasis } = {
      ...fallback,
      basis: fallback.basis
        ? { ...fallback.basis }
        : {
            throughEventId: null,
            messageCount: fallback.messageCount,
            prefixDigest: null,
          },
    };
    const migrated = {
      schemaVersion: SUMMARY_FILE_VERSION,
      sessionId,
      summary: migratedSummary,
    } satisfies SummaryFileV2;
    try {
      writeJsonAtomicSync(path, migrated, this.temporaryFileSequence++);
      this.summaries.set(sessionId, migratedSummary);
      this.compatibilityFallbacks.delete(sessionId);
      this.persistCompatibilityIndex();
      return migrated;
    } catch (error) {
      throw new SummaryIntegrityError(sessionId, `迁移 legacy 会话摘要失败: ${path}`, error);
    }
  }

  private readSummaryFileStrict(path: string, sessionId: string): SummaryFileV2 {
    try {
      return parseSummaryFileV2(JSON.parse(readFileSync(path, "utf8")) as unknown, sessionId);
    } catch (error) {
      throw new SummaryIntegrityError(sessionId, `会话摘要损坏，拒绝克隆: ${path}`, error);
    }
  }

  private loadCompatibilityIndex(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      const summaries = parseCompatibilityIndex(parsed);
      for (const summary of Object.values(summaries)) {
        this.compatibilityFallbacks.set(summary.sessionId, summary);
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return;
      // 聚合索引不再是权威源；损坏不禁用 per-session 读取。
      this.compatibilityIndexError = error;
      logger.warn({ error, filePath: this.filePath }, "会话摘要兼容索引无效");
    }
  }

  private persistCompatibilityIndex(): void {
    writeJsonAtomicSync(
      this.filePath,
      {
        schemaVersion: SUMMARY_FILE_VERSION,
        summaries: Object.fromEntries(new Map([...this.compatibilityFallbacks, ...this.summaries])),
      } satisfies SummaryCompatibilityIndexV2,
      this.temporaryFileSequence++,
    );
    this.compatibilityIndexError = undefined;
  }

  private sessionPath(sessionId: string): string {
    const safeName = createHash("sha256").update(sessionId).digest("hex");
    return join(this.summariesDirectory, `${safeName}.json`);
  }
}

export function createSessionSummaryStore(
  options: SessionSummaryStoreOptions,
): SessionSummaryStore {
  return options.persistent
    ? new FileSessionSummaryStore(options.filePath)
    : new InMemorySessionSummaryStore();
}

export function isSummaryBasisCovered(
  summaryBasis: SessionSummaryBasis,
  boundary: SessionSummaryBasis,
): boolean {
  if (summaryBasis.messageCount > boundary.messageCount) return false;
  if (
    summaryBasis.prefixDigest !== null &&
    boundary.prefixDigest !== null &&
    summaryBasis.prefixDigest !== boundary.prefixDigest
  ) {
    return false;
  }
  if (
    summaryBasis.messageCount === boundary.messageCount &&
    summaryBasis.throughEventId !== null &&
    boundary.throughEventId !== null &&
    summaryBasis.throughEventId !== boundary.throughEventId
  ) {
    return false;
  }
  return true;
}

function parseCompatibilityIndex(value: unknown): Record<string, StoredSessionSummary> {
  if (!isRecord(value) || !isRecord(value.summaries)) throw new Error("Invalid summary index");
  if (
    value.version !== LEGACY_SUMMARY_FILE_VERSION &&
    value.schemaVersion !== SUMMARY_FILE_VERSION
  ) {
    throw new Error("Unsupported summary index version");
  }
  const summaries: Record<string, StoredSessionSummary> = {};
  for (const [sessionId, candidate] of Object.entries(value.summaries)) {
    const summary = parseStoredSessionSummary(candidate);
    if (!summary || summary.sessionId !== sessionId) throw new Error("Invalid stored summary");
    summaries[sessionId] = summary;
  }
  return summaries;
}

function parseSummaryFileV2(value: unknown, sessionId: string): SummaryFileV2 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SUMMARY_FILE_VERSION ||
    value.sessionId !== sessionId
  ) {
    throw new Error("Invalid per-session summary file");
  }
  const summary = parseStoredSessionSummary(value.summary);
  if (!summary?.basis || summary.sessionId !== sessionId) {
    throw new Error("Invalid per-session summary payload");
  }
  return {
    schemaVersion: SUMMARY_FILE_VERSION,
    sessionId,
    summary: { ...summary, basis: summary.basis },
  };
}

function parseStoredSessionSummary(value: unknown): StoredSessionSummary | undefined {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.summary !== "string" ||
    !isNonNegativeInteger(value.messageCount) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isOptionalSummaryBasis(value.basis, value.messageCount)
  ) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    summary: value.summary,
    messageCount: value.messageCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.basis ? { basis: value.basis } : {}),
  };
}

function isOptionalSummaryBasis(
  value: unknown,
  messageCount: number,
): value is SessionSummaryBasis | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    (value.throughEventId === null || typeof value.throughEventId === "string") &&
    value.messageCount === messageCount &&
    (value.prefixDigest === null ||
      (typeof value.prefixDigest === "string" && /^[a-f0-9]{64}$/u.test(value.prefixDigest)))
  );
}

function assertSummaryBasis(basis: SessionSummaryBasis, messageCount: number): void {
  if (!isOptionalSummaryBasis(basis, messageCount)) {
    throw new Error("Summary basis must match messageCount and use a SHA-256 prefixDigest");
  }
}

function cloneSummary(summary: StoredSessionSummary): StoredSessionSummary {
  return { ...summary, ...(summary.basis ? { basis: { ...summary.basis } } : {}) };
}

function writeJsonAtomicSync(path: string, value: unknown, sequence: number): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${sequence}.tmp`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let fileDescriptor: number | undefined;
  let published = false;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, path);
    published = true;
    chmodSync(path, 0o600);
    syncDirectory(directory);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 临时文件可能尚未创建。
      }
    }
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      !new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(getErrorCode(error) ?? "")
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
