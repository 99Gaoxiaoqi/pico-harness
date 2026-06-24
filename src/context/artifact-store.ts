import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_TTL_HOURS = 168;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

let generatedIdCounter = 0;

export interface ToolResultArtifactMeta {
  id: string;
  sessionId?: string;
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
  meta: ToolResultArtifactMeta;
  createdAtMs: number;
}

export class ToolResultArtifactStore {
  private readonly artifactDir: string;
  private readonly ttlHours: number;
  private readonly maxTotalBytes: number;

  constructor(opts: ToolResultArtifactStoreOptions) {
    this.artifactDir = join(resolve(opts.baseDir), "tool-results");
    this.ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  async write(input: WriteToolResultArtifactInput): Promise<ToolResultArtifactMeta> {
    const id = input.id ? assertSafeId(input.id) : generateId();
    const path = this.contentPath(id);
    const createdAt = new Date().toISOString();
    const ttlHours = input.ttlHours ?? this.ttlHours;
    const meta: ToolResultArtifactMeta = {
      id,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      toolName: input.toolName,
      argsHash: hashArgs(input.args),
      createdAt,
      sizeBytes: Buffer.byteLength(input.output, "utf8"),
      ttlHours,
      pinned: input.pinned ?? false,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      path,
    };

    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(path, input.output, "utf8");
    await writeFile(this.metaPath(id), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    return meta;
  }

  async read(metaOrId: ToolResultArtifactMeta | string): Promise<string | undefined> {
    const id = typeof metaOrId === "string" ? metaOrId : metaOrId.id;

    try {
      return await readFile(this.contentPath(assertSafeId(id)), "utf8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async readMeta(id: string): Promise<ToolResultArtifactMeta | undefined> {
    try {
      const raw = await readFile(this.metaPath(assertSafeId(id)), "utf8");
      return parseMeta(raw);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async cleanup(now = new Date()): Promise<CleanupResult> {
    await mkdir(this.artifactDir, { recursive: true });

    const artifacts = await this.listArtifacts();
    const ordered = artifacts.toSorted(compareArtifactAge);
    const deleted = new Set<string>();
    let totalBytes = ordered.reduce((sum, artifact) => sum + artifact.meta.sizeBytes, 0);

    for (const artifact of ordered) {
      if (artifact.meta.pinned || !isExpired(artifact.meta, now)) {
        continue;
      }

      await this.deleteArtifact(artifact.meta.id);
      deleted.add(artifact.meta.id);
      totalBytes -= artifact.meta.sizeBytes;
    }

    if (totalBytes > this.maxTotalBytes) {
      for (const artifact of ordered) {
        if (totalBytes <= this.maxTotalBytes) {
          break;
        }
        if (artifact.meta.pinned || deleted.has(artifact.meta.id)) {
          continue;
        }

        await this.deleteArtifact(artifact.meta.id);
        deleted.add(artifact.meta.id);
        totalBytes -= artifact.meta.sizeBytes;
      }
    }

    return {
      deleted: [...deleted],
      retained: ordered.map((artifact) => artifact.meta.id).filter((id) => !deleted.has(id)),
    };
  }

  private async listArtifacts(): Promise<StoredArtifact[]> {
    const entries = await readdir(this.artifactDir);
    const artifacts: StoredArtifact[] = [];

    for (const entry of entries.toSorted()) {
      if (!entry.endsWith(".json")) {
        continue;
      }

      const id = entry.slice(0, -".json".length);
      if (!SAFE_ID_RE.test(id)) {
        continue;
      }

      const meta = await this.readMeta(id);
      if (!meta) {
        continue;
      }

      artifacts.push({
        meta,
        createdAtMs: toTime(meta.createdAt),
      });
    }

    return artifacts;
  }

  private async deleteArtifact(id: string): Promise<void> {
    const safeId = assertSafeId(id);
    await unlinkIfExists(this.contentPath(safeId));
    await unlinkIfExists(this.metaPath(safeId));
  }

  private contentPath(id: string): string {
    return join(this.artifactDir, `${id}.txt`);
  }

  private metaPath(id: string): string {
    return join(this.artifactDir, `${id}.json`);
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

function parseMeta(raw: string): ToolResultArtifactMeta | undefined {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return undefined;
  }

  const id = parsed.id;
  const sessionId = parsed.sessionId;
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
    ...(typeof sessionId === "string" ? { sessionId } : {}),
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
  return left.meta.id.localeCompare(right.meta.id);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
