import { randomUUID } from "node:crypto";

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;

export type JsonScalar = boolean | null | number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

export interface RuntimeEvent {
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  eventId: string;
  topic: string;
  scope: {
    workspacePath: string;
    sessionId?: string;
    runId?: string;
    jobId?: string;
  };
  resourceVersion: number;
  at: number;
  payload: JsonValue;
}

export interface RuntimeRequest {
  kind: "request";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  method: RuntimeMethod;
  params: JsonValue;
}

export interface RuntimeSuccessResponse {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: JsonValue;
}

export interface RuntimeErrorResponse {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: { code: string; message: string };
}

export interface RuntimeEventMessage {
  kind: "event";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  event: RuntimeEvent;
}

export type RuntimeMessage = RuntimeRequest | RuntimeSuccessResponse | RuntimeErrorResponse | RuntimeEventMessage;
export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

export const RUNTIME_METHODS = [
  "runtime.ping",
  "run.start",
  "run.cancel",
  "run.steer",
  "workspace.register",
  "workspace.unregister",
  "jobs.list",
  "runs.list",
  "events.replay",
  "events.subscribe",
] as const;

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

export class RuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeProtocolError";
  }
}

export function createRuntimeRequest(method: RuntimeMethod, params: JsonValue): RuntimeRequest {
  return {
    kind: "request",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    params,
  };
}

export function encodeRuntimeFrame(message: RuntimeMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_RUNTIME_FRAME_BYTES) {
    throw new RuntimeProtocolError(`IPC 消息超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Stateful decoder for length-prefixed UTF-8 JSON frames. */
export class RuntimeFrameDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): RuntimeMessage[] {
    this.pending = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const messages: RuntimeMessage[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > MAX_RUNTIME_FRAME_BYTES) {
        throw new RuntimeProtocolError(`IPC 帧超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
      }
      if (this.pending.byteLength < 4 + length) break;
      const raw = this.pending.subarray(4, 4 + length).toString("utf8");
      this.pending = this.pending.subarray(4 + length);
      messages.push(parseRuntimeMessage(raw));
    }
    return messages;
  }
}

export function createRuntimeEvent(
  input: Omit<RuntimeEvent, "eventId" | "protocolVersion"> & { eventId?: string },
): RuntimeEvent {
  return {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
  };
}

/** Converts a typed event to the wire JSON shape without leaking transport casts. */
export function serializeRuntimeEvent(event: RuntimeEvent): JsonValue {
  return {
    protocolVersion: event.protocolVersion,
    eventId: event.eventId,
    topic: event.topic,
    scope: {
      workspacePath: event.scope.workspacePath,
      ...(event.scope.sessionId ? { sessionId: event.scope.sessionId } : {}),
      ...(event.scope.runId ? { runId: event.scope.runId } : {}),
      ...(event.scope.jobId ? { jobId: event.scope.jobId } : {}),
    },
    resourceVersion: event.resourceVersion,
    at: event.at,
    payload: event.payload,
  };
}

export function createRuntimeError(requestId: string, code: string, message: string): RuntimeErrorResponse {
  return {
    kind: "response",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

export function parseRuntimeMessage(raw: string): RuntimeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeProtocolError("IPC 帧不是有效 JSON");
  }
  if (!isJsonObject(parsed) || parsed.protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
    throw new RuntimeProtocolError("IPC 协议版本不兼容");
  }
  if (parsed.kind === "request") return assertRequest(parsed);
  if (parsed.kind === "response") return assertResponse(parsed);
  if (parsed.kind === "event") return assertEventMessage(parsed);
  throw new RuntimeProtocolError("IPC 消息 kind 无效");
}

function assertRequest(value: Record<string, unknown>): RuntimeRequest {
  if (
    typeof value.requestId !== "string" ||
    !RUNTIME_METHODS.includes(value.method as RuntimeMethod) ||
    !isJsonValue(value.params)
  ) {
    throw new RuntimeProtocolError("IPC request 无效");
  }
  return value as unknown as RuntimeRequest;
}

function assertResponse(value: Record<string, unknown>): RuntimeResponse {
  if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
    throw new RuntimeProtocolError("IPC response 无效");
  }
  if (value.ok && isJsonValue(value.result)) return value as unknown as RuntimeSuccessResponse;
  if (
    !value.ok &&
    isJsonObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return value as unknown as RuntimeErrorResponse;
  }
  throw new RuntimeProtocolError("IPC response 内容无效");
}

function assertEventMessage(value: Record<string, unknown>): RuntimeEventMessage {
  if (!isJsonObject(value.event) || !isRuntimeEvent(value.event)) {
    throw new RuntimeProtocolError("IPC event 无效");
  }
  return value as unknown as RuntimeEventMessage;
}

function isRuntimeEvent(value: Record<string, unknown>): boolean {
  return (
    typeof value.eventId === "string" &&
    typeof value.topic === "string" &&
    isJsonObject(value.scope) &&
    typeof value.scope.workspacePath === "string" &&
    typeof value.resourceVersion === "number" &&
    typeof value.at === "number" &&
    isJsonValue(value.payload)
  );
}

export function isJsonObject(value: JsonValue): value is JsonObject;
export function isJsonObject(value: unknown): value is Record<string, unknown>;
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}
