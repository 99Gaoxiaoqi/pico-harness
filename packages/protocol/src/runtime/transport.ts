// Authentication, request/response envelopes, and length-prefixed JSON framing.
import {
  LOCAL_RUNTIME_AUTH_VERSION,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_FRAME_BYTES,
  isJsonObject,
  isJsonValue,
} from "./base.js";
import type { JsonValue } from "./base.js";
import { isRuntimeErrorCode, protocolError } from "./errors.js";
import type { RuntimeErrorCode } from "./errors.js";
import { isRuntimeMethod, parseRuntimeParams } from "./methods.js";
import type { RuntimeMethod, RuntimeParams } from "./methods.js";
import { isRuntimeNotification } from "./notifications.js";
import type { RuntimeNotification } from "./notifications.js";

export type RuntimeRequest<Method extends RuntimeMethod = RuntimeMethod> =
  Method extends RuntimeMethod
    ? {
        kind: "request";
        protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
        requestId: string;
        method: Method;
        params: RuntimeParams<Method>;
      }
    : never;

export interface RuntimeSuccessResponse<Result extends JsonValue = JsonValue> {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: Result;
}

export interface RuntimeErrorResponse {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: { code: RuntimeErrorCode; message: string };
}

export interface RuntimeNotificationMessage {
  kind: "event";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  event: RuntimeNotification;
}

export interface RuntimeAuthRequest {
  kind: "auth";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  authVersion: typeof LOCAL_RUNTIME_AUTH_VERSION;
  token: string;
}

export interface RuntimeAuthResult {
  kind: "auth_result";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  authVersion: typeof LOCAL_RUNTIME_AUTH_VERSION;
  ok: boolean;
}

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

export type RuntimeMessage =
  | RuntimeAuthRequest
  | RuntimeAuthResult
  | RuntimeRequest
  | RuntimeResponse
  | RuntimeNotificationMessage;

export function createRuntimeAuthRequest(token: string): RuntimeAuthRequest {
  return {
    kind: "auth",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    authVersion: LOCAL_RUNTIME_AUTH_VERSION,
    token,
  };
}

export function createRuntimeAuthResult(ok: boolean): RuntimeAuthResult {
  return {
    kind: "auth_result",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    authVersion: LOCAL_RUNTIME_AUTH_VERSION,
    ok,
  };
}

export function createRuntimeRequest(method: RuntimeMethod, params: JsonValue): RuntimeRequest {
  const checkedParams = parseRuntimeParams(method, params);
  return {
    kind: "request",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId: globalThis.crypto.randomUUID(),
    method,
    params: checkedParams,
  } as RuntimeRequest;
}

export function createTypedRuntimeRequest<Method extends RuntimeMethod>(
  method: Method,
  params: RuntimeParams<Method>,
): RuntimeRequest<Method> {
  return createRuntimeRequest(method, params) as RuntimeRequest<Method>;
}

export function createRuntimeError(
  requestId: string,
  code: RuntimeErrorCode,
  message: string,
): RuntimeErrorResponse {
  return {
    kind: "response",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

export function encodeRuntimeFrame(message: RuntimeMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_RUNTIME_FRAME_BYTES) {
    throw protocolError("FRAME_TOO_LARGE", `IPC 消息超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
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
    this.pending =
      this.pending.byteLength === 0
        ? detachedBufferCopy(chunk)
        : Buffer.concat([this.pending, chunk]);
    const messages: RuntimeMessage[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > MAX_RUNTIME_FRAME_BYTES) {
        throw protocolError("FRAME_TOO_LARGE", `IPC 帧超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
      }
      if (this.pending.byteLength < 4 + length) break;
      const raw = this.pending.subarray(4, 4 + length).toString("utf8");
      const remainder = this.pending.subarray(4 + length);
      // A zero-length subarray still retains the consumed frame's backing memory. Credential
      // writes are intentionally write-only, so release consumed bytes immediately and copy
      // only an actual fragmented remainder into an independent allocation.
      this.pending = remainder.byteLength === 0 ? Buffer.alloc(0) : detachedBufferCopy(remainder);
      messages.push(parseRuntimeMessage(raw));
    }
    return messages;
  }
}

function detachedBufferCopy(source: Buffer): Buffer<ArrayBuffer> {
  const copy = Buffer.alloc(source.byteLength);
  source.copy(copy);
  return copy;
}

export function parseRuntimeMessage(raw: string): RuntimeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw protocolError("INVALID_JSON", "IPC 帧不是有效 JSON");
  }
  if (!isJsonObject(parsed)) throw protocolError("INVALID_KIND", "IPC 消息必须是对象");
  if (parsed.protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
    throw protocolError("VERSION_MISMATCH", "IPC 协议版本不兼容");
  }
  if (parsed.kind === "request") return assertRequest(parsed);
  if (parsed.kind === "response") return assertResponse(parsed);
  if (parsed.kind === "event") return assertNotificationMessage(parsed);
  if (parsed.kind === "auth") return assertAuthRequest(parsed);
  if (parsed.kind === "auth_result") return assertAuthResult(parsed);
  throw protocolError("INVALID_KIND", "IPC 消息 kind 无效");
}

function assertAuthRequest(value: Record<string, unknown>): RuntimeAuthRequest {
  if (
    value.authVersion !== LOCAL_RUNTIME_AUTH_VERSION ||
    typeof value.token !== "string" ||
    value.token.length < 43
  ) {
    throw protocolError("INVALID_AUTH", "IPC auth 消息无效");
  }
  return value as unknown as RuntimeAuthRequest;
}

function assertAuthResult(value: Record<string, unknown>): RuntimeAuthResult {
  if (value.authVersion !== LOCAL_RUNTIME_AUTH_VERSION || typeof value.ok !== "boolean") {
    throw protocolError("INVALID_AUTH", "IPC auth_result 消息无效");
  }
  return value as unknown as RuntimeAuthResult;
}

function assertRequest(value: Record<string, unknown>): RuntimeRequest {
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    throw protocolError("INVALID_REQUEST", "IPC requestId 无效");
  }
  if (typeof value.method !== "string" || !isRuntimeMethod(value.method)) {
    throw protocolError("METHOD_NOT_FOUND", "IPC request method 无效");
  }
  if (!isJsonObject(value.params) || !isJsonValue(value.params)) {
    throw protocolError("INVALID_PARAMS", "IPC request params 必须是 JSON 对象");
  }
  return value as unknown as RuntimeRequest;
}

function assertResponse(value: Record<string, unknown>): RuntimeResponse {
  if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
    throw protocolError("INVALID_REQUEST", "IPC response 无效");
  }
  if (value.ok && isJsonValue(value.result)) return value as unknown as RuntimeSuccessResponse;
  if (
    !value.ok &&
    isJsonObject(value.error) &&
    isRuntimeErrorCode(value.error.code) &&
    typeof value.error.message === "string"
  ) {
    return value as unknown as RuntimeErrorResponse;
  }
  throw protocolError("INVALID_REQUEST", "IPC response 内容无效");
}

function assertNotificationMessage(value: Record<string, unknown>): RuntimeNotificationMessage {
  if (!isJsonObject(value.event) || !isRuntimeNotification(value.event)) {
    throw protocolError("INVALID_REQUEST", "IPC event 无效");
  }
  return value as unknown as RuntimeNotificationMessage;
}
