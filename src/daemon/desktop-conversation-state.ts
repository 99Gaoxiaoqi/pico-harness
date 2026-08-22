import { resolve } from "node:path";
import type { JsonObject, RuntimeUserInput } from "./protocol.js";

const DESKTOP_CONVERSATION_STATE_VERSION = 2 as const;
export const MAX_IDEMPOTENCY_RECORDS = 500;
export const MAX_FIRST_SEND_CLAIMS = 500;
export const FIRST_SEND_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface DesktopQueuedInput {
  readonly queueId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly input: RuntimeUserInput;
  readonly createdAt: number;
}

export interface DesktopIdempotencyRecord {
  readonly workspacePath: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly result: JsonObject;
  readonly createdAt: number;
}

export interface DesktopFirstSendClaim {
  readonly workspacePath: string;
  readonly key: string;
  readonly sessionId: string;
  readonly requestFingerprint: string;
  readonly createdAt: number;
}

export interface DesktopConversationStateFile {
  readonly version: typeof DESKTOP_CONVERSATION_STATE_VERSION;
  readonly queuedInputs: readonly DesktopQueuedInput[];
  readonly idempotency: readonly DesktopIdempotencyRecord[];
  readonly firstSendClaims: readonly DesktopFirstSendClaim[];
}

/**
 * 对外契约(ADR 28):JSON 与 SQLite 两个实现共同满足的形状,调用方
 * (DesktopRuntimeService)只依赖本接口。`removeQueued` 携带 workspacePath:
 * SQLite 实现按 workspace 库分片,queueId 只有在 workspace 上下文内才可定位。
 */
export interface DesktopConversationStateStoreLike {
  listQueued(workspacePath: string, sessionId: string): Promise<DesktopQueuedInput[]>;
  enqueue(
    workspacePath: string,
    sessionId: string,
    input: RuntimeUserInput,
  ): Promise<DesktopQueuedInput>;
  removeQueued(workspacePath: string, queueId: string): Promise<void>;
  clearQueued(workspacePath: string, sessionId: string): Promise<void>;
  getIdempotent(
    workspacePath: string,
    key: string,
  ): Promise<Pick<DesktopIdempotencyRecord, "requestFingerprint" | "result"> | undefined>;
  getFirstSendClaim(workspacePath: string, key: string): Promise<DesktopFirstSendClaim | undefined>;
  claimFirstSend(
    workspacePath: string,
    key: string,
    sessionId: string,
    requestFingerprint: string,
  ): Promise<DesktopFirstSendClaim>;
  rememberIdempotent(
    workspacePath: string,
    key: string,
    requestFingerprint: string,
    result: JsonObject,
  ): Promise<void>;
}

/** Legacy JSON 文件的 fail-closed 解析(供 SQLite 一次性迁移复用)。 */
export function parseDesktopConversationStateFile(
  value: unknown,
  filePath: string,
): DesktopConversationStateFile {
  if (
    !isRecord(value) ||
    value["version"] !== DESKTOP_CONVERSATION_STATE_VERSION ||
    !Array.isArray(value["queuedInputs"]) ||
    !Array.isArray(value["idempotency"]) ||
    !Array.isArray(value["firstSendClaims"])
  ) {
    throw new Error(`Desktop conversation state format is invalid: ${filePath}`);
  }
  return {
    version: DESKTOP_CONVERSATION_STATE_VERSION,
    queuedInputs: value["queuedInputs"].map((item) => parseQueued(item, filePath)),
    idempotency: value["idempotency"].map((item) => parseIdempotency(item, filePath)),
    firstSendClaims: value["firstSendClaims"].map((item) => parseFirstSendClaim(item, filePath)),
  };
}

function parseQueued(value: unknown, filePath: string): DesktopQueuedInput {
  if (
    !isRecord(value) ||
    typeof value["queueId"] !== "string" ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw new Error(`Desktop conversation queue contains an invalid entry: ${filePath}`);
  }
  return {
    queueId: requireNonEmpty(value["queueId"], "queueId"),
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    sessionId: requireNonEmpty(value["sessionId"], "sessionId"),
    input: parseStoredInput(value, filePath),
    createdAt: value["createdAt"],
  };
}

function parseStoredInput(value: Record<string, unknown>, filePath: string): RuntimeUserInput {
  if (!isRecord(value["input"])) {
    throw new Error(`Desktop conversation queue is missing canonical input: ${filePath}`);
  }
  const candidate = value["input"];
  const kind = candidate["kind"];
  if (kind === "text" && typeof candidate["text"] === "string") {
    return {
      kind,
      text: requireNonEmpty(candidate["text"], "input.text"),
    };
  }
  if (kind === "skill" && typeof candidate["name"] === "string") {
    const args = candidate["args"];
    if (args !== undefined && typeof args !== "string") {
      throw new Error(`Desktop conversation queue contains an invalid skill input: ${filePath}`);
    }
    return {
      kind,
      name: requireNonEmpty(candidate["name"], "input.name"),
      ...(typeof args === "string" ? { args } : {}),
    };
  }
  if (
    kind === "agent" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["task"] === "string"
  ) {
    return {
      kind,
      name: requireNonEmpty(candidate["name"], "input.name"),
      task: requireNonEmpty(candidate["task"], "input.task"),
    };
  }
  throw new Error(`Desktop conversation queue contains an invalid input: ${filePath}`);
}

/** 已存储队列 input 的 fail-closed 形状校验(SQLite 实现读回时复用)。 */
export function parseDesktopQueuedInputRecord(value: unknown): RuntimeUserInput {
  if (!isRecord(value)) {
    throw new Error("Desktop conversation queue row contains an invalid input payload");
  }
  return parseStoredInput({ input: value }, "desktop_input_queue");
}

function parseIdempotency(value: unknown, filePath: string): DesktopIdempotencyRecord {
  if (
    !isRecord(value) ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["key"] !== "string" ||
    typeof value["requestFingerprint"] !== "string" ||
    !isRecord(value["result"]) ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw new Error(`Desktop conversation idempotency contains an invalid entry: ${filePath}`);
  }
  return {
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    key: requireNonEmpty(value["key"], "idempotencyKey"),
    requestFingerprint: requireNonEmpty(value["requestFingerprint"], "requestFingerprint"),
    result: value["result"] as JsonObject,
    createdAt: value["createdAt"],
  };
}

function parseFirstSendClaim(value: unknown, filePath: string): DesktopFirstSendClaim {
  if (
    !isRecord(value) ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["key"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["requestFingerprint"] !== "string" ||
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"])
  ) {
    throw new Error(`Desktop first-send claim contains an invalid entry: ${filePath}`);
  }
  return {
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    key: requireNonEmpty(value["key"], "idempotencyKey"),
    sessionId: requireNonEmpty(value["sessionId"], "sessionId"),
    requestFingerprint: requireNonEmpty(value["requestFingerprint"], "requestFingerprint"),
    createdAt: value["createdAt"],
  };
}

export function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(requireNonEmpty(workspacePath, "workspacePath")).normalize("NFC");
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
