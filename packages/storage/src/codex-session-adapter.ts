import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Message } from "@pico/core";
import {
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
  ExternalSessionUnreadableError,
  createExternalSessionCatalogCache,
  isRecord,
  paginateExternalSessions,
  textFromContent,
  titleText,
  type ExternalSessionAdapter,
  type ExternalSessionPage,
  type ExternalSessionPageQuery,
  type ExternalSessionSnapshot,
  type ExternalSessionSummary,
} from "./external-sessions.js";

const SESSION_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;
const MAX_CANDIDATES = 10_000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const CATALOG_HEAD_BYTES = 128 * 1024;

export class CodexSessionAdapter implements ExternalSessionAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";
  private readonly codexHome: string;
  private readonly cachedSessions = createExternalSessionCatalogCache();

  constructor(codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex")) {
    this.codexHome = resolve(codexHome);
  }

  async detect(): Promise<boolean> {
    return (
      (await isDirectory(join(this.codexHome, "sessions"))) ||
      (await isDirectory(join(this.codexHome, "archived_sessions")))
    );
  }

  async listSessions(text?: string): Promise<readonly ExternalSessionSummary[]> {
    const files = await transcriptFiles(
      [join(this.codexHome, "sessions"), join(this.codexHome, "archived_sessions")],
      MAX_CANDIDATES,
    );
    const summaries: ExternalSessionSummary[] = [];
    for (const file of files) {
      const id = sessionIdFromPath(file.path);
      if (!id) continue;
      const metadata = await readCodexMetadata(file.path, id);
      if (!metadata) continue;
      const info = await stat(file.path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const summary: ExternalSessionSummary = {
        id,
        title: metadata.title,
        cwd: metadata.cwd,
        updatedAt: info.mtimeMs,
        ...(file.archived ? { archived: true } : {}),
      };
      if (
        !text ||
        `${summary.title} ${summary.cwd} ${summary.id}`
          .toLocaleLowerCase()
          .includes(text.trim().toLocaleLowerCase())
      ) {
        summaries.push(summary);
      }
    }
    return summaries.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  }

  async listPage(query: ExternalSessionPageQuery): Promise<ExternalSessionPage> {
    return paginateExternalSessions(this.id, query, () =>
      this.cachedSessions(() => this.listSessions()),
    );
  }

  async readSession(sessionId: string): Promise<ExternalSessionSnapshot> {
    if (!isSafeId(sessionId)) throw new ExternalSessionNotFoundError();
    const files = await transcriptFiles(
      [join(this.codexHome, "sessions"), join(this.codexHome, "archived_sessions")],
      MAX_CANDIDATES,
    );
    const candidate = files.find((file) => sessionIdFromPath(file.path) === sessionId);
    if (!candidate) throw new ExternalSessionNotFoundError();
    const before = await stat(candidate.path).catch(() => undefined);
    if (!before?.isFile()) throw new ExternalSessionNotFoundError();
    if (before.size > MAX_TRANSCRIPT_BYTES)
      throw new ExternalSessionLimitError(MAX_TRANSCRIPT_BYTES);
    const contents = await readFileBounded(candidate.path, MAX_TRANSCRIPT_BYTES);
    const after = await stat(candidate.path).catch(() => undefined);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ExternalSessionUnreadableError("Codex 会话导入期间发生变化，请稍后重试");
    }
    const messages = parseCodexTranscript(contents, sessionId);
    const metadata = parseCodexMetadata(contents.subarray(0, CATALOG_HEAD_BYTES), sessionId);
    if (messages.length === 0)
      throw new ExternalSessionUnreadableError("Codex 会话中没有可导入的对话文本");
    return {
      summary: {
        id: sessionId,
        title: metadata.title,
        cwd: metadata.cwd,
        updatedAt: after.mtimeMs,
        ...(candidate.archived ? { archived: true } : {}),
      },
      messages,
    };
  }
}

