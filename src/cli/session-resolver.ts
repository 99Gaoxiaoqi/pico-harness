import { readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rememberResolvedCliSession } from "../input/session-settings.js";

export type CliSessionMode = "new" | "continue" | "resume" | "fork";

export interface CliSessionSelection {
  mode: CliSessionMode;
  sessionId: string;
  sourceSessionId?: string;
}

export interface ResolveCliSessionOptions {
  workDir: string;
  session?: string;
  continueSession?: boolean;
  resumeSession?: string;
  forkSession?: string;
}

interface SessionFileCandidate {
  sessionId: string;
  mtimeMs: number;
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  assertSingleSessionMode(options);

  if (options.resumeSession || options.session) {
    const sessionId = options.resumeSession ?? options.session!;
    await assertSessionFileExists(options.workDir, sessionId, "resume");
    return rememberSelection({
      mode: "resume",
      sessionId,
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
  const sessionsDir = sessionsDirectory(workDir);
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return undefined;
  }

  const candidates: SessionFileCandidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(sessionsDir, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    candidates.push({
      sessionId: entry.slice(0, -".jsonl".length),
      mtimeMs: info.mtimeMs,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.sessionId.localeCompare(a.sessionId));
  return candidates[0]?.sessionId;
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
