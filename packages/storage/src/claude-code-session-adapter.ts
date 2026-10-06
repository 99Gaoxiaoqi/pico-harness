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

const SESSION_ID = /^[0-9a-f-]{36}$/iu;
const MAX_CANDIDATES = 10_000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const CATALOG_HEAD_BYTES = 128 * 1024;

export class ClaudeCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = "claude-code" as const;
  readonly name = "Claude Code";
  private readonly claudeHome: string;
  private readonly cachedSessions = createExternalSessionCatalogCache();

  constructor(claudeHome = join(homedir(), ".claude")) {
    this.claudeHome = resolve(claudeHome);
  }

  async detect(): Promise<boolean> {
    return isDirectory(join(this.claudeHome, "projects"));
  }

  async listSessions(text?: string): Promise<readonly ExternalSessionSummary[]> {
    const files = await transcriptFiles(join(this.claudeHome, "projects"), MAX_CANDIDATES);
    const summaries: ExternalSessionSummary[] = [];
    for (const file of files) {
      const id = basename(file.path, ".jsonl");
      if (!SESSION_ID.test(id)) continue;
      const info = await stat(file.path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const meta = await readMetadata(file.path, id);
      if (!meta || meta.sidechain) continue;
      const summary: ExternalSessionSummary = {
        id,
        title: meta.title,
        cwd: meta.cwd,
        updatedAt: info.mtimeMs,
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
    if (!SESSION_ID.test(sessionId)) throw new ExternalSessionNotFoundError();
    const files = await transcriptFiles(join(this.claudeHome, "projects"), MAX_CANDIDATES);
    const candidates = files.filter((file) => basename(file.path, ".jsonl") === sessionId);
    const candidate = (
      await Promise.all(
        candidates.map(async (file) => ({
          ...file,
          info: await stat(file.path).catch(() => undefined),
        })),
      )
    )
      .filter((file) => file.info?.isFile())
      .sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))[0];
    if (!candidate?.info) throw new ExternalSessionNotFoundError();
    if (candidate.info.size > MAX_TRANSCRIPT_BYTES)
      throw new ExternalSessionLimitError(MAX_TRANSCRIPT_BYTES);
    const content = await readFileBounded(candidate.path, MAX_TRANSCRIPT_BYTES);
    const after = await stat(candidate.path).catch(() => undefined);
    if (!after || candidate.info.size !== after.size || candidate.info.mtimeMs !== after.mtimeMs) {
      throw new ExternalSessionUnreadableError("Claude Code 会话导入期间发生变化，请稍后重试");
    }
    const records = parseTranscript(content);
    const meta = metadataFromRecords(records, sessionId);
    if (meta.sidechain) throw new ExternalSessionNotFoundError();
    const messages: Message[] = [];
    for (const record of records) {
      const message = convertClaudeMessage(record);
      if (!message) continue;
      messages.push(message);
      if (messages.length > 20_000) throw new ExternalSessionLimitError(20_000);
    }
    if (messages.length === 0)
      throw new ExternalSessionUnreadableError("Claude Code 会话中没有可导入的对话文本");
    return {
      summary: { id: sessionId, title: meta.title, cwd: meta.cwd, updatedAt: after.mtimeMs },
      messages,
    };
  }
}

async function transcriptFiles(root: string, maxCandidates: number): Promise<{ path: string }[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { path: string }[] = [];
  for (const project of entries) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
      files.push({ path: join(directory, child.name) });
      if (files.length > maxCandidates) throw new ExternalSessionLimitError(maxCandidates);
    }
  }
  return files;
}

async function readMetadata(path: string, id: string): Promise<ClaudeMetadata | undefined> {
  try {
    const records = parseTranscript(await readFileBounded(path, CATALOG_HEAD_BYTES, true), true);
    return metadataFromRecords(records, id);
  } catch {
    return undefined;
  }
}

interface ClaudeMetadata {
  readonly title: string;
  readonly cwd: string;
  readonly sidechain: boolean;
}

function metadataFromRecords(
  records: readonly Record<string, unknown>[],
  id: string,
): ClaudeMetadata {
  let cwd = "";
  let title: string | undefined;
  let sidechain = false;
  for (const record of records) {
    if (typeof record["cwd"] === "string") cwd = record["cwd"];
    if (record["isSidechain"] === true || record["is_sidechain"] === true) sidechain = true;
    const candidate =
      record["customTitle"] ?? record["aiTitle"] ?? record["summary"] ?? record["lastPrompt"];
    if (typeof candidate === "string" && candidate.trim()) title = titleText(candidate, id);
    if (!title && record["type"] === "user" && record["isMeta"] !== true) {
      title = titleText(contentText(record), id);
    }
  }
  return { title: title ?? id, cwd, sidechain };
}

function convertClaudeMessage(record: Record<string, unknown>): Message | undefined {
  if (
    record["isMeta"] === true ||
    record["isCompactSummary"] === true ||
    record["isSidechain"] === true
  )
    return undefined;
  const type = record["type"];
  if (type !== "user" && type !== "assistant") return undefined;
  const content = contentText(record);
  if (!content || isSyntheticContent(content)) return undefined;
  return { role: type, content };
}

function contentText(record: Record<string, unknown>): string {
  const message = isRecord(record["message"]) ? record["message"] : undefined;
  return textFromContent(message?.["content"] ?? record["content"]);
}

function isSyntheticContent(text: string): boolean {
  const value = text.trimStart();
  return (
    value.startsWith("[Request interrupted by user") ||
    /^<\/?(command-(name|message|args|contents)|local-command-(stdout|stderr)|bash-(input|stdout|stderr))[\s>]/u.test(
      value,
    )
  );
}

function parseTranscript(buffer: Buffer, allowPartialTail = false): Record<string, unknown>[] {
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch (cause) {
      const isPartialTail = index === lines.length - 1 && !text.endsWith("\n");
      if (allowPartialTail || isPartialTail) continue;
      throw new ExternalSessionUnreadableError(`Claude Code 会话第 ${index + 1} 行无法解析`, {
        cause,
      });
    }
  }
  return records;
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
