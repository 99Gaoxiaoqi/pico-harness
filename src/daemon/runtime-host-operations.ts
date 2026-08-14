import {
  defineOperation,
  invalidProtocolFrame,
  registerHostOperationSpecs,
  requireEncodedByteLimit,
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

const BRIDGE_ERRORS = [
  "operation_unavailable",
  "invalid_request",
  "not_found",
  "operation_conflict",
  "capability_unavailable",
  "internal_failure",
] as const;

const USAGE_RESULT_MAX_BYTES = 64 * 1024;

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

export interface EventsReplayBridgeOutput extends BridgeNotificationPage {}

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

// 以 AnyOperationSpec（而非具体 spec map 的键联合）为推断基类：Base 与 Events
// 两组 spec map 的具体 Input/Output 各不相同，统一的泛型基类让同一组 Infer*
// 条件类型可复用于两个 map。
type BridgeSpec = AnyOperationSpec;
type InferBridgeInput<S extends BridgeSpec> = S extends OperationSpec<
  infer Input,
  unknown,
  HostOperationErrorCode
>
  ? Input
  : never;
type InferBridgeOutput<S extends BridgeSpec> = S extends OperationSpec<
  unknown,
  infer Output,
  HostOperationErrorCode
>
  ? Output
  : never;
type InferBridgeError<S extends BridgeSpec> = S extends OperationSpec<
  unknown,
  unknown,
  infer ErrorCode
>
  ? ErrorCode
  : never;

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
