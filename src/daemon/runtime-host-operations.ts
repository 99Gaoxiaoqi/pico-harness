import {
  defineOperation,
  invalidProtocolFrame,
  registerHostOperationSpecs,
  requireEncodedByteLimit,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  type AnyOperationSpec,
  type HostOperationErrorCode,
  type OperationSpec,
} from "@pico/runtime-host";
import {
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  type RuntimeErrorCode,
} from "@pico/protocol";

/**
 * 3-B-1 runtime bridge operation specs: the first pico daemon methods carried over
 * the Runtime Host wire protocol. They are registered into the runtime-host dynamic
 * spec registry at process startup (see ensurePicoRuntimeHostOperationsRegistered),
 * keeping the mechanism layer pico-agnostic while still giving both the client and
 * the server a strict decodeInput/decodeOutput contract for each bridged method.
 *
 * Field-level validation is delegated to @pico/protocol's existing strict rules
 * (parseStrictRuntimeParams / parseDesktopRuntimeResult) so each method has a single
 * source of truth instead of a second hand-written validator. Only structural checks
 * the protocol layer does not cover (e.g. usage.get result shape, byte bounds) live here.
 *
 * Error codes declared per spec are the Runtime Host subset that the daemon's
 * RuntimeProtocolError codes map onto (see runtime-host-composition.ts).
 */

export const RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS = "workspace.status";
export const RUNTIME_HOST_BRIDGE_USAGE_GET = "usage.get";
export const RUNTIME_HOST_BRIDGE_EVENTS_SUBSCRIBE = "events.subscribe";
export const RUNTIME_HOST_BRIDGE_EVENTS_REPLAY = "events.replay";
/**
 * Generic transition operation (3-B-3): carries any daemon RUNTIME_METHOD over
 * the Runtime Host wire so clients can migrate transport wholesale before each
 * method gets its own strictly-decoded spec. Input validation stays single-source
 * (parseStrictRuntimeParams rejects unknown methods and unknown keys); the result
 * passes through with a frame-budget guard — per-method strict decodeOutput is
 * the 3-B-4+ hardening that retires this op method by method.
 */
export const RUNTIME_HOST_BRIDGE_RUNTIME_REQUEST = "runtime.request";

/**
 * Kernel-level daemon shutdown (3-B-4): lets a local client ask the resident
 * daemon candidate to drain and close gracefully (composition.close → cron
 * fence chain → guard-lock release → residency release). Not a daemon
 * RuntimeMethod — the daemon cannot stop itself through its own control plane;
 * the handler runs in the candidate composition and triggers the kernel's
 * requestDrain() (the same path SIGTERM takes).
 */
export const RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN = "runtime.shutdown";

const BRIDGE_ERRORS = [
  "operation_unavailable",
  "invalid_request",
  "not_found",
  "operation_conflict",
  "capability_unavailable",
  "internal_failure",
] as const;

const USAGE_RESULT_MAX_BYTES = 64 * 1024;

/**
 * runtime.request 结果预算：帧上限减响应信封预留（对齐 daemon replay 的 64KB 预留惯例）。
 * 导出供 daemon 侧大结果生产者（如 session.transcript 分页）对齐同一预算——
 * 结果必须装入 kernel 桥的 decodeOutput 字节闸门，否则 960KB–1MiB 区间成死区
 * （旧 socket 1MiB 合法的结果在 kernel 传输上硬失败，P1-3）。
 */
export const RUNTIME_REQUEST_RESULT_MAX_BYTES = RUNTIME_HOST_MAX_FRAME_BYTES - 64 * 1024;

/** Runtime Host 桥接错误码全集（daemon 协议错误码映射的目标空间）。 */
export type BridgeErrorCode =
  | "operation_unavailable"
  | "invalid_request"
  | "not_found"
  | "operation_conflict"
  | "capability_unavailable"
  | "internal_failure";

