export type PersistedReviewOperation = {
  decision: "approve" | "request_changes";
  message?: string;
  target: {
    workspacePath: string;
    runId: string;
    fingerprint: string;
    idempotencyKey: string;
  };
};
export interface ReviewOperationStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const memory = new Map<string, string>();
const serverStorage: ReviewOperationStoragePort = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

const browserStorage: ReviewOperationStoragePort = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

export class DesktopReviewOperationStorage {
  readonly key: string;
  constructor(
    scope: string,
    readonly storage: ReviewOperationStoragePort = typeof window === "undefined"
      ? serverStorage
      : browserStorage,
  ) {
    this.key = `pico.review-operation.v1:${scope}`;
  }
  load(): PersistedReviewOperation | undefined {
    const raw = this.storage.getItem(this.key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as PersistedReviewOperation;
    if (
      !value ||
      (value.decision !== "approve" && value.decision !== "request_changes") ||
      !value.target ||
      typeof value.target.workspacePath !== "string" ||
      typeof value.target.runId !== "string" ||
      typeof value.target.fingerprint !== "string" ||
      typeof value.target.idempotencyKey !== "string" ||
      !value.target.idempotencyKey ||
      (value.message !== undefined && typeof value.message !== "string")
    )
      throw new Error("保存的审阅操作无效，请核对原对话。");
    return value;
  }
  save(operation: PersistedReviewOperation) {
    this.storage.setItem(this.key, JSON.stringify(operation));
  }
  clear(idempotencyKey: string) {
    if (this.load()?.target.idempotencyKey === idempotencyKey) this.storage.removeItem(this.key);
  }
}

/** Transport errors lack a reliable receipt; explicit admission rejections did not execute. */
export function reviewOutcomeUnknown(error: unknown) {
  const value = error as { outcome?: string; code?: string } | undefined;
  if (value?.outcome === "not_executed") return false;
  return ![
    "INVALID_PARAMS",
    "METHOD_NOT_FOUND",
    "INVALID_REQUEST",
    "CONFLICT",
    "NOT_FOUND",
    "FORBIDDEN",
    "UNAUTHORIZED_RENDERER",
  ].includes(value?.code ?? "");
}
