import { randomUUID } from "node:crypto";
import { rememberResolvedCliSession } from "../input/session-settings.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { SqliteRuntimeEventStore, type SqliteSessionCatalogEntry } from "../storage/sqlite/sqlite-runtime-event-store.js";
import {
  isPublishedSession,
  type CliSessionSummary,
  type ForkTargetOperations,
  type SessionPublicationFlags,
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
 * 单会话点查:catalog 投影行单条 SQL;行缺失/损坏/水位失配由 store 内的
 * 全量重建阀门自愈(票 03)。发布判定的 journal 部分永远读时补查。
 * daemon 侧(requireSession)用 entry 形态拿归档/置顶;CLI 侧只要 summary。
 */
export async function findCliSessionCatalogEntry(
  workDir: string,
  sessionId: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<SqliteSessionCatalogEntry | undefined> {
  const store = createRuntimeEventStore(workDir, options.picoHome);
  const forkTargets = await indexForkTargetOperations(workDir, options.picoHome);
  try {
    const entry = await store.findSessionCatalogEntry(sessionId);
    if (!entry) return undefined;
    return isPublishedSession(sessionId, entry.fold, forkTargets) ? entry : undefined;
  } finally {
    store.close();
  }
}

export async function findCliSessionSummary(
  workDir: string,
  sessionId: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary | undefined> {
  return (await findCliSessionCatalogEntry(workDir, sessionId, options))?.summary;
}

/** 会话列表(catalog entry 形态,含归档/置顶):单条 keyset SQL + 发布过滤。 */
export async function listCliSessionCatalogEntries(
  workDir: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<readonly SqliteSessionCatalogEntry[]> {
  const store = createRuntimeEventStore(workDir, options.picoHome);
  const forkTargets = await indexForkTargetOperations(workDir, options.picoHome);
  try {
    const entries = await store.listSessionCatalogEntries();
    return entries.filter((entry) =>
      isPublishedSession(entry.summary.id, entry.fold, forkTargets),
    );
  } finally {
    store.close();
  }
}

/** 会话列表:catalog 单条 keyset SQL(activity_at DESC, session_id ASC)+ 发布过滤。 */
export async function listCliSessionSummaries(
  workDir: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary[]> {
  const entries = await listCliSessionCatalogEntries(workDir, options);
  return entries.map((entry) => entry.summary);
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
  let flags: SessionPublicationFlags | undefined;
  try {
    const manifest = await store.readSessionManifest(sessionId);
    if (!manifest) {
      throw new Error(`${prefix} session ${sessionId}: RuntimeEvent 日志中不存在`);
    }
    const entry = await store.findSessionCatalogEntry(sessionId);
    flags = entry?.fold;
  } finally {
    store.close();
  }
  const forkTargets = await indexForkTargetOperations(workDir, picoHome);
  if (flags && isPublishedSession(sessionId, flags, forkTargets)) return;
  throw new Error(`${prefix} session ${sessionId}: fork 尚未完成发布`);
}

async function indexForkTargetOperations(
  workDir: string,
  picoHome?: string,
): Promise<ReadonlyMap<string, ForkTargetOperations>> {
  // 票 08:全目录扫描变 storage_operations 单查询(kind='fork' AND state<>'aborted')。
  return new StorageOperationJournal({ workDir, picoHome }).listForkTargets();
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(
  workDir: string,
  sessionId: string,
  options: { readonly picoHome?: string } = {},
): Promise<void> {
  const store = createRuntimeEventStore(workDir, options.picoHome);
  try {
    await store.deleteSession(sessionId);
  } finally {
    store.close();
  }
}

function createRuntimeEventStore(
  workDir: string,
  picoHome?: string,
): SqliteRuntimeEventStore {
  return new SqliteRuntimeEventStore({
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
