import { readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionStore } from "../engine/session-store.js";
import { replaySessionRecords } from "../engine/session-reducer.js";
import { reconcileUnfinishedSessionForks } from "../engine/session-fork-service.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import { rememberResolvedCliSession } from "../input/session-settings.js";
import type { SessionCatalog } from "../storage/session-catalog.js";
import {
  getDefaultSessionCatalogProjector,
  SessionCatalogProjector,
} from "../storage/session-catalog-projection.js";

export type CliSessionMode = "new" | "continue" | "resume" | "fork";

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
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  await reconcileUnfinishedSessionForks(options.workDir);
  assertSingleSessionMode(options);

  if (options.resumeSession) {
    const sessionId = options.resumeSession;
    await assertSessionFileExists(options.workDir, sessionId, "resume");
    return rememberSelection({
      mode: "resume",
      sessionId,
    });
  }

  if (options.session) {
    return rememberSelection({
      mode: "resume",
      sessionId: options.session,
    });
  }

  if (options.forkSession) {
    await assertSessionFileExists(options.workDir, options.forkSession, "fork");
    return rememberSelection({
      mode: "fork",
      sessionId: createCliSessionId(),
      sourceSessionId: options.forkSession,
    });
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir);
    if (latest) {
      return rememberSelection({
        mode: "continue",
        sessionId: latest,
      });
    }
  }

  return rememberSelection({
    mode: "new",
    sessionId: createCliSessionId(),
  });
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
  const files = await listSessionFiles(workDir);
  const summaries: CliSessionSummary[] = [];
  for (const file of files) {
    const records = await new SessionStore(file.path).load();
    const replay = replaySessionRecords(records);
    const messages = replay.history;
    const metadata = recoverSessionMetadata(replay.runtime.settings);
    const catalog = catalogBySession.get(file.sessionId);
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
  return (await listCliSessionSummaries(workDir))[0]?.id;
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
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.sessionId.localeCompare(a.sessionId));
  return candidates;
}

function compactSessionText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

async function assertSessionFileExists(
  workDir: string,
  sessionId: string,
  action: "resume" | "fork",
): Promise<void> {
  const path = sessionFilePath(workDir, sessionId);
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile()) return;

  const prefix = action === "resume" ? "无法恢复" : "无法 fork";
  throw new Error(`${prefix} session ${sessionId}: 找不到 ${path}`);
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(workDir: string, sessionId: string): Promise<void> {
  await rm(sessionFilePath(workDir, sessionId), { force: true });
}

function rememberSelection(selection: CliSessionSelection): CliSessionSelection {
  rememberResolvedCliSession(selection);
  return selection;
}

function sessionsDirectory(workDir: string): string {
  return join(workDir, ".claw", "sessions");
}

function sessionFilePath(workDir: string, sessionId: string): string {
  return join(sessionsDirectory(workDir), `${sessionId}.jsonl`);
}
