import type { RuntimeHostComposition, RuntimeHostCompositionFactory } from "@pico/runtime-host";
import {
  createTypedRuntimeRequest,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeErrorCode,
  type RuntimeRequest,
} from "./protocol.js";
import {
  RUNTIME_HOST_BRIDGE_USAGE_GET,
  RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS,
  type PicoBridgeHandlerMap,
  type UsageGetBridgeInput,
  type UsageGetBridgeOutput,
  type WorkspaceStatusBridgeInput,
  type WorkspaceStatusBridgeOutput,
} from "./runtime-host-operations.js";

/**
 * 3-B-1 bridge composition: adapts a first slice of pico daemon query methods
 * (workspace.status / usage.get) to daemon RuntimeRequests and back over the Runtime
 * Host protocol. The bridged operations are registered dynamically in the runtime-host
 * spec registry (see runtime-host-operations.ts), so their keys are not part of the
 * static OperationKey surface — the handler map is widened through the composition's
 * DomainOperationHandlerMap via a cast, mirroring the integration tests.
 */

/**
 * Minimal service surface the bridge composition needs. DesktopRuntimeService satisfies
 * it, but so does any other control-plane implementation — tests inject fakes here, and
 * 3-B-3 will inject the service assembled by createProductionLocalDaemonHost.
 */
export interface RuntimeHostBridgeService {
  handle(request: RuntimeRequest): Promise<JsonValue>;
  close?(): Promise<void> | void;
}

export interface RuntimeHostCompositionOptions {
  /** Assembled production control-plane service (DesktopRuntimeService). */
  readonly service: RuntimeHostBridgeService;
}

type BridgeErrorCode =
  | "operation_unavailable"
  | "invalid_request"
  | "not_found"
  | "operation_conflict"
  | "capability_unavailable"
  | "internal_failure";

/** Maps daemon protocol error codes onto the Runtime Host operation error space. */
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

function bridgeFailure(error: unknown): {
  ok: false;
  error: { code: BridgeErrorCode; message: string };
} {
  if (error instanceof RuntimeProtocolError) {
    return {
      ok: false,
      error: { code: mapRuntimeErrorCode(error.code), message: error.message },
    };
  }
  return {
    ok: false,
    error: {
      code: "internal_failure",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

type BridgeHandlerOutcome<Output> =
  | { ok: true; result: Output }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

export function createRuntimeHostComposition(
  options: RuntimeHostCompositionOptions,
): RuntimeHostComposition {
  const { service } = options;

  const workspaceStatusHandler = async (
    input: WorkspaceStatusBridgeInput,
  ): Promise<BridgeHandlerOutcome<WorkspaceStatusBridgeOutput>> => {
    try {
      const request = createTypedRuntimeRequest("workspace.status", {
        workspacePath: input.workspacePath,
      });
      const result = await service.handle(request);
      return { ok: true, result: result as unknown as WorkspaceStatusBridgeOutput };
    } catch (error) {
      return bridgeFailure(error);
    }
  };

  const usageGetHandler = async (
    input: UsageGetBridgeInput,
  ): Promise<BridgeHandlerOutcome<UsageGetBridgeOutput>> => {
    try {
      const request = createTypedRuntimeRequest("usage.get", {
        workspacePath: input.workspacePath,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
      });
      const result = await service.handle(request);
      return { ok: true, result: result as unknown as UsageGetBridgeOutput };
    } catch (error) {
      return bridgeFailure(error);
    }
  };

  // 动态注册的操作不在静态 DomainOperationHandlerMap 键集中，按运行时键提供 handler。
  // satisfies PicoBridgeHandlerMap 让 handler 与 spec 的输入/输出/错误码编译期对齐。
  const handlers = {
    [RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS]: workspaceStatusHandler,
    [RUNTIME_HOST_BRIDGE_USAGE_GET]: usageGetHandler,
  } satisfies PicoBridgeHandlerMap;

  return {
    handlers: handlers as unknown as RuntimeHostComposition["handlers"],
    beginDrain() {},
    async recover() {},
    async close() {
      await service.close?.();
    },
  };
}

/**
 * Wraps createRuntimeHostComposition in the kernel's factory signature. The kernel
 * context (owner/hostEpoch/residency/drain) is not yet consumed by the query-only
 * bridge; 3-B-3 will use it when run lifecycle operations acquire residency.
 */
export function createRuntimeHostCompositionFactory(
  options: RuntimeHostCompositionOptions,
): RuntimeHostCompositionFactory {
  return async () => createRuntimeHostComposition(options);
}
