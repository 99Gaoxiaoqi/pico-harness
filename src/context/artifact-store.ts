import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
// 用 pathe 替代 node:path:artifact 的 meta.path 会被持久化并跨平台对比,
// 统一正斜杠后断言 .claw/artifacts/sessions/ / tool-results/ 才能稳定成立。
import { join, resolve } from "pathe";
import { writeJsonAtomic } from "../storage/atomic-json.js";

const DEFAULT_TTL_HOURS = 168;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_SESSION_ID = "default";
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const UNSAFE_SESSION_CHAR_RE = /[^A-Za-z0-9._-]/g;

let generatedIdCounter = 0;

export interface ToolResultArtifactMeta {
  schemaVersion: 2;
  id: string;
  sessionId: string;
  safeSessionId: string;
  toolName: string;
  argsHash?: string;
  createdAt: string;
  sizeBytes: number;
  ttlHours: number;
  pinned: boolean;
  summary?: string;
  path: string;
  contentHash?: string;
  availability: "available" | "evicted";
}

export class ArtifactIntegrityError extends Error {
  constructor(
    readonly artifactId: string,
    message: string,
  ) {
    super(`Artifact ${artifactId} failed integrity validation: ${message}`);
    this.name = "ArtifactIntegrityError";
  }
}

export interface ToolResultArtifactStoreOptions {
  baseDir: string;
  ttlHours?: number;
  maxTotalBytes?: number;
}

export interface WriteToolResultArtifactInput {
  id?: string;
  sessionId?: string;
  toolName: string;
  args: unknown;
  output: string;
  summary?: string;
  ttlHours?: number;
  pinned?: boolean;
}

export interface CleanupResult {
  deleted: string[];
  retained: string[];
}

interface StoredArtifact {
  key: string;
  meta: ToolResultArtifactMeta;
  createdAtMs: number;
}

export class ToolResultArtifactStore {
  private readonly sessionsDir: string;
  private readonly ttlHours: number;
  private readonly maxTotalBytes: number;

