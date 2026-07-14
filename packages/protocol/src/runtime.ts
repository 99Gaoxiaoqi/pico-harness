import { randomUUID } from "node:crypto";

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;
export const LOCAL_RUNTIME_AUTH_VERSION = 1;
export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;

export type JsonScalar = boolean | null | number | string;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

declare const identifierBrand: unique symbol;
export type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]?: Kind;
};
export type SessionId = Identifier<"SessionId">;
export type RunId = Identifier<"RunId">;
export type JobId = Identifier<"JobId">;
export type ApprovalId = Identifier<"ApprovalId">;
export type PromptId = Identifier<"PromptId">;
export type CheckpointId = Identifier<"CheckpointId">;

export type EmptyParams = Record<string, never>;
export type WorkspaceParams = { readonly workspacePath: string };
export type WorkspaceRegistrationParams = WorkspaceParams;

export type RuntimeRunStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded";
export type RuntimeSessionStatus = "active" | "archived";
export type RuntimeJobStatus = "idle" | "running" | "failed" | "succeeded";

export type RuntimeRun = JsonObject & {
  readonly runId: RunId;
  readonly workspacePath: string;
  readonly sessionId?: SessionId;
  readonly description: string;
  readonly status: RuntimeRunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly version: number;
};

export type RuntimeSession = JsonObject & {
  readonly sessionId: SessionId;
  readonly workspacePath: string;
  readonly title: string;
  readonly status: RuntimeSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RuntimeJob = JsonObject & {
  readonly jobId: JobId;
  readonly workspacePath: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly status: RuntimeJobStatus;
  readonly updatedAt: number;
};

export type RuntimeChange = JsonObject & {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
};

export type RuntimeMethodMap = {
  readonly "runtime.ping": {
    readonly params: JsonObject;
    readonly result: { readonly pong: true };
  };
  readonly "session.list": {
    readonly params: WorkspaceParams & { readonly includeArchived?: boolean };
    readonly result: { readonly sessions: readonly RuntimeSession[] };
  };
  readonly "session.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.create": {
    readonly params: WorkspaceParams & { readonly title?: string };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.archive": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "session.restore": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly session: RuntimeSession };
  };
  readonly "run.start": {
    readonly params: WorkspaceParams & {
      readonly prompt: string;
      readonly sessionId?: SessionId;
      readonly idempotencyKey?: string;
    };
    readonly result: RuntimeRun;
  };
  readonly "run.cancel": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly reason?: string };
    readonly result: RuntimeRun;
  };
  readonly "run.pause": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: RuntimeRun;
  };
  readonly "run.resume": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: RuntimeRun;
  };
  readonly "run.steer": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly message: string };
    readonly result: RuntimeRun;
  };
  readonly "runs.list": {
    readonly params: WorkspaceParams & { readonly sessionId?: SessionId };
    readonly result: { readonly runs: readonly RuntimeRun[] };
  };
  readonly "approval.respond": {
    readonly params: WorkspaceParams & {
      readonly approvalId: ApprovalId;
      readonly decision: "allow_once" | "allow_session" | "deny";
      readonly reason?: string;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "prompt.respond": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly answer: JsonValue;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "changes.list": {
    readonly params: WorkspaceParams & { readonly runId: RunId };
    readonly result: { readonly changes: readonly RuntimeChange[]; readonly fingerprint: string };
  };
  readonly "changes.diff": {
    readonly params: WorkspaceParams & { readonly runId: RunId; readonly path: string };
    readonly result: {
      readonly path: string;
      readonly patch: string;
      readonly truncated: boolean;
      readonly fingerprint: string;
    };
  };
  readonly "changes.review": {
    readonly params: WorkspaceParams & {
      readonly runId: RunId;
      readonly decision: "approve" | "request_changes";
      readonly message?: string;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly accepted: boolean; readonly fingerprint: string };
  };
  readonly "changes.apply": {
    readonly params: WorkspaceParams & {
      readonly runId: RunId;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly applied: boolean; readonly fingerprint: string };
  };
  readonly "rewind.list": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: {
      readonly checkpoints: readonly (JsonObject & {
        readonly checkpointId: CheckpointId;
        readonly label: string;
        readonly createdAt: number;
      })[];
    };
  };
  readonly "rewind.preview": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
    };
    readonly result: {
      readonly checkpointId: CheckpointId;
      readonly changes: readonly RuntimeChange[];
      readonly fingerprint: string;
    };
  };
  readonly "rewind.apply": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly checkpointId: CheckpointId;
      readonly expectedFingerprint: string;
    };
    readonly result: { readonly applied: boolean; readonly sessionId: SessionId };
  };
  readonly "jobs.list": {
    readonly params: WorkspaceParams;
    readonly result: { readonly jobs: readonly RuntimeJob[] };
  };
  readonly "jobs.create": {
    readonly params: WorkspaceParams & {
      readonly name: string;
      readonly prompt: string;
      readonly schedule: string;
      readonly enabled?: boolean;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.update": {
    readonly params: WorkspaceParams & {
      readonly jobId: JobId;
      readonly name?: string;
      readonly prompt?: string;
      readonly schedule?: string;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.delete": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly deleted: boolean };
  };
  readonly "jobs.setEnabled": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly enabled: boolean };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.runNow": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly job: RuntimeJob; readonly runId: RunId };
  };
  readonly "jobs.history": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly limit?: number };
    readonly result: { readonly runs: readonly RuntimeRun[] };
  };
  readonly "config.get": {
    readonly params: WorkspaceParams;
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.update": {
    readonly params: WorkspaceParams & {
      readonly patch: JsonObject;
      readonly expectedVersion: number;
    };
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.providers": {
    readonly params: WorkspaceParams;
    readonly result: { readonly providers: readonly JsonObject[] };
  };
  readonly "config.skills": {
    readonly params: WorkspaceParams;
    readonly result: { readonly skills: readonly JsonObject[] };
  };
  readonly "config.mcpServers": {
    readonly params: WorkspaceParams;
    readonly result: { readonly servers: readonly JsonObject[] };
  };
  readonly "usage.get": {
    readonly params: WorkspaceParams & {
      readonly sessionId?: SessionId;
      readonly from?: number;
      readonly to?: number;
    };
    readonly result: { readonly usage: JsonObject };
  };
  readonly "workspace.register": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: true };
  };
  readonly "workspace.unregister": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: false };
  };
  readonly "workspace.status": {
    readonly params: WorkspaceParams;
    readonly result: WorkspaceStatusResult;
  };
  readonly "workspace.list": {
    readonly params: EmptyParams;
    readonly result: { readonly workspaces: readonly WorkspaceStatusResult[] };
  };
  readonly "workspace.trust": {
    readonly params: WorkspaceParams & { readonly trusted: boolean };
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
  readonly "workspace.trustStatus": {
    readonly params: WorkspaceParams;
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
  readonly "events.replay": {
    readonly params: {
      readonly workspacePath?: string;
      readonly afterEventId?: string;
      readonly limit?: number;
    };
    readonly result: { readonly events: readonly RuntimeEvent[] };
  };
  readonly "events.subscribe": {
    readonly params: { readonly workspacePath?: string; readonly afterEventId?: string };
    readonly result: {
      readonly subscribed: true;
      readonly events: readonly RuntimeEvent[];
    };
  };
};

export const RUNTIME_METHODS = [
  "runtime.ping",
  "session.list",
  "session.get",
  "session.create",
  "session.archive",
  "session.restore",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "prompt.respond",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "config.get",
  "config.update",
  "config.providers",
  "config.skills",
  "config.mcpServers",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.list",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
  "events.subscribe",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

export type RuntimeMethod = keyof RuntimeMethodMap;
export type RuntimeMethodName = RuntimeMethod;
export type RuntimeParams<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["params"];
export type RuntimeResult<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["result"];

export type RuntimeEventMap = {
  readonly "workspace.registered": { readonly registered: true };
  readonly "workspace.unregistered": { readonly registered: false };
  readonly "workspace.trustChanged": { readonly trusted: boolean };
  readonly "session.updated": { readonly session: RuntimeSession };
  readonly "run.started": { readonly run: RuntimeRun };
  readonly "run.updated": { readonly run: RuntimeRun };
  readonly "run.finished": { readonly run: RuntimeRun };
  readonly "run.timeline": { readonly runId: RunId; readonly item: JsonObject };
  readonly "approval.requested": {
    readonly approvalId: ApprovalId;
    readonly runId: RunId;
    readonly request: JsonObject;
  };
  readonly "approval.resolved": {
    readonly approvalId: ApprovalId;
    readonly decision: "allow_once" | "allow_session" | "deny";
  };
  readonly "prompt.requested": {
    readonly promptId: PromptId;
    readonly runId: RunId;
    readonly prompt: JsonObject;
  };
  readonly "prompt.resolved": { readonly promptId: PromptId };
  readonly "changes.updated": { readonly runId: RunId; readonly fingerprint: string };
  readonly "changes.applied": { readonly runId: RunId; readonly fingerprint: string };
  readonly "rewind.completed": {
    readonly sessionId: SessionId;
    readonly checkpointId: CheckpointId;
  };
  readonly "job.updated": { readonly job: RuntimeJob };
  readonly "job.runFinished": { readonly jobId: JobId; readonly run: RuntimeRun };
  readonly "config.updated": { readonly version: number };
  readonly "usage.updated": { readonly usage: JsonObject };
  readonly "runtime.error": {
    readonly code: RuntimeErrorCode;
    readonly message: string;
    readonly recoverable: boolean;
  };
};

export type RuntimeEventTopic = keyof RuntimeEventMap;
type EventPayload<Topic extends string> = Topic extends RuntimeEventTopic
  ? RuntimeEventMap[Topic]
  : JsonValue;

export interface RuntimeEvent<Topic extends string = string> {
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  eventId: string;
  topic: Topic;
  scope: {
    workspacePath: string;
    sessionId?: SessionId;
    runId?: RunId;
    jobId?: JobId;
  };
  resourceVersion: number;
  at: number;
  payload: EventPayload<Topic>;
}

export type TypedRuntimeEvent = {
  [Topic in RuntimeEventTopic]: RuntimeEvent<Topic>;
}[RuntimeEventTopic];

export interface WorkspaceStatusResult extends JsonObject {
  workspacePath: string;
  registered: boolean;
  schedulerStatus: "unknown";
  mode: "folder" | "git";
  capabilities: {
    readonly foregroundRuns: boolean;
    readonly fileHistory: boolean;
    readonly isolatedWorktrees: boolean;
    readonly branchMerge: boolean;
  };
}

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

export const RUNTIME_ERROR_CODES = {
  INVALID_JSON: "INVALID_JSON",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  INVALID_KIND: "INVALID_KIND",
  INVALID_AUTH: "INVALID_AUTH",
  INVALID_REQUEST: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  CONFLICT: "CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  LEGACY_INVALID_MESSAGE: "invalid_message",
  LEGACY_INVALID_REQUEST: "invalid_request",
  LEGACY_RUNTIME_ERROR: "runtime_error",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

export interface RuntimeErrorResponse {
  kind: "response";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: { code: RuntimeErrorCode; message: string };
}

export interface RuntimeEventMessage {
  kind: "event";
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  event: RuntimeEvent;
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
  | RuntimeEventMessage;

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(message: string);
  constructor(code: RuntimeErrorCode, message: string);
  constructor(codeOrMessage: RuntimeErrorCode | string, message?: string) {
    super(message ?? codeOrMessage);
    this.name = "RuntimeProtocolError";
    this.code =
      message === undefined
        ? RUNTIME_ERROR_CODES.INVALID_REQUEST
        : (codeOrMessage as RuntimeErrorCode);
  }
}

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
    requestId: randomUUID(),
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

export function createRuntimeEvent<Topic extends string>(
  input: Omit<RuntimeEvent<Topic>, "eventId" | "protocolVersion"> & { eventId?: string },
): RuntimeEvent<Topic> {
  return {
    ...input,
    eventId: input.eventId ?? randomUUID(),
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
  };
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
    this.pending = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const messages: RuntimeMessage[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > MAX_RUNTIME_FRAME_BYTES) {
        throw protocolError("FRAME_TOO_LARGE", `IPC 帧超过 ${MAX_RUNTIME_FRAME_BYTES} 字节上限`);
      }
      if (this.pending.byteLength < 4 + length) break;
      const raw = this.pending.subarray(4, 4 + length).toString("utf8");
      this.pending = this.pending.subarray(4 + length);
      messages.push(parseRuntimeMessage(raw));
    }
    return messages;
  }
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
  if (parsed.kind === "event") return assertEventMessage(parsed);
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

function assertEventMessage(value: Record<string, unknown>): RuntimeEventMessage {
  if (!isJsonObject(value.event) || !isRuntimeEvent(value.event)) {
    throw protocolError("INVALID_REQUEST", "IPC event 无效");
  }
  return value as unknown as RuntimeEventMessage;
}

function isRuntimeEvent(value: Record<string, unknown>): boolean {
  const scope = value.scope;
  return (
    value.protocolVersion === LOCAL_RUNTIME_PROTOCOL_VERSION &&
    typeof value.eventId === "string" &&
    typeof value.topic === "string" &&
    isJsonObject(scope) &&
    typeof scope.workspacePath === "string" &&
    optionalStringField(scope, "sessionId") &&
    optionalStringField(scope, "runId") &&
    optionalStringField(scope, "jobId") &&
    typeof value.resourceVersion === "number" &&
    Number.isSafeInteger(value.resourceVersion) &&
    value.resourceVersion >= 0 &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    isJsonValue(value.payload)
  );
}

function optionalStringField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

export function isRuntimeMethod(value: string): value is RuntimeMethod {
  return (RUNTIME_METHODS as readonly string[]).includes(value);
}

/**
 * Validates the transport-level invariant shared by every method. Business
 * services remain responsible for validating required fields and permissions.
 */
export function parseRuntimeParams<Method extends RuntimeMethod>(
  method: Method,
  input: unknown,
): RuntimeParams<Method> {
  if (!isRuntimeMethod(method)) {
    throw protocolError("METHOD_NOT_FOUND", "IPC request method 无效");
  }
  if (!isJsonObject(input) || !isJsonValue(input)) {
    throw protocolError("INVALID_PARAMS", "IPC request params 必须是 JSON 对象");
  }
  return input as RuntimeParams<Method>;
}

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(RUNTIME_ERROR_CODES) as readonly string[]).includes(value)
  );
}

export function isJsonObject(value: JsonValue): value is JsonObject;
export function isJsonObject(value: unknown): value is Record<string, unknown>;
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function protocolError(code: RuntimeErrorCode, message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(code, message);
}
