import { readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionStore } from "../engine/session-store.js";
import { replaySessionRecords } from "../engine/session-reducer.js";
import { reconcileUnfinishedSessionForks } from "../engine/session-fork-service.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import { rememberResolvedCliSession } from "../input/session-settings.js";
import type { SessionCatalog, SessionCatalogEntry } from "../storage/session-catalog.js";
import {
  getDefaultSessionCatalogProjector,
  SessionCatalogProjector,
} from "../storage/session-catalog-projection.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "../runtime/runtime-event-store.js";

export type CliSessionMode = "new" | "continue" | "resume" | "fork";
export type CliSessionHistorySource = "legacy" | "runtime-event-v1";

export interface CliSessionSelection {
  mode: CliSessionMode;
  sessionId: string;
  sourceSessionId?: string;
}

export interface CliSessionSummary {
  id: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  /** Canonical history source; legacy records remain listable but read-only. */
  historySource?: CliSessionHistorySource;
  /** Source session ID persisted with a forked conversation. */
  forkFrom?: string;
  /** Durable journal identity; sessionId remains the human-facing compatibility key. */
  logId?: string;
  parentLogId?: string;
  forkEventId?: string;
}

export interface ListCliSessionSummariesOptions {
  /** Integration/embedded override; production defaults to ~/.pico/session-catalog. */
  catalog?: SessionCatalog;
  projector?: SessionCatalogProjector;
}

export interface ResolveCliSessionOptions {
  workDir: string;
  session?: string;
  continueSession?: boolean;
  resumeSession?: string;
  forkSession?: string;
}

interface SessionFileInfo {
  path: string;
  sessionId: string;
  ctimeMs: number;
  birthtimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  await reconcileUnfinishedSessionForks(options.workDir);
  assertSingleSessionMode(options);

  if (options.resumeSession) {
    const sessionId = options.resumeSession;
    await assertSessionIsWritable(options.workDir, sessionId, "--resume", true);
    return rememberSelection({ mode: "resume", sessionId }, options.workDir);
  }

  if (options.session) {
    await assertSessionIsWritable(options.workDir, options.session, "--session", false);
    return rememberSelection({ mode: "resume", sessionId: options.session }, options.workDir);
  }

  if (options.forkSession) {
    await assertSessionIsWritable(options.workDir, options.forkSession, "--fork", true);
    return rememberSelection(
      {
        mode: "fork",
        sessionId: createCliSessionId(),
        sourceSessionId: options.forkSession,
      },
      options.workDir,
    );
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir);
    if (latest) {
      return rememberSelection({ mode: "continue", sessionId: latest }, options.workDir);
    }
  }

  return rememberSelection({ mode: "new", sessionId: createCliSessionId() }, options.workDir);
}