  constructor(opts: ToolResultArtifactStoreOptions) {
    this.sessionsDir = join(resolve(opts.baseDir), "sessions");
    this.ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  async write(input: WriteToolResultArtifactInput): Promise<ToolResultArtifactMeta> {
    const id = input.id ? assertSafeId(input.id) : generateId();
    const sessionId = input.sessionId ?? DEFAULT_SESSION_ID;
    const safeSessionId = toSafeSessionId(sessionId);
    const artifactDir = this.sessionArtifactDir(safeSessionId);
    const path = this.contentPath(id, safeSessionId);
    const createdAt = new Date().toISOString();
    const ttlHours = input.ttlHours ?? this.ttlHours;
    const meta: ToolResultArtifactMeta = {
      schemaVersion: 2,
      id,
      sessionId,
      safeSessionId,
      toolName: input.toolName,
      argsHash: hashToolResultArtifactArgs(input.args),
      createdAt,
      sizeBytes: Buffer.byteLength(input.output, "utf8"),
      ttlHours,
      pinned: input.pinned ?? false,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      path,
      contentHash: hashText(input.output),
      availability: "available",
    };

    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    // mkdir 不会收紧已存在目录的权限；显式 chmod 避免旧目录继续受宽松 umask 影响。
    await chmod(artifactDir, 0o700);
    const metaPath = this.metaPath(id, safeSessionId);
    // metadata 是 commit marker：先移除旧 marker，再发布并 fsync 正文，最后原子发布 meta。
    await unlinkCommitMarker(metaPath);
    await writeArtifactContentAtomic(path, input.output);
    await writeJsonAtomic(metaPath, meta);

    return meta;
  }

  async read(metaOrId: ToolResultArtifactMeta | string): Promise<string | undefined> {
    const meta =
      typeof metaOrId === "string" ? await this.readMeta(metaOrId) : normalizeMeta(metaOrId);
    if (!meta || meta.availability === "evicted") return undefined;
    const id = meta.id;
    const sessionId = meta.safeSessionId;

    try {
      const contents = await readFile(this.contentPath(assertSafeId(id), sessionId));
      if (contents.byteLength !== meta.sizeBytes) {
        throw new ArtifactIntegrityError(
          id,
          `expected ${meta.sizeBytes} bytes, found ${contents.byteLength}`,
        );
      }
      if (meta.contentHash) {
        const actual = createHash("sha256").update(contents).digest("hex");
        if (actual !== meta.contentHash) {
          throw new ArtifactIntegrityError(id, `expected ${meta.contentHash}, found ${actual}`);
        }
      }
      return contents.toString("utf8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async readMeta(id: string, sessionId?: string): Promise<ToolResultArtifactMeta | undefined> {
    const safeSessionId = toSafeSessionId(sessionId ?? DEFAULT_SESSION_ID);

    try {
      const raw = await readFile(this.metaPath(assertSafeId(id), safeSessionId), "utf8");
      return parseMeta(raw, safeSessionId);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  /** 先持久化 evicted marker 再删正文，崩溃时不会出现一个声称 available 的空引用。 */
  async markEvicted(id: string, sessionId?: string): Promise<ToolResultArtifactMeta | undefined> {
    const safeSessionId = toSafeSessionId(sessionId ?? DEFAULT_SESSION_ID);
    const meta = await this.readMeta(id, sessionId);
    if (!meta) return undefined;
    const evicted = {
      ...meta,
      schemaVersion: 2,
      availability: "evicted",
    } satisfies ToolResultArtifactMeta;
    await writeJsonAtomic(this.metaPath(assertSafeId(id), safeSessionId), evicted);
    await unlinkIfExists(this.contentPath(id, safeSessionId));
    return evicted;
  }

  async cleanup(sessionId: string, now?: Date): Promise<CleanupResult>;
  async cleanup(now?: Date): Promise<CleanupResult>;
  async cleanup(sessionIdOrNow?: string | Date, now?: Date): Promise<CleanupResult> {
    const targetSessionId =
      typeof sessionIdOrNow === "string" ? toSafeSessionId(sessionIdOrNow) : undefined;
    const cleanupNow = sessionIdOrNow instanceof Date ? sessionIdOrNow : (now ?? new Date());

    const artifacts = await this.listArtifacts(targetSessionId);
    const ordered = artifacts.toSorted(compareArtifactAge);
    const deletedKeys = new Set<string>();
    const deleted: string[] = [];
    let totalBytes = ordered.reduce((sum, artifact) => sum + artifact.meta.sizeBytes, 0);

    for (const artifact of ordered) {
      if (artifact.meta.pinned || !isExpired(artifact.meta, cleanupNow)) {
        continue;
      }

      await this.deleteArtifact(artifact.meta.id, artifact.meta.safeSessionId);
      deletedKeys.add(artifact.key);
      deleted.push(artifact.meta.id);
      totalBytes -= artifact.meta.sizeBytes;
    }

    if (totalBytes > this.maxTotalBytes) {
      for (const artifact of ordered) {
        if (totalBytes <= this.maxTotalBytes) {
          break;
        }
        if (artifact.meta.pinned || deletedKeys.has(artifact.key)) {
          continue;
        }

        await this.deleteArtifact(artifact.meta.id, artifact.meta.safeSessionId);
        deletedKeys.add(artifact.key);
        deleted.push(artifact.meta.id);
        totalBytes -= artifact.meta.sizeBytes;
      }
    }

    // pinned 表示“优先保留错误证据”，不能绕过整个存储硬上限。
    // 只在清理所有可清理的非 pinned artifact 后仍超额时，才按时间删最旧 pinned。
    if (totalBytes > this.maxTotalBytes) {
      for (const artifact of ordered) {
        if (totalBytes <= this.maxTotalBytes) break;
        if (!artifact.meta.pinned || deletedKeys.has(artifact.key)) continue;
        await this.deleteArtifact(artifact.meta.id, artifact.meta.safeSessionId);
        deletedKeys.add(artifact.key);
        deleted.push(artifact.meta.id);
        totalBytes -= artifact.meta.sizeBytes;
      }
    }

    return {
      deleted,
      retained: ordered
        .filter((artifact) => !deletedKeys.has(artifact.key))
        .map((artifact) => artifact.meta.id),
    };
  }

  async deleteSessionArtifacts(sessionId: string): Promise<CleanupResult> {
    const safeSessionId = toSafeSessionId(sessionId);
    const artifactDir = this.sessionArtifactDir(safeSessionId);
    const entries = await readDirIfExists(artifactDir);
    const ids = new Set<string>();

    for (const entry of entries.toSorted()) {
      const id = artifactIdFromFilename(entry);
      if (id === undefined) {
        continue;
      }

      await unlinkIfExists(join(artifactDir, entry));
      ids.add(id);
    }

    await rmdirIfEmpty(artifactDir);
    await rmdirIfEmpty(this.sessionDir(safeSessionId));

    return {
      deleted: [...ids].toSorted(),
      retained: [],
    };
  }

  private async listArtifacts(sessionId?: string): Promise<StoredArtifact[]> {
    const sessionIds = sessionId === undefined ? await this.listSessionIds() : [sessionId];
    const artifacts: StoredArtifact[] = [];

    for (const currentSessionId of sessionIds) {
      const entries = await readDirIfExists(this.sessionArtifactDir(currentSessionId));

      for (const entry of entries.toSorted()) {
        if (!entry.endsWith(".json")) {
          continue;
        }

        const id = entry.slice(0, -".json".length);
        if (!SAFE_ID_RE.test(id)) {
          continue;
        }

        const meta = await this.readMeta(id, currentSessionId);
        if (!meta) {
          continue;
        }

        artifacts.push({
          key: artifactKey(meta),
          meta,
          createdAtMs: toTime(meta.createdAt),
        });
      }
    }

    return artifacts;
  }

  private async listSessionIds(): Promise<string[]> {
    const entries = await readDirIfExists(this.sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  }

  private async deleteArtifact(id: string, safeSessionId: string): Promise<void> {
    const safeId = assertSafeId(id);
    const artifactDir = this.sessionArtifactDir(safeSessionId);
    await unlinkIfExists(this.contentPath(safeId, safeSessionId));
    await unlinkIfExists(this.metaPath(safeId, safeSessionId));
    await rmdirIfEmpty(artifactDir);
    await rmdirIfEmpty(this.sessionDir(safeSessionId));
  }

  private contentPath(id: string, sessionId: string): string {
    return join(this.sessionArtifactDir(sessionId), `${id}.txt`);
  }

  private metaPath(id: string, sessionId: string): string {
    return join(this.sessionArtifactDir(sessionId), `${id}.json`);
  }

  private sessionArtifactDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "tool-results");
  }

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }
}

function generateId(): string {
  generatedIdCounter++;
  return `tool-result-${Date.now()}-${generatedIdCounter}`;
}

function assertSafeId(id: string): string {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid artifact id: ${id}`);
  }
  return id;
}

function toSafeSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(UNSAFE_SESSION_CHAR_RE, "_");
  const safeBase = sanitized === "" || sanitized === "." || sanitized === ".." ? "_" : sanitized;

  if (safeBase === sessionId) {
    return safeBase;
  }

  return `${safeBase}-${hashText(sessionId).slice(0, 12)}`;
}

function artifactKey(meta: ToolResultArtifactMeta): string {
  return `${meta.safeSessionId}/${meta.id}`;
}

/** Artifact 写入与 Inspector 绑定共用同一套稳定参数哈希。 */
export function hashToolResultArtifactArgs(args: unknown): string {
  return hashText(stableStringify(args));
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value)) ?? "undefined";
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right));

    for (const [key, child] of entries) {
      if (child !== undefined) {
        out[key] = toStableJsonValue(child);
      }
    }

    return out;
  }

  return value;
}

function parseMeta(raw: string, safeSessionId: string): ToolResultArtifactMeta | undefined {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return undefined;
  }

  const id = parsed.id;
  const sessionId = parsed.sessionId;
  const parsedSafeSessionId = parsed.safeSessionId;
  const toolName = parsed.toolName;
  const argsHash = parsed.argsHash;
  const createdAt = parsed.createdAt;
  const sizeBytes = parsed.sizeBytes;
  const ttlHours = parsed.ttlHours;
  const pinned = parsed.pinned;
  const summary = parsed.summary;
  const path = parsed.path;
  const schemaVersion = parsed.schemaVersion;
  const contentHash = parsed.contentHash;
  const availability = parsed.availability;

  if (
    typeof id !== "string" ||
    !SAFE_ID_RE.test(id) ||
    (sessionId !== undefined && typeof sessionId !== "string") ||
    (parsedSafeSessionId !== undefined && typeof parsedSafeSessionId !== "string") ||
    typeof toolName !== "string" ||
    typeof createdAt !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof ttlHours !== "number" ||
    typeof pinned !== "boolean" ||
    typeof path !== "string"
  ) {
    return undefined;
  }

  if (schemaVersion !== undefined && schemaVersion !== 2) return undefined;
  if (
    contentHash !== undefined &&
    (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(contentHash))
  ) {
    return undefined;
  }
  if (availability !== undefined && availability !== "available" && availability !== "evicted") {
    return undefined;
  }

  return {
    schemaVersion: 2,
    id,
    sessionId: typeof sessionId === "string" ? sessionId : safeSessionId,
    safeSessionId: typeof parsedSafeSessionId === "string" ? parsedSafeSessionId : safeSessionId,
    toolName,
    ...(typeof argsHash === "string" ? { argsHash } : {}),
    createdAt,
    sizeBytes,
    ttlHours,
    pinned,
    ...(typeof summary === "string" ? { summary } : {}),
    path,
    ...(typeof contentHash === "string" ? { contentHash } : {}),
    availability:
      availability === "available" || availability === "evicted" ? availability : "available",
  };
}

function normalizeMeta(meta: ToolResultArtifactMeta): ToolResultArtifactMeta {
  return {
    ...meta,
    schemaVersion: 2,
    availability: meta.availability ?? "available",
  };
}

async function unlinkCommitMarker(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function writeArtifactContentAtomic(path: string, output: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let published = false;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(output, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    published = true;
    await chmod(path, 0o600);
  } finally {
    await handle.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isExpired(meta: ToolResultArtifactMeta, now: Date): boolean {
  return toTime(meta.createdAt) + meta.ttlHours * 60 * 60 * 1000 <= now.getTime();
}

function compareArtifactAge(left: StoredArtifact, right: StoredArtifact): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }
  if (left.meta.id !== right.meta.id) {
    return left.meta.id.localeCompare(right.meta.id);
  }
  return left.meta.safeSessionId.localeCompare(right.meta.safeSessionId);
}

function toTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isNodeError(err) && (err.code === "ENOENT" || isWindowsTransientLock(err))) {
      return;
    }
    throw err;
  }
}

async function rmdirIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (err) {
    if (
      isNodeError(err) &&
      (err.code === "ENOENT" || err.code === "ENOTEMPTY" || isWindowsTransientLock(err))
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Windows 上删除操作偶发 EPERM:文件被杀软扫描、句柄未释放等瞬时占用。
 * 这种锁会在重试或稍后自行消失,不应让 session 清理整体失败。
 * 仅在 Windows 上把 EPERM 视为瞬时锁吞掉;POSIX 上的 EPERM 多为真实权限问题,继续抛出。
 */
function isWindowsTransientLock(err: NodeJS.ErrnoException): boolean {
  return process.platform === "win32" && err.code === "EPERM";
}

async function readDirIfExists(path: string): Promise<string[]>;
async function readDirIfExists(
  path: string,
  options: { withFileTypes: true },
): Promise<Array<{ name: string; isDirectory(): boolean }>>;
async function readDirIfExists(
  path: string,
  options?: { withFileTypes: true },
): Promise<string[] | Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return options ? await readdir(path, options) : await readdir(path);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function artifactIdFromFilename(filename: string): string | undefined {
  if (filename.endsWith(".txt")) {
    return safeArtifactIdFromFilename(filename, ".txt");
  }
  if (filename.endsWith(".json")) {
    return safeArtifactIdFromFilename(filename, ".json");
  }
  return undefined;
}

function safeArtifactIdFromFilename(filename: string, ext: ".txt" | ".json"): string | undefined {
  const id = filename.slice(0, -ext.length);
  return SAFE_ID_RE.test(id) ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
