import { createHash } from "node:crypto";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";

export interface GeminiPromptCacheRecord {
  /** Cache identity, never includes prompt text or credentials. */
  readonly key: string;
  readonly provider: "gemini";
  readonly baseUrlDigest: string;
  readonly model: string;
  readonly digest: string;
  readonly name: string;
  readonly expireAt: number;
  readonly tokenCount?: number;
  readonly ttlSeconds: number;
}

export interface GeminiPromptCacheStore {
  list(): Promise<readonly GeminiPromptCacheRecord[]>;
  put(record: GeminiPromptCacheRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

/** In-memory default keeps direct provider construction side-effect free. */
export class MemoryGeminiPromptCacheStore implements GeminiPromptCacheStore {
  private readonly records = new Map<string, GeminiPromptCacheRecord>();

  async list(): Promise<readonly GeminiPromptCacheRecord[]> {
    return [...this.records.values()];
  }

  async put(record: GeminiPromptCacheRecord): Promise<void> {
    this.records.set(record.key, { ...record });
  }

  async remove(key: string): Promise<void> {
    this.records.delete(key);
  }
}

/** Workspace-private metadata only. The remote cached content remains the prompt authority. */
export class FileGeminiPromptCacheStore implements GeminiPromptCacheStore {
  constructor(private readonly path: string) {}

  async list(): Promise<readonly GeminiPromptCacheRecord[]> {
    try {
      const decoded = await readVersionedJson(this.path, decodeStore);
      return decoded.records;
    } catch (error) {
      if (isMissing(error)) return [];
      // Cache metadata is an optimization. A corrupt or unavailable file must not block a model call.
      return [];
    }
  }

  async put(record: GeminiPromptCacheRecord): Promise<void> {
    const current = await this.list();
    const records = [...current.filter((candidate) => candidate.key !== record.key), record];
    await writeJsonAtomic(this.path, { schemaVersion: 1, records }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  async remove(key: string): Promise<void> {
    const current = await this.list();
    const records = current.filter((candidate) => candidate.key !== key);
    if (records.length === current.length) return;
    await writeJsonAtomic(this.path, { schemaVersion: 1, records }, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

}

export interface GeminiPromptCacheTransport {
  create(input: {
    readonly model: string;
    readonly ttlSeconds: number;
    readonly source: Readonly<Record<string, unknown>>;
  }): Promise<{ name: string; expireAt?: number; tokenCount?: number }>;
  delete(name: string): Promise<void>;
}

export interface GeminiPromptCacheControllerOptions {
  readonly store?: GeminiPromptCacheStore;
  readonly transport: GeminiPromptCacheTransport;
  readonly baseURL: string;
  readonly model: string;
  readonly ttlSeconds: number;
  readonly now?: () => number;
}

/**
 * Owns only metadata and remote-object lifecycle. Every storage/transport failure is fail-open:
 * callers receive no name and send their normal full Gemini request.
 */
export class GeminiPromptCacheController {
  /** Process-wide key lease covers concurrently created providers/subagents sharing one workspace. */
  private static readonly creating = new Map<string, Promise<string | undefined>>();
  private readonly store: GeminiPromptCacheStore;
  private readonly now: () => number;
  private readonly baseUrlDigest: string;

  constructor(private readonly options: GeminiPromptCacheControllerOptions) {
    this.store = options.store ?? new MemoryGeminiPromptCacheStore();
    this.now = options.now ?? Date.now;
    this.baseUrlDigest = sha256(normalizeBaseURL(options.baseURL));
  }

  async getOrCreate(source: Readonly<Record<string, unknown>>): Promise<string | undefined> {
    const digest = stableDigest(source);
    const key = ["gemini", this.baseUrlDigest, this.options.model, digest].join(":");
    const existing = GeminiPromptCacheController.creating.get(key);
    if (existing) return existing;
    const task = this.resolve(key, digest, source).finally(() =>
      GeminiPromptCacheController.creating.delete(key),
    );
    GeminiPromptCacheController.creating.set(key, task);
    return task;
  }

  /** Best-effort startup maintenance; metadata failures must never surface to the provider. */
  async cleanupExpiredEntries(): Promise<void> {
    try {
      await this.cleanupExpired(await this.store.list(), this.now());
    } catch {
      // Prompt cache is optional.
    }
  }

  private async resolve(
    key: string,
    digest: string,
    source: Readonly<Record<string, unknown>>,
  ): Promise<string | undefined> {
    try {
      const now = this.now();
      const records = await this.store.list();
      await this.cleanupExpired(records, now);
      await Promise.all(
        records
          .filter(
            (candidate) =>
              candidate.baseUrlDigest === this.baseUrlDigest &&
              candidate.model === this.options.model &&
              candidate.key !== key &&
              candidate.expireAt > now,
          )
          .map(async (candidate) => this.invalidate(candidate)),
      );
      const record = records.find((candidate) => candidate.key === key);
      if (record && record.expireAt > now && this.shouldRefresh(record, now) === false) {
        return record.name;
      }
      if (record) await this.invalidate(record);

      const created = await this.options.transport.create({
        model: this.options.model,
        ttlSeconds: this.options.ttlSeconds,
        source,
      });
      if (!created.name) return undefined;
      const expireAt = created.expireAt ?? now + this.options.ttlSeconds * 1_000;
      await this.store.put({
        key,
        provider: "gemini",
        baseUrlDigest: this.baseUrlDigest,
        model: this.options.model,
        digest,
        name: created.name,
        expireAt,
        ...(created.tokenCount === undefined ? {} : { tokenCount: created.tokenCount }),
        ttlSeconds: this.options.ttlSeconds,
      });
      return created.name;
    } catch {
      return undefined;
    }
  }

  private shouldRefresh(record: GeminiPromptCacheRecord, now: number): boolean {
    return record.expireAt - now <= record.ttlSeconds * 1_000 * 0.2;
  }

  private async cleanupExpired(records: readonly GeminiPromptCacheRecord[], now: number): Promise<void> {
    await Promise.all(
      records
        .filter((record) => record.expireAt <= now)
        .map(async (record) => this.invalidate(record)),
    );
  }

  private async invalidate(record: GeminiPromptCacheRecord): Promise<void> {
    // Remove local metadata even if remote deletion is denied; stale names must never be reused.
    await this.store.remove(record.key).catch(() => undefined);
    await this.options.transport.delete(record.name).catch(() => undefined);
  }
}

export function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/u, "").toLowerCase();
}

function decodeStore(value: unknown): { records: GeminiPromptCacheRecord[] } {
  if (!isRecord(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["records"])) {
    throw new Error("Invalid Gemini prompt cache metadata");
  }
  return {
    records: value["records"].map(decodeRecord),
  };
}

function decodeRecord(value: unknown): GeminiPromptCacheRecord {
  if (
    !isRecord(value) ||
    value["provider"] !== "gemini" ||
    !isNonEmptyString(value["key"]) ||
    !isNonEmptyString(value["baseUrlDigest"]) ||
    !isNonEmptyString(value["model"]) ||
    !isNonEmptyString(value["digest"]) ||
    !isNonEmptyString(value["name"]) ||
    !isPositiveFiniteNumber(value["expireAt"]) ||
    !isPositiveFiniteNumber(value["ttlSeconds"]) ||
    (value["tokenCount"] !== undefined && !isPositiveFiniteNumber(value["tokenCount"]))
  ) {
    throw new Error("Invalid Gemini prompt cache record");
  }
  return {
    key: value["key"],
    provider: "gemini",
    baseUrlDigest: value["baseUrlDigest"],
    model: value["model"],
    digest: value["digest"],
    name: value["name"],
    expireAt: value["expireAt"],
    ...(typeof value["tokenCount"] === "number" ? { tokenCount: value["tokenCount"] } : {}),
    ttlSeconds: value["ttlSeconds"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
