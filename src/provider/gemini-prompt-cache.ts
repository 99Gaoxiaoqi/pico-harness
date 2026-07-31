import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";
import { isAbortError } from "./errors.js";
import { normalizePromptCacheEndpoint } from "./provider-endpoint.js";

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

export interface GeminiPromptCacheResolution {
  readonly name: string;
  /** Present only when this call created a new remote cache object. */
  readonly cacheWriteTokens?: number;
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
  private static readonly MAX_SHARED_STORES = 128;
  private static readonly sharedStores = new Map<string, FileGeminiPromptCacheStore>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** One process-local store/lock identity per workspace metadata path. */
  static shared(path: string): FileGeminiPromptCacheStore {
    const canonical = resolve(path);
    const existing = this.sharedStores.get(canonical);
    if (existing) {
      this.sharedStores.delete(canonical);
      this.sharedStores.set(canonical, existing);
      return existing;
    }
    const created = new FileGeminiPromptCacheStore(canonical);
    this.sharedStores.set(canonical, created);
    if (this.sharedStores.size > this.MAX_SHARED_STORES) {
      const oldest = this.sharedStores.keys().next().value;
      if (oldest !== undefined) this.sharedStores.delete(oldest);
    }
    return created;
  }

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
    await this.mutate((current) => [
      ...current.filter((candidate) => candidate.key !== record.key),
      record,
    ]);
  }

  async remove(key: string): Promise<void> {
    await this.mutate((current) => current.filter((candidate) => candidate.key !== key));
  }

  private async mutate(
    transform: (records: readonly GeminiPromptCacheRecord[]) => GeminiPromptCacheRecord[],
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.list();
      const records = transform(current);
      if (
        records.length === current.length &&
        records.every((record, index) => record === current[index])
      ) {
        return;
      }
      await writeJsonAtomic(
        this.path,
        { schemaVersion: 1, records },
        {
          directoryMode: 0o700,
          fileMode: 0o600,
        },
      );
    });
    this.mutationTail = operation.catch(() => undefined);
    await operation;
  }
}

