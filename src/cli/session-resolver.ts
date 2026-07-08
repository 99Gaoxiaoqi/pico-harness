import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../engine/session-store.js";
import type { Message } from "../schema/message.js";

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
  assertSingleSessionMode(options);

  if (options.resumeSession || options.session) {
    return {
      mode: "resume",
      sessionId: options.resumeSession ?? options.session!,
    };
  }

  if (options.forkSession) {
    return {
      mode: "fork",
      sessionId: createCliSessionId(),
      sourceSessionId: options.forkSession,
    };
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir);
    if (latest) {
      return {
        mode: "continue",
        sessionId: latest,
      };
    }
  }

  return {
    mode: "new",
    sessionId: createCliSessionId(),
  };
}

export function createCliSessionId(): string {
  return `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function listCliSessionSummaries(
  workDir: string,
): Promise<CliSessionSummary[]> {
  const files = await listSessionFiles(workDir);
  const summaries: CliSessionSummary[] = [];
  for (const file of files) {
    const records = await new SessionStore(file.path).load();
    summaries.push({
      id: file.sessionId,
      cwd: workDir,
      createdAt: new Date(file.birthtimeMs > 0 ? file.birthtimeMs : file.ctimeMs),
      updatedAt: new Date(file.mtimeMs),
      messageCount: countRecoveredMessages(records),
    });
  }

  summaries.sort(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      b.id.localeCompare(a.id),
  );
  return summaries;
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
  const sessionsDir = join(workDir, ".claw", "sessions");
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

function countRecoveredMessages(records: readonly SessionRecord[]): number {
  let history: Message[] = [];
  for (const record of records) {
    if (record.type === "message") {
      if (record.volatile === true) continue;
      history.push(record.message);
    } else if (record.type === "truncate") {
      history = history.slice(record.fromIndex);
    } else if (record.type === "undo") {
      history = applyUndoToHistory(history, record.count);
    } else if (record.type === "rewind_to") {
      history = history.slice(0, record.messageIndex);
    }
  }
  return history.length;
}

function applyUndoToHistory(history: readonly Message[], count: number): Message[] {
  if (count <= 0) return [...history];
  let removedCount = 0;
  let cutIndex = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role === "system") continue;
    if (message.role === "user") {
      removedCount++;
      if (removedCount === count) {
        cutIndex = index;
        break;
      }
    }
  }
  return removedCount === 0 ? [...history] : history.slice(0, cutIndex);
}
