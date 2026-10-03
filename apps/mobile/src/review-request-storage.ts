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
  async load(): Promise<PendingReviewRequest | undefined> {
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
  async save(request: PendingReviewRequest) {
    await this.storage.setItem(this.key, JSON.stringify(request));
  }
  async clear(idempotencyKey: string) {
    if ((await this.load())?.idempotencyKey === idempotencyKey)
      await this.storage.removeItem(this.key);
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
