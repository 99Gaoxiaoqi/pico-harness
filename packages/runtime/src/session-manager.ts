import {
  claimSessionManagerKey,
  releaseSessionManagerKey,
  sessionDrains,
} from "./session-manager-state.js";

/** The minimum durable lifecycle surface owned by a Runtime Session manager. */
export interface RuntimeManagedSession {
  readonly id: string;
  readonly workDir: string;
  readonly picoHome?: string;
  readonly runtimeStorageRoot?: string;
  readonly hasPendingTasks: boolean;
  recover(): Promise<void>;
  close(): Promise<void>;
}

/** Stable path inputs needed to resolve a manager-owned Session identity. */
export interface RuntimeSessionOpenOptions {
  readonly picoHome?: string;
  readonly runtimeStorageRoot?: string;
}

export interface RuntimeSessionManagerOptions<
  Session extends RuntimeManagedSession,
  OpenOptions extends RuntimeSessionOpenOptions,
> {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  /** Factory remains an outer Engine/Host concern. */
  readonly createSession: (id: string, workDir: string, options?: OpenOptions) => Session;
  /** Host-owned workspace canonicalization; Runtime never imports Pico paths. */
  readonly entryKey: (id: string, workDir: string, options?: RuntimeSessionOpenOptions) => string;
  /** Observability is injected so eviction never depends on a product logger. */
  readonly onDrainError?: (input: {
    readonly key: string;
    readonly session: Session;
    readonly error: unknown;
  }) => void;
}

export interface RuntimeSessionManagerLease<Session extends RuntimeManagedSession> {
  readonly session: Session;
  /** Idempotently release this exact manager-owned pin. */
  release(): void;
}

type SessionEntry<Session extends RuntimeManagedSession> = {
  readonly session: Session;
  lastAccessMs: number;
  pinCount: number;
};

/**
 * In-process durable Session registry and lifecycle policy.
 *
 * Runtime owns routing, pinning, eviction and shared drain fences. The concrete
 * Session implementation, path identity and logging stay outside this package.
 */
export class RuntimeSessionManager<
  Session extends RuntimeManagedSession,
  OpenOptions extends RuntimeSessionOpenOptions,
