import { randomUUID } from "node:crypto";
import { rememberResolvedCliSession } from "../input/session-settings.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  RuntimeEventStore,
  type RuntimeEventStoreEntry,
} from "../storage/runtime-event-store.js";
import {
  SessionCatalogIntegrityError,
  type SessionCatalogRow,
} from "../storage/session-catalog.js";
import {
  computeSessionPublicationFlags,
  isPublishedSession,
  summaryFromRuntimeSession,
  type CliSessionSummary,
  type ForkTargetOperations,
  type SequencedCliSessionSummary,
} from "../engine/session-summary.js";
import { StorageOperationJournal } from "../storage/operation-journal.js";

export type CliSessionMode = "new" | "continue" | "resume" | "fork";
export type { CliSessionSummary, CliSessionHistorySource } from "../engine/session-summary.js";

export interface CliSessionSelection {
  mode: CliSessionMode;
  sessionId: string;
  sourceSessionId?: string;
}

export interface ListCliSessionSummariesOptions {
  picoHome?: string;
}

export interface ResolveCliSessionOptions {
  workDir: string;
  picoHome?: string;
  session?: string;
  continueSession?: boolean;
  resumeSession?: string;
  forkSession?: string;
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  assertSingleSessionMode(options);

  if (options.resumeSession) {
    const sessionId = options.resumeSession;
    await assertRuntimeSessionExists(options.workDir, sessionId, "resume", options.picoHome);
    return rememberSelection({ mode: "resume", sessionId }, options.workDir, options.picoHome);
  }

  if (options.session) {
    await assertRuntimeSessionExists(options.workDir, options.session, "resume", options.picoHome);
    return rememberSelection(
      { mode: "resume", sessionId: options.session },
      options.workDir,
      options.picoHome,
    );
  }

  if (options.forkSession) {
    await assertRuntimeSessionExists(
      options.workDir,
      options.forkSession,
      "fork",
      options.picoHome,
    );
    return rememberSelection(
      {
        mode: "fork",
        sessionId: createCliSessionId(),
        sourceSessionId: options.forkSession,
      },
      options.workDir,
      options.picoHome,
    );
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir, options.picoHome);
    if (latest) {
      return rememberSelection(
        { mode: "continue", sessionId: latest },
        options.workDir,
        options.picoHome,
      );
    }
  }

  return rememberSelection(
    { mode: "new", sessionId: createCliSessionId() },
    options.workDir,
    options.picoHome,
  );
}

