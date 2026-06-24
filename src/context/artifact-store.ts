import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_TTL_HOURS = 168;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_SESSION_ID = "default";
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const UNSAFE_SESSION_CHAR_RE = /[^A-Za-z0-9._-]/g;

let generatedIdCounter = 0;

export interface ToolResultArtifactMeta {
  id: string;
  sessionId: string;
  toolName: string;
  argsHash?: string;
  createdAt: string;
  sizeBytes: number;
  ttlHours: number;
  pinned: boolean;
  summary?: string;
  path: string;
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
    const sessionId = sanitizeSessionId(input.sessionId);
    const artifactDir = this.sessionArtifactDir(sessionId);
    const path = this.contentPath(id, sessionId);
    const createdAt = new Date().toISOString();
    const ttlHours = input.ttlHours ?? this.ttlHours;
    const meta: ToolResultArtifactMeta = {
      id,
      sessionId,
      toolName: input.toolName,
      argsHash: hashArgs(input.args),
      createdAt,
      sizeBytes: Buffer.byteLength(input.output, "utf8"),
      ttlHours,
      pinned: input.pinned ?? false,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      path,
    };

    await mkdir(artifactDir, { recursive: true });
    await writeFile(path, input.output, "utf8");
    await writeFile(this.metaPath(id, sessionId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    return meta;
  }

  async read(metaOrId: ToolResultArtifactMeta | string): Promise<string | undefined> {
    const id = typeof metaOrId === "string" ? metaOrId : metaOrId.id;
    const sessionId =
      typeof metaOrId === "string" ? DEFAULT_SESSION_ID : sanitizeSessionId(metaOrId.sessionId);

    try {
      return await readFile(this.contentPath(assertSafeId(id), sessionId), "utf8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async readMeta(id: string, sessionId?: string): Promise<ToolResultArtifactMeta | undefined> {
    const safeSessionId = sanitizeSessionId(sessionId);

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

  async cleanup(sessionId: string, now?: Date): Promise<CleanupResult>;
  async cleanup(now?: Date): Promise<CleanupResult>;
  async cleanup(sessionIdOrNow?: string | Date, now?: Date): Promise<CleanupResult> {
    const targetSessionId =
      typeof sessionIdOrNow === "string" ? sanitizeSessionId(sessionIdOrNow) : undefined;
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

      await this.deleteArtifact(artifact.meta.id, artifact.meta.sessionId);
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

        await this.deleteArtifact(artifact.meta.id, artifact.meta.sessionId);
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
    const safeSessionId = sanitizeSessionId(sessionId);
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

  private async deleteArtifact(id: string, sessionId: string): Promise<void> {
    const safeId = assertSafeId(id);
    const safeSessionId = sanitizeSessionId(sessionId);
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

function sanitizeSessionId(sessionId: string | undefined): string {
  const sanitized = (sessionId ?? DEFAULT_SESSION_ID).replace(UNSAFE_SESSION_CHAR_RE, "_");

  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return "_";
  }

  return sanitized;
}

function artifactKey(meta: ToolResultArtifactMeta): string {
  return `${meta.sessionId}/${meta.id}`;
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
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

function parseMeta(raw: string, sessionId: string): ToolResultArtifactMeta | undefined {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return undefined;
  }

  const id = parsed.id;
  const toolName = parsed.toolName;
  const argsHash = parsed.argsHash;
  const createdAt = parsed.createdAt;
  const sizeBytes = parsed.sizeBytes;
  const ttlHours = parsed.ttlHours;
  const pinned = parsed.pinned;
  const summary = parsed.summary;
  const path = parsed.path;

  if (
    typeof id !== "string" ||
    !SAFE_ID_RE.test(id) ||
    typeof toolName !== "string" ||
    typeof createdAt !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof ttlHours !== "number" ||
    typeof pinned !== "boolean" ||
    typeof path !== "string"
  ) {
    return undefined;
  }

  return {
    id,
    sessionId,
    toolName,
    ...(typeof argsHash === "string" ? { argsHash } : {}),
    createdAt,
    sizeBytes,
    ttlHours,
    pinned,
    ...(typeof summary === "string" ? { summary } : {}),
    path,
  };
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
  return left.meta.sessionId.localeCompare(right.meta.sessionId);
}

function toTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

async function rmdirIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (err) {
    if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTEMPTY")) {
      return;
    }
    throw err;
  }
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
