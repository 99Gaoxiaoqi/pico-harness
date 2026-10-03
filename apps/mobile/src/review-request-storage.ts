export type PendingReviewRequest = {
  idempotencyKey: string;
  runId: string;
  expectedFingerprint: string;
  decision: "approve" | "request_changes";
  message?: string;
};
export interface ReviewStoragePort {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
}

// New panels must observe pending saves before deciding whether a new intent is allowed.
type StorageState = {
  tails: Map<string, Promise<unknown>>;
  keys: Set<string>;
  generations: Map<string, number>;
  blockedHosts: Set<string>;
  clearListeners: Map<string, Set<() => void>>;
};
const storageStates = new WeakMap<ReviewStoragePort, StorageState>();
function stateFor(storage: ReviewStoragePort): StorageState {
  let state = storageStates.get(storage);
  if (!state) {
    state = {
      tails: new Map(),
      keys: new Set(),
      generations: new Map(),
      blockedHosts: new Set(),
      clearListeners: new Map(),
    };
    storageStates.set(storage, state);
  }
  return state;
}
function reviewHostId(key: string): string | undefined {
  if (!key.startsWith("pico.mobile.review.v1:")) return undefined;
  try {
    const scope: unknown = JSON.parse(key.slice("pico.mobile.review.v1:".length));
    return Array.isArray(scope) && scope.length === 3 && typeof scope[0] === "string"
      ? scope[0]
      : undefined;
  } catch {
    return undefined;
  }
}
async function hostKeys(storage: ReviewStoragePort, hostId: string) {
  const keys = new Set([...stateFor(storage).keys, ...((await storage.getAllKeys?.()) ?? [])]);
  return [...keys].filter((key) => reviewHostId(key) === hostId);
}
export function blockReviewHost(storage: ReviewStoragePort, hostId: string) {
  const state = stateFor(storage);
  state.blockedHosts.add(hostId);
  return () => state.blockedHosts.delete(hostId);
}
export async function drainReviewHost(storage: ReviewStoragePort, hostId: string) {
  await Promise.all(
    [...stateFor(storage).tails]
      .filter(([key]) => reviewHostId(key) === hostId)
      .map(([, tail]) => tail.catch(() => {})),
  );
}
export async function hasUnconfirmedReviewHost(storage: ReviewStoragePort, hostId: string) {
  await drainReviewHost(storage, hostId);
  for (const key of await hostKeys(storage, hostId)) {
    if (await storage.getItem(key)) return true;
  }
  return false;
}
export async function clearReviewHost(storage: ReviewStoragePort, hostId: string) {
  const state = stateFor(storage);
  state.generations.set(hostId, (state.generations.get(hostId) ?? 0) + 1);
  for (const listener of state.clearListeners.get(hostId) ?? []) listener();
  await drainReviewHost(storage, hostId);
  for (const key of await hostKeys(storage, hostId)) await storage.removeItem(key);
}

/** A persisted send is uncertain until its original receipt has been received. */
export class ReviewRequestStorage {
  readonly key: string;
  readonly hostId?: string;
  readonly #generation: number;
  constructor(
    readonly storage: ReviewStoragePort,
    scope: string,
    readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.key = `pico.mobile.review.v1:${scope}`;
    this.hostId = reviewHostId(this.key);
    const state = stateFor(storage);
    state.keys.add(this.key);
    this.#generation = this.hostId ? (state.generations.get(this.hostId) ?? 0) : 0;
  }
  get current() {
    if (!this.hostId) return true;
    const state = stateFor(this.storage);
    return (
      !state.blockedHosts.has(this.hostId) &&
      this.#generation === (state.generations.get(this.hostId) ?? 0)
    );
  }
  onClear(listener: () => void) {
    if (!this.hostId) return () => {};
    const state = stateFor(this.storage);
    let listeners = state.clearListeners.get(this.hostId);
    if (!listeners) state.clearListeners.set(this.hostId, (listeners = new Set()));
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const tails = stateFor(this.storage).tails;
    const previous = tails.get(this.key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    tails.set(this.key, result);
    const release = () => {
      if (tails.get(this.key) === result) tails.delete(this.key);
    };
    void result.then(release, release);
    return result;
  }
  load(): Promise<PendingReviewRequest | undefined> {
    return this.serialize(async () => {
      if (!this.current) return undefined;
      const request = await this.read();
      return this.current ? request : undefined;
    });
  }
  private async read(): Promise<PendingReviewRequest | undefined> {
    const raw = await this.storage.getItem(this.key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("保存的审阅操作无效");
    const request = value as Record<string, unknown>;
    if (
      typeof request.idempotencyKey !== "string" ||
      !request.idempotencyKey ||
      typeof request.runId !== "string" ||
      !request.runId ||
      typeof request.expectedFingerprint !== "string" ||
      !request.expectedFingerprint ||
      (request.decision !== "approve" && request.decision !== "request_changes") ||
      (request.message !== undefined && typeof request.message !== "string")
    )
      throw new Error("保存的审阅操作无效");
    return request as PendingReviewRequest;
  }
  save(request: PendingReviewRequest) {
    if (!this.current) return Promise.reject(new Error("这台电脑的本机数据正在清理或已清除"));
    return this.serialize(async () => {
      // A queued write may drain during cleanup; a cleared generation may never write again.
      const state = stateFor(this.storage);
      if (this.hostId && this.#generation !== (state.generations.get(this.hostId) ?? 0)) return;
      await this.storage.setItem(this.key, JSON.stringify(request));
    });
  }
  clear(idempotencyKey: string) {
    return this.serialize(async () => {
      if (this.current && (await this.read())?.idempotencyKey === idempotencyKey)
        await this.storage.removeItem(this.key);
    });
  }
}

// The platform panel injects AsyncStorage. This fallback keeps controller-only clients coherent.
const memory = new Map<string, string>();
export const memoryReviewStorage: ReviewStoragePort = {
  getItem: async (key) => memory.get(key) ?? null,
  setItem: async (key, value) => {
    memory.set(key, value);
  },
  removeItem: async (key) => {
    memory.delete(key);
  },
};
