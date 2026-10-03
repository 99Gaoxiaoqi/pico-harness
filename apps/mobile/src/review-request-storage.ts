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
}

// New panels must observe pending saves before deciding whether a new intent is allowed.
const storageTails = new WeakMap<ReviewStoragePort, Map<string, Promise<unknown>>>();

/** A persisted send is uncertain until its original receipt has been received. */
export class ReviewRequestStorage {
  readonly key: string;
  constructor(
    readonly storage: ReviewStoragePort,
    scope: string,
    readonly createId: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.key = `pico.mobile.review.v1:${scope}`;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    let tails = storageTails.get(this.storage);
    if (!tails) {
      tails = new Map();
      storageTails.set(this.storage, tails);
    }
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
    return this.serialize(() => this.read());
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
    return this.serialize(() => this.storage.setItem(this.key, JSON.stringify(request)));
  }
  clear(idempotencyKey: string) {
    return this.serialize(async () => {
      if ((await this.read())?.idempotencyKey === idempotencyKey)
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