/**
 * Maps daemon protocol error codes onto the Runtime Host operation error space.
 * Shared by the query bridge composition and the event bridge so both carry the
 * same error semantics (e.g. INVALID_PARAMS → invalid_request doubles as the
 * client-facing "cursor expired, reset and replay" signal).
 */
export function mapRuntimeErrorCode(code: RuntimeErrorCode): BridgeErrorCode {
  switch (code) {
    case RUNTIME_ERROR_CODES.INVALID_PARAMS:
    case RUNTIME_ERROR_CODES.INVALID_REQUEST:
    case RUNTIME_ERROR_CODES.INVALID_JSON:
    case RUNTIME_ERROR_CODES.LEGACY_INVALID_MESSAGE:
    case RUNTIME_ERROR_CODES.LEGACY_INVALID_REQUEST:
      return "invalid_request";
    case RUNTIME_ERROR_CODES.NOT_FOUND:
      return "not_found";
    case RUNTIME_ERROR_CODES.CONFLICT:
      return "operation_conflict";
    case RUNTIME_ERROR_CODES.FORBIDDEN:
      return "capability_unavailable";
    case RUNTIME_ERROR_CODES.METHOD_NOT_FOUND:
      return "operation_unavailable";
    default:
      return "internal_failure";
  }
}

export interface WorkspaceStatusBridgeInput {
  workspacePath: string;
}

export interface WorkspaceStatusBridgeOutput {
  workspacePath: string;
  registered: boolean;
  schedulerStatus: "unknown";
  mode: "folder" | "git";
  branch: string;
  capabilities: {
    foregroundRuns: boolean;
    fileHistory: boolean;
    isolatedWorktrees: boolean;
    branchMerge: boolean;
  };
  eventLog?: {
    logicalBytes: number;
    hardLimitBytes: number;
    lowWatermarkBytes: number;
    status: "within_limit" | "retention_required" | "quota_blocked";
    canStartNewWork: boolean;
    canWriteClosure: boolean;
    plannedSessionCount: number;
    estimatedLogicalBytesReclaimed: number;
  } | null;
}

export interface UsageGetBridgeInput {
  workspacePath: string;
  sessionId?: string;
  from?: number;
  to?: number;
}

export interface UsageGetBridgeOutput {
  usage: Record<string, unknown>;
}

/** Serialized RuntimeNotification wire shape（serializeRuntimeNotification 的产物）。 */
export interface BridgeNotification {
  protocolVersion: number;
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
  payload: unknown;
}

export interface BridgeNotificationPage {
  events: BridgeNotification[];
  hasMore: boolean;
  nextAfterEventId?: string;
  highWatermarkEventId?: string;
}

export interface EventsSubscribeBridgeInput {
  workspacePath: string;
  afterEventId?: string;
}

export interface EventsSubscribeBridgeOutput extends BridgeNotificationPage {
  subscribed: true;
}

export interface EventsReplayBridgeInput {
  workspacePath: string;
  afterEventId?: string;
  highWatermarkEventId?: string;
  limit?: number;
}

export type EventsReplayBridgeOutput = BridgeNotificationPage;

export interface RuntimeRequestBridgeInput {
  /** Any daemon RuntimeMethod; validated single-source via parseStrictRuntimeParams. */
  method: string;
  params?: Record<string, unknown>;
}

/** Passthrough result of a daemon method call, frame-budget guarded. */
export interface RuntimeRequestBridgeOutput {
  result: unknown;
}

