import { logger } from "../observability/logger.js";
import type { Session, SessionOptions } from "./session.js";
import { sessionDrains, sessionEntryKey } from "./session-manager-state.js";

export interface SessionManagerOptions {
  maxSessions?: number;
  ttlMs?: number;
  /** Optional factory used by the owning Session module and isolated tests. */
  createSession?: (id: string, workDir: string, options?: SessionOptions) => Session;
}

let defaultSessionFactory:
  | ((id: string, workDir: string, options?: SessionOptions) => Session)
  | undefined;

/** Configure the default factory without importing Session at runtime. */
export function configureDefaultSessionFactory(
  factory: (id: string, workDir: string, options?: SessionOptions) => Session,
): void {
  defaultSessionFactory = factory;
}

/**
 * In-process Session registry and lifecycle policy.
 *
 * This class deliberately owns only routing, pinning, and eviction. Session remains
 * the durable owner; manager eviction merely invokes Session.close() after removing
 * the in-memory reference.
 */
export class SessionManager {
  static readonly DEFAULT_MAX_SESSIONS = 128;
  static readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  private readonly entries = new Map<
    string,
    { session: Session; lastAccessMs: number; pinCount: number }
  >();
  /** Merge concurrent recoveries for one key, even across manager instances. */
  private readonly openingByKey = new Map<string, Promise<Session>>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly createSession: NonNullable<SessionManagerOptions["createSession"]>;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? SessionManager.DEFAULT_MAX_SESSIONS;
    this.ttlMs = options.ttlMs ?? SessionManager.DEFAULT_TTL_MS;
    const factory = options.createSession ?? defaultSessionFactory;
    if (!factory) {
      throw new Error("SessionManager requires a configured Session factory");
    }
    this.createSession = factory;
  }

  async getOrCreate(id: string, workDir: string, options?: SessionOptions): Promise<Session> {
    this.evictExpired();

    const key = this.entryKey(id, workDir, options?.picoHome);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      this.touch(key);
      return existing.session;
    }

    const opening = this.openingByKey.get(key);
    if (opening) return opening;

    const created = this.openAfterDrain(key, id, workDir, options);
    this.openingByKey.set(key, created);
    try {
      return await created;
    } finally {
      if (this.openingByKey.get(key) === created) this.openingByKey.delete(key);
    }
  }

  get(
    id: string,
    workDir?: string,
    options: { readonly picoHome?: string } = {},
  ): Session | undefined {
    const key = this.findEntryKey(id, workDir, options.picoHome);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessMs = Date.now();
    this.touch(key);
    return entry.session;
  }

  pin(session: Session): () => void {
    const key = this.entryKey(session.id, session.workDir, session.picoHome);
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`SessionManager cannot pin unmanaged Session: ${session.id}`);
    }
    if (entry.session !== session) {
      throw new Error(`SessionManager cannot pin a different Session instance: ${session.id}`);
    }
    entry.pinCount++;
    entry.lastAccessMs = Date.now();
    this.touch(key);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.pinCount--;
      if (entry.pinCount < 0) {
        throw new Error(`SessionManager pin underflow: ${session.id}`);
      }
      if (entry.pinCount === 0 && this.entries.get(key) === entry) {
        entry.lastAccessMs = Date.now();
        this.touch(key);
      }
    };
  }

  delete(
    id: string,
    workDir?: string,
    options: { readonly picoHome?: string } = {},
  ): Session | undefined {
    const key = this.findEntryKey(id, workDir, options.picoHome);
    if (!key) return undefined;
    return this.deleteByKey(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.deleteByKey(key);
  }

  private touch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictLru(protectedKey?: string): void {
    while (this.entries.size > this.maxSessions) {
      const oldestInactive = [...this.entries].find(
        ([key, entry]) =>
          key !== protectedKey && entry.pinCount === 0 && !entry.session.hasPendingTasks,
      )?.[0];
      if (oldestInactive === undefined) break;
      this.deleteByKey(oldestInactive);
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (
        entry.pinCount === 0 &&
        !entry.session.hasPendingTasks &&
        now - entry.lastAccessMs > this.ttlMs
      ) {
        this.deleteByKey(key);
      }
    }
  }

  private deleteByKey(key: string): Session | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.startDrain(key, entry.session);
    return entry.session;
  }

  private async openAfterDrain(
    key: string,
    id: string,
    workDir: string,
    options?: SessionOptions,
  ): Promise<Session> {
    await sessionDrains.get(key);

    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccessMs = Date.now();
      this.touch(key);
      return existing.session;
    }

    const session = this.createSession(id, workDir, options);
    try {
      await session.recover();
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
    this.entries.set(key, { session, lastAccessMs: Date.now(), pinCount: 0 });
    this.evictLru(key);
    return session;
  }

  private startDrain(key: string, session: Session): void {
    void session.close().catch((error: unknown) => {
      logger.warn({ key, error: String(error) }, "[session] 驱逐时持久化 drain 失败");
    });
  }

  private entryKey(id: string, workDir: string, picoHome?: string): string {
    return sessionEntryKey(id, workDir, picoHome);
  }

  private findEntryKey(id: string, workDir?: string, picoHome?: string): string | undefined {
    if (workDir !== undefined) {
      const key = this.entryKey(id, workDir, picoHome);
      return this.entries.has(key) ? key : undefined;
    }

    for (const [key, entry] of [...this.entries].reverse()) {
      if (entry.session.id === id) return key;
    }
    return undefined;
  }
}
