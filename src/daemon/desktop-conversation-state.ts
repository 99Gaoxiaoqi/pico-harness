import { resolve } from "node:path";
import type { JsonObject, RuntimeUserInput } from "./protocol.js";
import { isSafeSubagentPresetId } from "./protocol.js";

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

/** Durable pre-side-effect ownership for rewind/fork idempotency. */
export interface DesktopRewindClaim {
  readonly workspacePath: string;
  readonly key: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly createdAt: number;
}

/**
 * DesktopRuntimeService 依赖的会话状态存储契约。`removeQueued` 携带
 * workspacePath，因为 SQLite 按 workspace 分片，queueId 只在该上下文内定位。
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
  getRewindClaim(workspacePath: string, key: string): Promise<DesktopRewindClaim | undefined>;
  claimRewind(
    workspacePath: string,
    key: string,
    sourceSessionId: string,
    targetSessionId: string,
    operationId: string,
    requestFingerprint: string,
  ): Promise<DesktopRewindClaim>;
  rememberIdempotent(
    workspacePath: string,
    key: string,
    requestFingerprint: string,
    result: JsonObject,
  ): Promise<void>;
}

function parseStoredInput(value: Record<string, unknown>, filePath: string): RuntimeUserInput {
  if (!isRecord(value["input"])) {
    throw new Error(`Desktop conversation queue is missing canonical input: ${filePath}`);
  }
  const candidate = value["input"];
  const kind = candidate["kind"];
  if (kind === "text" && typeof candidate["text"] === "string") {
    const mode = candidate["orchestrationMode"];
    if (mode !== undefined && mode !== "graph" && mode !== "swarm")
      throw new Error("Invalid queued orchestrationMode");
    return {
      kind,
      text: requireNonEmpty(candidate["text"], "input.text"),
      ...(mode ? { orchestrationMode: mode } : {}),
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
    const subagentId = candidate["subagentId"];
    if (subagentId !== undefined && !isSafeSubagentPresetId(subagentId)) {
      throw new Error(`Desktop conversation queue contains an invalid subagent ID: ${filePath}`);
    }
    return {
      kind,
      name: requireNonEmpty(candidate["name"], "input.name"),
      task: requireNonEmpty(candidate["task"], "input.task"),
      ...(typeof subagentId === "string" ? { subagentId } : {}),
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