export const PICO_RUNTIME_HOST_OPERATION_SPECS = {
  [RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS]: defineOperation({
    mode: "query",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): WorkspaceStatusBridgeInput =>
      parseStrictRuntimeParams("workspace.status", value),
    decodeOutput: (value): WorkspaceStatusBridgeOutput =>
      parseDesktopRuntimeResult("workspace.status", value),
  }),
  [RUNTIME_HOST_BRIDGE_USAGE_GET]: defineOperation({
    mode: "query",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): UsageGetBridgeInput => parseStrictRuntimeParams("usage.get", value),
    decodeOutput: (value): UsageGetBridgeOutput => {
      // The protocol layer has no result rule for usage.get; validate the shape here.
      requireEncodedByteLimit(value, "usage.get result", USAGE_RESULT_MAX_BYTES);
      const result = parseDesktopRuntimeResult("usage.get", value) as { usage?: unknown };
      if (
        !result ||
        typeof result.usage !== "object" ||
        result.usage === null ||
        Array.isArray(result.usage)
      ) {
        throw invalidProtocolFrame("Invalid usage.get result");
      }
      return { usage: result.usage as Record<string, unknown> };
    },
  }),
  [RUNTIME_HOST_BRIDGE_RUNTIME_REQUEST]: defineOperation({
    mode: "query",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): RuntimeRequestBridgeInput => {
      // Method-specific validation is single-sourced in the handler via
      // parseStrictRuntimeParams (it rejects unknown methods); here only the
      // generic envelope shape is checked.
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw invalidProtocolFrame("runtime.request input must be an object");
      }
      const input = value as { method?: unknown; params?: unknown };
      if (typeof input.method !== "string" || input.method.length === 0) {
        throw invalidProtocolFrame("runtime.request method must be a non-empty string");
      }
      if (
        input.params !== undefined &&
        (typeof input.params !== "object" || input.params === null || Array.isArray(input.params))
      ) {
        throw invalidProtocolFrame("runtime.request params must be an object when present");
      }
      return {
        method: input.method,
        ...(input.params === undefined ? {} : { params: input.params as Record<string, unknown> }),
      };
    },
    decodeOutput: (value): RuntimeRequestBridgeOutput => {
      // Passthrough guard: the result must fit a response frame (envelope reserve
      // included) so framing cannot fail after the handler already committed.
      requireEncodedByteLimit(
        (value as { result?: unknown })?.result,
        "runtime.request result",
        RUNTIME_REQUEST_RESULT_MAX_BYTES,
      );
      return value as RuntimeRequestBridgeOutput;
    },
  }),
} satisfies Record<string, AnyOperationSpec>;

/**
 * Event-protocol bridge specs (3-B-2). Kept in a separate map so their
 * registration is opt-in: a composition that does not provide an event source
 * must not have these keys in the registry (composeOperationHandlers requires
 * every registered key to have a handler). Callers wiring an event source use
 * ensurePicoRuntimeHostEventOperationsRegistered + the events composition.
 */
export const PICO_RUNTIME_HOST_EVENT_OPERATION_SPECS = {
  [RUNTIME_HOST_BRIDGE_EVENTS_SUBSCRIBE]: defineOperation({
    mode: "control",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): EventsSubscribeBridgeInput =>
      parseStrictRuntimeParams("events.subscribe", value),
    decodeOutput: (value): EventsSubscribeBridgeOutput =>
      parseDesktopRuntimeResult("events.subscribe", value) as EventsSubscribeBridgeOutput,
  }),
  [RUNTIME_HOST_BRIDGE_EVENTS_REPLAY]: defineOperation({
    mode: "query",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): EventsReplayBridgeInput =>
      parseStrictRuntimeParams("events.replay", value),
    decodeOutput: (value): EventsReplayBridgeOutput =>
      parseDesktopRuntimeResult("events.replay", value) as EventsReplayBridgeOutput,
  }),
} satisfies Record<string, AnyOperationSpec>;

export const PICO_RUNTIME_HOST_SHUTDOWN_OPERATION_SPEC = {
  [RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN]: defineOperation({
    mode: "query",
    availability: "ready",
    errors: BRIDGE_ERRORS,
    decodeInput: (value): Record<string, never> => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        throw invalidProtocolFrame("runtime.shutdown input must be an empty object");
      }
      return {};
    },
    decodeOutput: (value): Record<string, never> => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 0
      ) {
        throw invalidProtocolFrame("runtime.shutdown result must be an empty object");
      }
      return {};
    },
  }),
} satisfies Record<string, AnyOperationSpec>;