async function transcriptFiles(
  roots: readonly string[],
  maxCandidates: number,
): Promise<{ path: string; archived: boolean }[]> {
  const output: { path: string; archived: boolean }[] = [];
  for (const root of roots) {
    const archived = basename(root) === "archived_sessions";
    const rootReal = await realPathDirectory(root);
    if (!rootReal) continue;
    const pending = [rootReal];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && SESSION_ID.test(entry.name)) {
          output.push({ path, archived });
          if (output.length > maxCandidates) throw new ExternalSessionLimitError(maxCandidates);
        }
      }
    }
  }
  return output;
}

function sessionIdFromPath(path: string): string | undefined {
  const match = basename(path).match(SESSION_ID);
  return match?.[1]?.toLowerCase();
}

async function readCodexMetadata(
  path: string,
  id: string,
): Promise<{ title: string; cwd: string } | undefined> {
  try {
    return parseCodexMetadata(await readFileBounded(path, CATALOG_HEAD_BYTES, true), id);
  } catch {
    return undefined;
  }
}

function parseCodexMetadata(buffer: Buffer, id: string): { title: string; cwd: string } {
  let cwd = "";
  let title = id;
  for (const raw of buffer.toString("utf8").split("\n")) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    const payload = isRecord(record["payload"]) ? record["payload"] : undefined;
    if (record["type"] === "session_meta" && payload) {
      if (typeof payload["cwd"] === "string") cwd = payload["cwd"];
    }
    const message = codexMessage(record);
    if (message?.role === "user" && title === id) title = titleText(message.content, id);
  }
  return { title, cwd };
}

function parseCodexTranscript(buffer: Buffer, sessionId: string): Message[] {
  const messages: Message[] = [];
  const lines = buffer.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw) as unknown;
    } catch (cause) {
      if (index === lines.length - 1 && !buffer.toString("utf8").endsWith("\n")) continue;
      throw new ExternalSessionUnreadableError(`Codex 会话第 ${index + 1} 行无法解析`, { cause });
    }
    if (!isRecord(record)) continue;
    if (record["type"] === "session_meta") {
      const payload = isRecord(record["payload"]) ? record["payload"] : undefined;
      const sourceId = payload?.["session_id"] ?? payload?.["id"];
      if (sourceId !== undefined && sourceId !== sessionId)
        throw new ExternalSessionUnreadableError("Codex 会话 ID 与文件名不匹配");
    }
    const message = codexMessage(record);
    if (!message?.content.trim()) continue;
    messages.push(message);
    if (messages.length > 20_000) throw new ExternalSessionLimitError(20_000);
  }
  return messages;
}

function codexMessage(record: Record<string, unknown>): Message | undefined {
  const payload = isRecord(record["payload"]) ? record["payload"] : undefined;
  if (!payload) return undefined;
  if (record["type"] !== "event_msg") return undefined;
  const eventType = payload["type"];
  if (eventType === "user_message" || eventType === "agent_message") {
    const text = typeof payload["message"] === "string" ? payload["message"].trim() : "";
    return text
      ? { role: eventType === "user_message" ? "user" : "assistant", content: text }
      : undefined;
  }
  if (eventType !== "item_completed" || !isRecord(payload["item"])) return undefined;
  const item = payload["item"];
  const type = typeof item["type"] === "string" ? item["type"].toLowerCase() : "";
  const role = type === "usermessage" ? "user" : type === "agentmessage" ? "assistant" : undefined;
  if (!role) return undefined;
  const text = textFromContent(item["content"]) || textFromContent(item["text"]);
  return text ? { role, content: text } : undefined;
}

async function readFileBounded(path: string, maxBytes: number, truncate = false): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size > maxBytes && !truncate) throw new ExternalSessionLimitError(maxBytes);
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function realPathDirectory(path: string): Promise<string | undefined> {
  try {
    const resolved = resolve(path);
    if (!(await stat(resolved)).isDirectory()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function isSafeId(value: string): boolean {
  return /^[0-9a-f-]{36}$/iu.test(value);
}
