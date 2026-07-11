import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "pathe";
import { logger } from "../observability/logger.js";
import type { SessionSummaryStore, StoredSessionSummary } from "./memory-store.js";

const SUMMARY_FILE_VERSION = 1;

interface SummaryFile {
  version: typeof SUMMARY_FILE_VERSION;
  summaries: Record<string, StoredSessionSummary>;
}

export interface SessionSummaryStoreOptions {
  persistent: boolean;
  filePath: string;
}

/** Process-local summary storage used when durable persistence is disabled. */
export class InMemorySessionSummaryStore implements SessionSummaryStore {
  protected readonly summaries = new Map<string, StoredSessionSummary>();

  get persistent(): boolean {
    return false;
  }

  save(sessionId: string, summary: string, messageCount: number): void {
    const now = new Date().toISOString();
    const existing = this.summaries.get(sessionId);
    this.summaries.set(sessionId, {
      sessionId,
      summary,
      messageCount,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  get(sessionId: string): StoredSessionSummary | null {
    const summary = this.summaries.get(sessionId);
    return summary ? { ...summary } : null;
  }
}

/**
 * Versioned JSON summary storage.
 *
 * Memory is updated before disk IO so persistence failures never block the
 * agent or discard the latest summary produced in the current process.
 */
export class FileSessionSummaryStore
  extends InMemorySessionSummaryStore
  implements SessionSummaryStore
{
  private persistenceAvailable = true;
  private temporaryFileSequence = 0;

  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  override get persistent(): boolean {
    return this.persistenceAvailable;
  }

  override save(sessionId: string, summary: string, messageCount: number): void {
    super.save(sessionId, summary, messageCount);
    this.persist();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      const file = parseSummaryFile(parsed);
      if (!file) {
        this.persistenceAvailable = false;
        logger.warn({ filePath: this.filePath }, "会话摘要文件格式无效，使用进程内存储");
        return;
      }

      for (const summary of Object.values(file.summaries)) {
        this.summaries.set(summary.sessionId, summary);
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return;

      this.persistenceAvailable = false;
      logger.warn({ error, filePath: this.filePath }, "读取会话摘要失败，使用进程内存储");
    }
  }

  private persist(): void {
    const directory = dirname(this.filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${this.temporaryFileSequence++}.tmp`,
    );
    const file: SummaryFile = {
      version: SUMMARY_FILE_VERSION,
      summaries: Object.fromEntries(this.summaries),
    };

    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
      this.persistenceAvailable = true;
    } catch (error) {
      this.persistenceAvailable = false;
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created; cleanup is best effort.
      }
      logger.warn({ error, filePath: this.filePath }, "持久化会话摘要失败，保留进程内最新摘要");
    }
  }
}

export function createSessionSummaryStore(
  options: SessionSummaryStoreOptions,
): SessionSummaryStore {
  return options.persistent
    ? new FileSessionSummaryStore(options.filePath)
    : new InMemorySessionSummaryStore();
}

function parseSummaryFile(value: unknown): SummaryFile | null {
  if (!isRecord(value) || value.version !== SUMMARY_FILE_VERSION) return null;
  if (!isRecord(value.summaries)) return null;

  const summaries: Record<string, StoredSessionSummary> = {};
  for (const [sessionId, candidate] of Object.entries(value.summaries)) {
    if (!isStoredSessionSummary(candidate) || candidate.sessionId !== sessionId) {
      return null;
    }
    summaries[sessionId] = candidate;
  }

  return { version: SUMMARY_FILE_VERSION, summaries };
}

function isStoredSessionSummary(value: unknown): value is StoredSessionSummary {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.summary === "string" &&
    typeof value.messageCount === "number" &&
    Number.isInteger(value.messageCount) &&
    value.messageCount >= 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