export interface GeminiPromptCacheTransport {
  create(input: {
    readonly model: string;
    readonly ttlSeconds: number;
    readonly source: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{ name: string; expireAt?: number; tokenCount?: number }>;
  updateTtl?(
    name: string,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ expireAt?: number }>;
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
  /**
   * Process-wide key locks are scoped by the runtime-owned store object. They deduplicate sibling
   * providers and serialize startup cleanup against creation without sharing names across
   * workspaces.
   */
  private static readonly operationsByStore = new WeakMap<
    GeminiPromptCacheStore,
    Map<string, Promise<void>>
  >();
  private readonly store: GeminiPromptCacheStore;
  private readonly operations: Map<string, Promise<void>>;
  private readonly now: () => number;
  private readonly baseUrlDigest: string;

  constructor(private readonly options: GeminiPromptCacheControllerOptions) {
    this.store = options.store ?? new MemoryGeminiPromptCacheStore();
    this.operations =
      GeminiPromptCacheController.operationsByStore.get(this.store) ??
      new Map<string, Promise<void>>();
    GeminiPromptCacheController.operationsByStore.set(this.store, this.operations);
    this.now = options.now ?? Date.now;
    this.baseUrlDigest = sha256(normalizePromptCacheEndpoint(options.baseURL));
  }

  async getOrCreate(
    source: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<GeminiPromptCacheResolution | undefined> {
    signal?.throwIfAborted();
    const digest = stableDigest(source);
    const key = ["gemini", this.baseUrlDigest, this.options.model, digest].join(":");
    return this.withKeyLock(key, () => this.resolve(key, digest, source, signal), signal);
  }

  /** Best-effort startup maintenance; metadata failures must never surface to the provider. */
  async cleanupExpiredEntries(): Promise<void> {
    try {
      await this.cleanupExpired(await this.store.list(), this.now());
    } catch {
      // Prompt cache is optional.
    }
  }

  /** Forget a server-rejected name so later requests do not repeat the same failed cache read. */
  async invalidateName(name: string): Promise<void> {
    try {
      const records = await this.store.list();
      await Promise.all(
        records
          .filter((record) => record.name === name)
          .map((record) =>
            this.withKeyLock(record.key, async () => {
              const current = (await this.store.list()).find(
                (candidate) => candidate.key === record.key,
              );
              if (current?.name === name) await this.invalidate(current);
            }),
          ),
      );
    } catch {
      // Prompt cache is optional.
    }
  }

  private async resolve(
    key: string,
    digest: string,
    source: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<GeminiPromptCacheResolution | undefined> {
    let fallbackName: string | undefined;
    try {
      const now = this.now();
      const records = await this.store.list();
      const record = records.find((candidate) => candidate.key === key);
      if (record && record.expireAt > now && this.shouldRefresh(record, now) === false) {
        return { name: record.name };
      }
      const usableRecord = record && record.expireAt > now ? record : undefined;
      fallbackName = usableRecord?.name;
      if (record && !usableRecord) await this.invalidate(record);

      if (usableRecord && this.options.transport.updateTtl) {
        try {
          const updated = await this.options.transport.updateTtl(
            usableRecord.name,
            this.options.ttlSeconds,
            signal,
          );
          const renewed = {
            ...usableRecord,
            expireAt: updated.expireAt ?? now + this.options.ttlSeconds * 1_000,
          };
          await this.store.put(renewed);
          return { name: renewed.name };
        } catch (error) {
          signal?.throwIfAborted();
          if (isAbortError(error)) throw error;
          // Keep using the still-valid object. A later request may renew it or fail open.
          return { name: usableRecord.name };
        }
      }

      const created = await this.options.transport.create({
        model: this.options.model,
        ttlSeconds: this.options.ttlSeconds,
        source,
        ...(signal ? { signal } : {}),
      });
      if (!created.name) return undefined;
      const expireAt = created.expireAt ?? now + this.options.ttlSeconds * 1_000;
      try {
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
      } catch {
        // The remote object may contain the stable system/tools prefix. If metadata cannot be
        // committed, delete it best-effort so the next call neither leaks nor double-creates it.
        void this.options.transport.delete(created.name).catch(() => undefined);
        return usableRecord ? { name: usableRecord.name } : undefined;
      }
      if (usableRecord && usableRecord.name !== created.name) {
        void this.options.transport.delete(usableRecord.name).catch(() => undefined);
      }
      return {
        name: created.name,
        ...(created.tokenCount === undefined ? {} : { cacheWriteTokens: created.tokenCount }),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      return fallbackName ? { name: fallbackName } : undefined;
    }
  }

  private shouldRefresh(record: GeminiPromptCacheRecord, now: number): boolean {
    return record.expireAt - now <= record.ttlSeconds * 1_000 * 0.2;
  }

  private async cleanupExpired(
    records: readonly GeminiPromptCacheRecord[],
    now: number,
  ): Promise<void> {
    await Promise.all(
      records
        .filter((record) => record.expireAt <= now)
        .map((record) =>
          this.withKeyLock(record.key, async () => {
            const current = (await this.store.list()).find(
              (candidate) => candidate.key === record.key,
            );
            if (current?.name === record.name && current.expireAt <= now) {
              await this.invalidate(current);
            }
          }),
        ),
    );
  }

  private async invalidate(record: GeminiPromptCacheRecord): Promise<void> {
    // Remove local metadata even if remote deletion is denied; stale names must never be reused.
    await this.store.remove(record.key).catch(() => undefined);
    // Remote deletion is best-effort maintenance and must not hold a request-path key lock.
    void this.options.transport.delete(record.name).catch(() => undefined);
  }

  private async withKeyLock<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      const pending = this.operations.get(key);
      if (!pending) break;
      await waitForPromise(pending, signal);
    }
    signal?.throwIfAborted();
    let release: (() => void) | undefined;
    const lease = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operations.set(key, lease);
    try {
      return await operation();
    } finally {
      if (this.operations.get(key) === lease) this.operations.delete(key);
      release?.();
    }
  }
}

async function waitForPromise(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await promise.catch(() => undefined);
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise.catch(() => undefined), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

/** Operator-facing, secret-free gate bound to one endpoint/model native-cache route. */
export function geminiPromptCacheGateId(baseURL: string, model: string): string {
  return `gemini-cache:${sha256(
    JSON.stringify({
      protocol: "gemini-cachedContents-v1beta",
      baseURL: normalizePromptCacheEndpoint(baseURL),
      model,
    }),
  )}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
    (value["tokenCount"] !== undefined && !isNonNegativeFiniteNumber(value["tokenCount"]))
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

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
