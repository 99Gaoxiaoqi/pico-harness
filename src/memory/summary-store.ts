import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
const LEGACY_SUMMARY_SNAPSHOT_SUFFIX = ".migrating-v2";
const LEGACY_SUMMARY_ARCHIVE_SUFFIX = ".migrated-v2";

interface SummaryFileV2 {
  schemaVersion: typeof SUMMARY_FILE_VERSION;
  sessionId: string;
  summary: StoredSessionSummary & { basis: SessionSummaryBasis };
}

export interface SessionSummaryStoreOptions {
  persistent: boolean;
  /** legacy 聚合文件路径；仅用于向同级 summaries/ 的一次性迁移。 */
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

export class SummaryMigrationError extends Error {
  constructor(
    readonly sourcePath: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SummaryMigrationError";
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
 * v2 以每个 Session 一个原子 JSON 文件为唯一权威状态。legacy 聚合文件仅在
 * 构造时执行一次性迁移，全部条目发布成功后才归档，运行期不再读写聚合索引。
 */
export class FileSessionSummaryStore
  extends InMemorySessionSummaryStore
  implements SessionSummaryStore
{
  private persistenceAvailable = true;
  private temporaryFileSequence = 0;
  private readonly summariesDirectory: string;

  constructor(filePath: string) {
    super();
    this.summariesDirectory = join(dirname(filePath), basename(filePath, ".json"));
    this.migrateLegacyIndex(filePath);
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
      return null;
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
    try {
      try {
        unlinkSync(this.sessionPath(sessionId));
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") throw error;
      }
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
    return undefined;
  }

  private readSummaryFileStrict(path: string, sessionId: string): SummaryFileV2 {
    try {
      return parseSummaryFileV2(JSON.parse(readFileSync(path, "utf8")) as unknown, sessionId);
    } catch (error) {
      throw new SummaryIntegrityError(sessionId, `per-session 会话摘要损坏: ${path}`, error);
    }
  }

  private migrateLegacyIndex(filePath: string): void {
    const snapshotPath = `${filePath}${LEGACY_SUMMARY_SNAPSHOT_SUFFIX}`;
    const archivePath = `${filePath}${LEGACY_SUMMARY_ARCHIVE_SUFFIX}`;
    // 归档文件同时是完成标记；即使旧进程重新生成 aggregate，也不得再次参与读取。
    if (existsSync(archivePath)) {
      this.syncMigrationDirectory(filePath, "确认 legacy 聚合索引完成标记失败");
      return;
    }
    if (!this.captureLegacySnapshot(filePath, snapshotPath, archivePath)) return;

    if (existsSync(archivePath)) {
      this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引完成标记失败");
      return;
    }

    let summaries: Record<string, StoredSessionSummary>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"));
      summaries = parseLegacySummaryIndex(parsed);
    } catch (error) {
      if (existsSync(archivePath)) {
        this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引完成标记失败");
        return;
      }
      throw summaryMigrationError(
        filePath,
        `读取或解析 legacy 聚合索引固定快照失败（快照保留: ${snapshotPath}）`,
        error,
      );
    }

    for (const summary of Object.values(summaries)) {
      const migratedSummary = withSummaryBasis(summary);
      const targetPath = this.sessionPath(summary.sessionId);
      try {
        const created = writeJsonAtomicIfAbsentSync(
          targetPath,
          {
            schemaVersion: SUMMARY_FILE_VERSION,
            sessionId: summary.sessionId,
            summary: migratedSummary,
          } satisfies SummaryFileV2,
          this.temporaryFileSequence++,
        );
        if (!created) this.readSummaryFileStrict(targetPath, summary.sessionId);
      } catch (error) {
        throw summaryMigrationError(
          filePath,
          `发布或校验会话 ${JSON.stringify(summary.sessionId)} 的 per-session 摘要失败（快照保留: ${snapshotPath}）`,
          error,
        );
      }
    }

    if (existsSync(archivePath)) {
      this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引完成标记失败");
      return;
    }
    try {
      renameSync(snapshotPath, archivePath);
    } catch (error) {
      if (existsSync(archivePath)) {
        this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引完成标记失败");
        return;
      }
      throw summaryMigrationError(
        filePath,
        `归档 legacy 聚合索引固定快照失败（快照保留: ${snapshotPath}）`,
        error,
      );
    }
    // 不删除原 aggregate：它可能已被并发旧 writer 替换。archive marker 会让新 Runtime 永久忽略它。
    this.syncMigrationDirectory(filePath, `持久化 legacy 聚合索引完成标记失败: ${archivePath}`);
  }

  private captureLegacySnapshot(
    filePath: string,
    snapshotPath: string,
    archivePath: string,
  ): boolean {
    if (existsSync(snapshotPath)) {
      this.syncMigrationDirectory(filePath, "确认 legacy 聚合索引固定快照失败");
      return true;
    }

    try {
      // hard link 固定本次迁移快照；旧 writer 后续替换 aggregate 不会改变快照内容。
      linkSync(filePath, snapshotPath);
      this.syncMigrationDirectory(filePath, "持久化 legacy 聚合索引固定快照失败");
      return true;
    } catch (error) {
      if (existsSync(archivePath)) {
        this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引完成标记失败");
        return false;
      }
      if (getErrorCode(error) === "EEXIST" || existsSync(snapshotPath)) {
        this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引固定快照失败");
        return true;
      }
      if (getErrorCode(error) !== "ENOENT") {
        throw summaryMigrationError(filePath, "建立 legacy 聚合索引固定快照失败", error);
      }
    }

    if (existsSync(snapshotPath)) {
      this.syncMigrationDirectory(filePath, "确认并发 legacy 聚合索引固定快照失败");
      return true;
    }

    try {
      writeJsonAtomicIfAbsentSync(
        archivePath,
        {
          schemaVersion: 1,
          migration: "per-session-summary-v2",
          legacyAggregate: "absent",
        },
        this.temporaryFileSequence++,
      );
      this.syncMigrationDirectory(filePath, "持久化无 legacy 聚合索引完成标记失败");
      return false;
    } catch (error) {
      throw summaryMigrationError(filePath, "记录无 legacy 聚合索引的完成标记失败", error);
    }
  }

  private syncMigrationDirectory(filePath: string, operation: string): void {
    try {
      syncDirectory(dirname(filePath));
    } catch (error) {
      throw summaryMigrationError(filePath, operation, error);
    }
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

function parseLegacySummaryIndex(value: unknown): Record<string, StoredSessionSummary> {
  if (!isRecord(value) || !isRecord(value.summaries)) {
    throw new Error("legacy 会话摘要索引缺少 summaries 对象");
  }
  if (
    value.version !== LEGACY_SUMMARY_FILE_VERSION &&
    value.schemaVersion !== SUMMARY_FILE_VERSION
  ) {
    throw new Error("legacy 会话摘要索引版本不受支持");
  }
  const summaries: Record<string, StoredSessionSummary> = {};
  for (const [sessionId, candidate] of Object.entries(value.summaries)) {
    const summary = parseStoredSessionSummary(candidate);
    if (!summary || summary.sessionId !== sessionId) {
      throw new Error(`legacy 会话摘要条目无效: ${JSON.stringify(sessionId)}`);
    }
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

function withSummaryBasis(
  summary: StoredSessionSummary,
): StoredSessionSummary & { basis: SessionSummaryBasis } {
  return {
    ...summary,
    basis: summary.basis
      ? { ...summary.basis }
      : {
          throughEventId: null,
          messageCount: summary.messageCount,
          prefixDigest: null,
        },
  };
}

function summaryMigrationError(
  sourcePath: string,
  operation: string,
  cause: unknown,
): SummaryMigrationError {
  return new SummaryMigrationError(
    sourcePath,
    `legacy 会话摘要迁移失败（${operation}）: ${sourcePath}: ${errorMessage(cause)}`,
    cause,
  );
}

function writeJsonAtomicIfAbsentSync(path: string, value: unknown, sequence: number): boolean {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${sequence}.tmp`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    try {
      // hard link 只在目标不存在时原子发布，避免并发迁移覆盖 per-session 权威文件。
      linkSync(temporaryPath, path);
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") return false;
      throw error;
    }
    chmodSync(path, 0o600);
    syncDirectory(directory);
    return true;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        logger.warn({ error, temporaryPath }, "清理会话摘要迁移临时文件失败");
      }
    }
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