export function createCliSessionId(): string {
  return `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function listCliSessionSummaries(
  workDir: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary[]> {
  await reconcileUnfinishedSessionForks(workDir);
  const projector =
    options.projector ??
    (options.catalog
      ? new SessionCatalogProjector(options.catalog)
      : process.env.PICO_SESSION_CATALOG === "0"
        ? undefined
        : getDefaultSessionCatalogProjector());
  const catalogEntries = projector ? (await projector.syncWorkspace(workDir)).entries : [];
  const catalogBySession = new Map(catalogEntries.map((entry) => [entry.sessionId, entry]));
  const runtimeEventStore = new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
  });
  const files = await listSessionFiles(workDir);
  const summaries: CliSessionSummary[] = [];
  for (const file of files) {
    const historySource = await getSessionHistorySource(runtimeEventStore, file.sessionId);
    const catalog = catalogBySession.get(file.sessionId);
    if (catalog && catalogMatchesSessionFile(catalog, file)) {
      summaries.push({ ...summaryFromCatalog(workDir, file, catalog), historySource });
      continue;
    }
    const records = await new SessionStore(file.path).load();
    const replay = replaySessionRecords(records);
    const messages = replay.history;
    const metadata = recoverSessionMetadata(replay.runtime.settings);
    const visibleUserMessages = messages.filter(
      (message) =>
        message.role === "user" &&
        message.toolCallId === undefined &&
        !isMessageHiddenFromTranscript(message) &&
        message.content.trim().length > 0,
    );
    const firstMessage = compactSessionText(visibleUserMessages[0]?.content);
    const lastMessage = compactSessionText(visibleUserMessages.at(-1)?.content);
    summaries.push({
      id: file.sessionId,
      cwd: workDir,
      createdAt: new Date(file.birthtimeMs > 0 ? file.birthtimeMs : file.ctimeMs),
      updatedAt: new Date(file.mtimeMs),
      messageCount: messages.length,
      ...(metadata.title !== undefined
        ? { title: metadata.title }
        : firstMessage
          ? { title: firstMessage }
          : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...((metadata.forkFrom ?? catalog?.lineage.parentSessionId)
        ? { forkFrom: metadata.forkFrom ?? catalog?.lineage.parentSessionId }
        : {}),
      ...(catalog ? { logId: catalog.logId } : {}),
      ...(catalog?.lineage.parentLogId ? { parentLogId: catalog.lineage.parentLogId } : {}),
      ...(catalog?.lineage.forkEventId ? { forkEventId: catalog.lineage.forkEventId } : {}),
      historySource,
    });
  }

  summaries.sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id),
  );
  return summaries;
}

/** 最近一次完整 settings 快照中的用户可识别元数据。 */
function recoverSessionMetadata(
  settings: ReturnType<typeof replaySessionRecords>["runtime"]["settings"],
): Pick<CliSessionSummary, "title" | "forkFrom"> {
  return {
    ...(settings?.title !== undefined ? { title: settings.title } : {}),
    ...(settings?.forkFrom !== undefined ? { forkFrom: settings.forkFrom } : {}),
  };
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

async function findLatestSessionId(workDir: string): Promise<string | undefined> {
  return (await listCliSessionSummaries(workDir)).find(
    (session) => session.historySource === "runtime-event-v1",
  )?.id;
}

async function listSessionFiles(workDir: string): Promise<SessionFileInfo[]> {
  const sessionsDir = sessionsDirectory(workDir);
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const candidates: SessionFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(sessionsDir, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    candidates.push({
      path,
      sessionId: entry.slice(0, -".jsonl".length),
      ctimeMs: info.ctimeMs,
      birthtimeMs: info.birthtimeMs,
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.sessionId.localeCompare(a.sessionId));
  return candidates;
}

function catalogMatchesSessionFile(entry: SessionCatalogEntry, file: SessionFileInfo): boolean {
  return (
    entry.health === "healthy" &&
    entry.sessionId === file.sessionId &&
    entry.logPath === file.path &&
    entry.sourceMtimeMs === file.mtimeMs &&
    entry.sourceSizeBytes === file.sizeBytes &&
    (entry.head ? entry.head.logId === entry.logId : entry.messageCount === 0)
  );
}

function summaryFromCatalog(
  workDir: string,
  file: SessionFileInfo,
  entry: SessionCatalogEntry,
): CliSessionSummary {
  return {
    id: file.sessionId,
    cwd: workDir,
    createdAt: new Date(file.birthtimeMs > 0 ? file.birthtimeMs : file.ctimeMs),
    updatedAt: new Date(file.mtimeMs),
    messageCount: entry.messageCount,
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.firstUserMessage ? { firstMessage: entry.firstUserMessage } : {}),
    ...(entry.lastUserMessage ? { lastMessage: entry.lastUserMessage } : {}),
    ...(entry.lineage.parentSessionId ? { forkFrom: entry.lineage.parentSessionId } : {}),
    logId: entry.logId,
    ...(entry.lineage.parentLogId ? { parentLogId: entry.lineage.parentLogId } : {}),
    ...(entry.lineage.forkEventId ? { forkEventId: entry.lineage.forkEventId } : {}),
  };
}

function compactSessionText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

type ExplicitSessionOption = "--resume" | "--session" | "--fork";

async function assertSessionIsWritable(
  workDir: string,
  sessionId: string,
  option: ExplicitSessionOption,
  required: boolean,
): Promise<void> {
  const path = sessionFilePath(workDir, sessionId);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    if (!required) return;

    const prefix = option === "--fork" ? "无法 fork" : "无法恢复";
    throw new Error(`${prefix} session ${sessionId}: 找不到 ${path}`);
  }

  const runtimeEventStore = new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
  });
  if ((await getSessionHistorySource(runtimeEventStore, sessionId)) === "runtime-event-v1") return;
  if (await isEmptySessionProjection(path, sessionId)) return;
  if (await isPendingRuntimeForkProjection(path, sessionId)) return;

  throw new Error(`${option} 不能使用 session ${sessionId}: legacy 历史为只读`);
}

/** A brand-new Session JSONL may exist before RuntimeEvent initializes its manifest. */
async function isEmptySessionProjection(path: string, sessionId: string): Promise<boolean> {
  const snapshot = await new SessionStore(path).inspectJournal();
  const metadata = snapshot.metadata;
  return (
    replaySessionRecords(snapshot.records).history.length === 0 &&
    metadata?.schemaVersion === 3 &&
    "logId" in metadata &&
    metadata.sessionId === sessionId
  );
}

/** A published fork seed is a recoverable Runtime bootstrap, not legacy history. */
async function isPendingRuntimeForkProjection(path: string, sessionId: string): Promise<boolean> {
  const snapshot = await new SessionStore(path).inspectJournal();
  const metadata = snapshot.metadata;
  if (metadata?.schemaVersion !== 3 || !("logId" in metadata) || metadata.sessionId !== sessionId) {
    return false;
  }
  const seed = snapshot.records.find(
    (record) => record.type === "event" && record.kind === "session.seeded",
  );
  return (
    seed?.data.lineage?.relation === "fork" &&
    typeof seed.data.lineage.parentSessionId === "string" &&
    seed.data.lineage.parentSessionId.length > 0
  );
}

async function getSessionHistorySource(
  runtimeEventStore: RuntimeEventStore,
  sessionId: string,
): Promise<CliSessionHistorySource> {
  const manifest = await runtimeEventStore.readSessionManifest(sessionId).catch(() => undefined);
  return manifest?.sessionId === sessionId && manifest.historySource === "runtime-event-v1"
    ? "runtime-event-v1"
    : "legacy";
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(workDir: string, sessionId: string): Promise<void> {
  await rm(sessionFilePath(workDir, sessionId), { force: true });
}

function rememberSelection(selection: CliSessionSelection, workDir: string): CliSessionSelection {
  rememberResolvedCliSession(selection, workDir);
  return selection;
}

function sessionsDirectory(workDir: string): string {
  return resolvePicoPaths(workDir).workspace.sessions;
}

function sessionFilePath(workDir: string, sessionId: string): string {
  return join(sessionsDirectory(workDir), `${sessionId}.jsonl`);
}
