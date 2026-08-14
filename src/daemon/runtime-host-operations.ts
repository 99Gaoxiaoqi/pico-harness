import {
  defineOperation,
  invalidProtocolFrame,
  registerHostOperationSpecs,
  requireEncodedByteLimit,
  type AnyOperationSpec,
  type HostOperationErrorCode,
  type OperationSpec,
} from "@pico/runtime-host";
import { parseDesktopRuntimeResult, parseStrictRuntimeParams } from "@pico/protocol";

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

const BRIDGE_ERRORS = [
  "operation_unavailable",
  "invalid_request",
  "not_found",
  "operation_conflict",
  "capability_unavailable",
  "internal_failure",
] as const;

const USAGE_RESULT_MAX_BYTES = 64 * 1024;

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

type BridgeSpec = (typeof PICO_RUNTIME_HOST_OPERATION_SPECS)[keyof typeof PICO_RUNTIME_HOST_OPERATION_SPECS];
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
 * Compile-time contract between a bridge operation spec and its composition handler:
 * input/output types and the allowed error codes are inferred from the spec map, so a
 * handler that disagrees with its spec (wrong input shape, wrong result, undeclared
 * error code) fails typecheck instead of surfacing at runtime as internal_failure.
 */
export type PicoBridgeHandlerMap = {
  [K in keyof typeof PICO_RUNTIME_HOST_OPERATION_SPECS]: (
    input: InferBridgeInput<(typeof PICO_RUNTIME_HOST_OPERATION_SPECS)[K]>,
  ) => Promise<
    | { ok: true; result: InferBridgeOutput<(typeof PICO_RUNTIME_HOST_OPERATION_SPECS)[K]> }
    | { ok: false; error: { code: InferBridgeError<(typeof PICO_RUNTIME_HOST_OPERATION_SPECS)[K]>; message: string } }
  >;
};

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