export function createCliSessionId(): string {
  return `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * 单会话点查：优先读会话目录（catalog）行并做 statSync 水位校验；
 * catalog 缺行、损坏或水位不符（deleteSession 崩溃窗口、手工篡改）时
 * 回落单会话 ledger 直读——该回落也是水位漂移的自愈路径。
 */
export async function findCliSessionSummary(
  workDir: string,
  sessionId: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary | undefined> {
  const runtimeEventStore = createRuntimeEventStore(workDir, options.picoHome);
  const forkTargets = await indexForkTargetOperations(workDir, options.picoHome);
  try {
    const row = runtimeEventStore.readSessionCatalog()?.rows.get(sessionId);
    if (row && runtimeEventStore.sessionLedgerSizeMatches(sessionId, row.ledgerByteLength)) {
      return isPublishedSession(sessionId, row, forkTargets) ? row.summary : undefined;
    }
  } catch (error) {
    if (!(error instanceof SessionCatalogIntegrityError)) throw error;
  }
  const manifest = await runtimeEventStore.readSessionManifest(sessionId);
  if (!manifest) return undefined;
  const entries = await runtimeEventStore.readSessionEntries(sessionId);
  if (!isPublishedRuntimeSession(sessionId, entries, forkTargets)) return undefined;
  return summaryFromRuntimeSession(manifest, entries).summary;
}

/**
 * 会话列表：读会话目录（catalog）单文件 + fork journal 发布过滤。
 * catalog 缺失/损坏/版本不符时锁内从 ledger 全量重建（可写 store 顺手落盘，
 * readOnly 只重建内存态）。发布判定的 journal 部分永远读时补查。
 */
export async function listCliSessionSummaries(
  workDir: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary[]> {
  const runtimeEventStore = createRuntimeEventStore(workDir, options.picoHome);
  const forkTargets = await indexForkTargetOperations(workDir, options.picoHome);
  let rows: readonly SessionCatalogRow[] | undefined;
  try {
    const catalog = runtimeEventStore.readSessionCatalogForListing();
    rows = catalog ? [...catalog.rows.values()] : undefined;
  } catch (error) {
    if (!(error instanceof SessionCatalogIntegrityError)) throw error;
  }
  if (!rows) {
    rows = [...(await runtimeEventStore.rebuildSessionCatalog()).rows.values()];
  }

  const published = rows
    .filter((row) => isPublishedSession(row.summary.id, row, forkTargets))
    .map((row): SequencedCliSessionSummary => ({
      summary: row.summary,
      headSequence: row.headSequence,
    }));

  published.sort(
    (a, b) =>
      b.summary.updatedAt.getTime() - a.summary.updatedAt.getTime() ||
      b.headSequence - a.headSequence ||
      b.summary.createdAt.getTime() - a.summary.createdAt.getTime() ||
      b.summary.id.localeCompare(a.summary.id),
  );
  return published.map(({ summary }) => summary);
}

function assertSingleSessionMode(options: ResolveCliSessionOptions): void {
  const modes = [
    options.session !== undefined,
    options.continueSession === true,
    options.resumeSession !== undefined,
    options.forkSession !== undefined,
  ].filter(Boolean);

  if (modes.length > 1) {
    throw new Error("session 启动参数只能选择一种");
  }
}

async function findLatestSessionId(
  workDir: string,
  picoHome?: string,
): Promise<string | undefined> {
  return (await listCliSessionSummaries(workDir, { picoHome }))[0]?.id;
}

async function assertRuntimeSessionExists(
  workDir: string,
  sessionId: string,
  action: "resume" | "fork",
  picoHome?: string,
): Promise<void> {
  const prefix = action === "fork" ? "无法 fork" : "无法恢复";
  const store = createRuntimeEventStore(workDir, picoHome);
  const manifest = await store.readSessionManifest(sessionId);
  if (!manifest) {
    throw new Error(`${prefix} session ${sessionId}: RuntimeEvent 日志中不存在`);
  }
  const entries = await store.readSessionEntries(sessionId);
  const forkTargets = await indexForkTargetOperations(workDir, picoHome);
  if (isPublishedRuntimeSession(sessionId, entries, forkTargets)) return;
  throw new Error(`${prefix} session ${sessionId}: fork 尚未完成发布`);
}

async function indexForkTargetOperations(
  workDir: string,
  picoHome?: string,
): Promise<ReadonlyMap<string, ForkTargetOperations>> {
  const operations = await new StorageOperationJournal({ workDir, picoHome }).list();
  const targets = new Map<string, ForkTargetOperations>();
  for (const operation of operations) {
    if (operation.kind !== "fork" || operation.state === "aborted") continue;
    const existing = targets.get(operation.targetSessionId);
    targets.set(operation.targetSessionId, {
      hasCompleted: existing?.hasCompleted === true || operation.state === "completed",
    });
  }
  return targets;
}

function isPublishedRuntimeSession(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  forkTargets: ReadonlyMap<string, ForkTargetOperations>,
): boolean {
  return isPublishedSession(sessionId, computeSessionPublicationFlags(entries), forkTargets);
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(
  workDir: string,
  sessionId: string,
  options: { readonly picoHome?: string } = {},
): Promise<void> {
  await createRuntimeEventStore(workDir, options.picoHome).deleteSession(sessionId);
}

function createRuntimeEventStore(workDir: string, picoHome?: string): RuntimeEventStore {
  return new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
}

function rememberSelection(
  selection: CliSessionSelection,
  workDir: string,
  picoHome?: string,
): CliSessionSelection {
  rememberResolvedCliSession(selection, workDir, picoHome);
  return selection;
}