// 以 AnyOperationSpec（而非具体 spec map 的键联合）为推断基类：Base 与 Events
// 两组 spec map 的具体 Input/Output 各不相同，统一的泛型基类让同一组 Infer*
// 条件类型可复用于两个 map。
type BridgeSpec = AnyOperationSpec;
type InferBridgeInput<S extends BridgeSpec> =
  S extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferBridgeOutput<S extends BridgeSpec> =
  S extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferBridgeError<S extends BridgeSpec> =
  S extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

/**
 * Per-request capability surface the kernel passes to bridged handlers. A
 * structural subset of the runtime-host ConnectionContext so the bridge stays
 * decoupled from kernel types; optional because unit harnesses may call
 * handlers directly without one. events.subscribe uses pushEvent to register
 * the connection's live push path.
 */
export interface BridgeOperationContext {
  connectionId: string;
  pushEvent?(event: Record<string, unknown>): Promise<void>;
}

/**
 * Compile-time contract between bridge operation specs and their composition
 * handlers: input/output types and allowed error codes are inferred from the
 * spec map, so a handler that disagrees with its spec (wrong input shape, wrong
 * result, undeclared error code) fails typecheck instead of surfacing at
 * runtime as internal_failure. The context parameter is optional so query
 * handlers that ignore it stay assignable.
 */
export type BridgeHandlerMap<Specs extends Record<string, BridgeSpec>> = {
  [K in keyof Specs]: (
    input: InferBridgeInput<Specs[K]>,
    context?: BridgeOperationContext,
  ) => Promise<
    | { ok: true; result: InferBridgeOutput<Specs[K]> }
    | { ok: false; error: { code: InferBridgeError<Specs[K]>; message: string } }
  >;
};

export type PicoBridgeHandlerMap = BridgeHandlerMap<typeof PICO_RUNTIME_HOST_OPERATION_SPECS>;
export type PicoBridgeEventHandlerMap = BridgeHandlerMap<
  typeof PICO_RUNTIME_HOST_EVENT_OPERATION_SPECS
>;

let picoRuntimeHostOperationsRegistered = false;

/**
 * Idempotently registers the pico bridge operation specs. Node starts each daemon /
 * test process fresh, and the registry is process-global, so calling this once at
 * startup (before any kernel start or client connect) is sufficient.
 */
export function ensurePicoRuntimeHostOperationsRegistered(): void {
  if (picoRuntimeHostOperationsRegistered) return;
  picoRuntimeHostOperationsRegistered = true;
  registerHostOperationSpecs(PICO_RUNTIME_HOST_OPERATION_SPECS);
}

let picoRuntimeHostEventOperationsRegistered = false;

/**
 * Idempotently registers the events.subscribe / events.replay bridge specs. Only
 * call this when the composition is wired with an event source: a registered key
 * without a handler fails kernel start (composeOperationHandlers completeness).
 */
export function ensurePicoRuntimeHostEventOperationsRegistered(): void {
  if (picoRuntimeHostEventOperationsRegistered) return;
  picoRuntimeHostEventOperationsRegistered = true;
  registerHostOperationSpecs(PICO_RUNTIME_HOST_EVENT_OPERATION_SPECS);
}

let picoRuntimeHostShutdownOperationRegistered = false;

/**
 * Idempotently registers the runtime.shutdown spec. Only call this when the
 * composition actually provides the shutdown handler (the pico daemon candidate
 * does; plain bridge compositions do not): a registered key without a handler
 * fails kernel start (composeOperationHandlers completeness). The client side
 * registers it too so requestRegistered can decode the request locally.
 */
export function ensurePicoRuntimeHostShutdownOperationRegistered(): void {
  if (picoRuntimeHostShutdownOperationRegistered) return;
  picoRuntimeHostShutdownOperationRegistered = true;
  registerHostOperationSpecs(PICO_RUNTIME_HOST_SHUTDOWN_OPERATION_SPEC);
}