> {
  static readonly DEFAULT_MAX_SESSIONS = 128;
  static readonly DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

  private readonly entries = new Map<string, SessionEntry<Session>>();
  /** Merge concurrent recoveries owned by this manager; managers never share entries. */
  private readonly openingByKey = new Map<string, Promise<Session>>();
  /** Pins reserved before an async recovery publishes its managed entry. */
  private readonly openingPinReservations = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly owner = Symbol("SessionManager");

  constructor(private readonly options: RuntimeSessionManagerOptions<Session, OpenOptions>) {
    this.maxSessions = options.maxSessions ?? RuntimeSessionManager.DEFAULT_MAX_SESSIONS;
    this.ttlMs = options.ttlMs ?? RuntimeSessionManager.DEFAULT_TTL_MS;
  }

  async getOrCreate(id: string, workDir: string, options?: OpenOptions): Promise<Session> {
    this.evictExpired();
    const key = this.entryKey(id, workDir, options);
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

  /** Atomically acquire or recover a Session together with an eviction-safe pin. */
  async getOrCreatePinned(
    id: string,
    workDir: string,
    options?: OpenOptions,
  ): Promise<RuntimeSessionManagerLease<Session>> {
    this.evictExpired();
    const key = this.entryKey(id, workDir, options);
    const existing = this.entries.get(key);
    if (existing) return this.pinEntry(key, existing);

    this.openingPinReservations.set(key, (this.openingPinReservations.get(key) ?? 0) + 1);
    try {
      const session = await this.getOrCreate(id, workDir, options);
      const entry = this.entries.get(key);
      if (!entry || entry.session !== session) {
        throw new Error(`SessionManager lost pinned Session during recovery: ${id}`);
      }
      return this.reservedPinLease(key, entry);
    } catch (error) {
      this.releaseOpeningPinReservation(key);
      throw error;
    }
  }

  get(id: string, workDir?: string, options: RuntimeSessionOpenOptions = {}): Session | undefined {
    const key = this.findEntryKey(id, workDir, options);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccessMs = Date.now();
    this.touch(key);
    return entry.session;
  }

  pin(session: Session): () => void {
    const key = this.entryKey(session.id, session.workDir, {
      ...(session.picoHome ? { picoHome: session.picoHome } : {}),
      ...(session.runtimeStorageRoot ? { runtimeStorageRoot: session.runtimeStorageRoot } : {}),
    });
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(`SessionManager cannot pin unmanaged Session: ${session.id}`);
    }
    if (entry.session !== session) {
      throw new Error(`SessionManager cannot pin a different Session instance: ${session.id}`);
    }
    return this.pinEntry(key, entry).release;
  }

  delete(
    id: string,
    workDir?: string,
    options: Pick<RuntimeSessionOpenOptions, "picoHome"> = {},
  ): Session | undefined {
    const key = this.findEntryKey(id, workDir, options);
    if (!key) return undefined;
    return this.deleteByKey(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.deleteByKey(key);
  }

  /** Removes every inactive Session and waits until its durable resources are released. */
  async clearAndDrain(): Promise<void> {
    if (this.openingByKey.size > 0 || this.openingPinReservations.size > 0) {
      throw new Error("SessionManager cannot drain while Session acquisition is in progress");
    }
    const pinned = [...this.entries.values()].filter((entry) => entry.pinCount > 0);
    if (pinned.length > 0) {
      throw new Error(
        `SessionManager cannot drain ${pinned.length} pinned Session${pinned.length === 1 ? "" : "s"}`,
      );
    }

    const draining: Promise<void>[] = [];
    for (const key of [...this.entries.keys()]) {
      const session = this.deleteByKey(key);
      if (session) draining.push(session.close());
    }
    await Promise.all(draining);
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
    if (!entry || entry.pinCount > 0) return undefined;
    this.entries.delete(key);
    this.startDrain(key, entry.session);
    releaseSessionManagerKey(key, this.owner);
    return entry.session;
  }

  private async openAfterDrain(
    key: string,
    id: string,
    workDir: string,
    options?: OpenOptions,
  ): Promise<Session> {
    if (!claimSessionManagerKey(key, this.owner)) {
      throw new Error(
        `Session ${id} is already owned by another SessionManager; reuse the canonical process manager`,
      );
    }
    try {
      await sessionDrains.get(key);
    } catch (error) {
      releaseSessionManagerKey(key, this.owner);
      throw error;
    }

    const existing = this.entries.get(key);
    if (existing) {
      this.transferOpeningPinReservations(key, existing);
      existing.lastAccessMs = Date.now();
      this.touch(key);
      return existing.session;
    }

    let session: Session | undefined;
    try {
      session = this.options.createSession(id, workDir, options);
      await session.recover();
    } catch (error) {
      await session?.close().catch(() => undefined);
      releaseSessionManagerKey(key, this.owner);
      throw error;
    }
    if (!session) throw new Error(`Session factory did not create ${id}`);
    const entry: SessionEntry<Session> = { session, lastAccessMs: Date.now(), pinCount: 0 };
    this.transferOpeningPinReservations(key, entry);
    this.entries.set(key, entry);
    this.evictLru(key);
    return session;
  }

  private pinEntry(key: string, entry: SessionEntry<Session>): RuntimeSessionManagerLease<Session> {
    entry.pinCount++;
    entry.lastAccessMs = Date.now();
    this.touch(key);
    return this.reservedPinLease(key, entry);
  }

  private reservedPinLease(
    key: string,
    entry: SessionEntry<Session>,
  ): RuntimeSessionManagerLease<Session> {
    let released = false;
    return {
      session: entry.session,
      release: (): void => {
        if (released) return;
        released = true;
        entry.pinCount--;
        if (entry.pinCount < 0) {
          throw new Error(`SessionManager pin underflow: ${entry.session.id}`);
        }
        if (entry.pinCount === 0 && this.entries.get(key) === entry) {
          entry.lastAccessMs = Date.now();
          this.touch(key);
        }
      },
    };
  }

  private transferOpeningPinReservations(
    key: string,
    entry: Pick<SessionEntry<Session>, "pinCount">,
  ): void {
    const reserved = this.openingPinReservations.get(key) ?? 0;
    if (reserved === 0) return;
    entry.pinCount += reserved;
    this.openingPinReservations.delete(key);
  }

  private releaseOpeningPinReservation(key: string): void {
    const reserved = this.openingPinReservations.get(key) ?? 0;
    if (reserved <= 1) this.openingPinReservations.delete(key);
    else this.openingPinReservations.set(key, reserved - 1);
  }

  private startDrain(key: string, session: Session): void {
    void session.close().catch((error: unknown) => {
      this.options.onDrainError?.({ key, session, error });
    });
  }

  private entryKey(id: string, workDir: string, options?: RuntimeSessionOpenOptions): string {
    return this.options.entryKey(id, workDir, options);
  }

  private findEntryKey(
    id: string,
    workDir?: string,
    options: RuntimeSessionOpenOptions = {},
  ): string | undefined {
    if (workDir !== undefined) {
      const key = this.entryKey(id, workDir, options);
      return this.entries.has(key) ? key : undefined;
    }

    for (const [key, entry] of [...this.entries].reverse()) {
      if (entry.session.id === id) return key;
    }
    return undefined;
  }
}
