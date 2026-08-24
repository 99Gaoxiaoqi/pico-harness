import type { RuntimeHostComposition, RuntimeHostCompositionFactory } from "@pico/runtime-host";
import {
  createRuntimeRequest,
  createTypedRuntimeRequest,
  parseRuntimeResult,
  parseStrictRuntimeParams,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeMethod,
  type RuntimeRequest,
} from "./protocol.js";
import {
  createRuntimeHostEventBridge,
  type RuntimeHostEventBridge,
  type RuntimeHostEventSource,
} from "./runtime-host-events.js";
import { createRuntimeHostSessionContinuityBridge } from "./runtime-host-session-continuity.js";
import type { SessionSubscriptionRegistry } from "./session-subscription-owner.js";
import {
  mapRuntimeErrorCode,
  RUNTIME_HOST_BRIDGE_RUNTIME_REQUEST,
  RUNTIME_HOST_BRIDGE_USAGE_GET,
  RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS,
  type BridgeErrorCode,
  type PicoBridgeHandlerMap,
  type RuntimeRequestBridgeInput,
  type RuntimeRequestBridgeOutput,
  type UsageGetBridgeInput,
  type UsageGetBridgeOutput,
  type WorkspaceStatusBridgeInput,
  type WorkspaceStatusBridgeOutput,
} from "./runtime-host-operations.js";

export { mapRuntimeErrorCode } from "./runtime-host-operations.js";
export type { BridgeErrorCode } from "./runtime-host-operations.js";

/**
 * 3-B-1/3-B-2 bridge composition: adapts pico daemon query methods
 * (workspace.status / usage.get) and, when an event source is provided, the
 * events.subscribe / events.replay protocol over the Runtime Host wire. The
 * bridged operations are registered dynamically in the runtime-host spec
 * registry (see runtime-host-operations.ts), so their keys are not part of the
 * static OperationKey surface — the handler map is widened through the
 * composition's DomainOperationHandlerMap via a cast, mirroring the
 * integration tests.
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
  /**
   * Event source enabling the events.* bridge (3-B-2). When present the caller
   * must also register the events specs
   * (ensurePicoRuntimeHostEventOperationsRegistered) before starting a kernel.
   */
  readonly eventSource?: RuntimeHostEventSource;
  readonly sessionContinuity?: SessionSubscriptionRegistry;
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
  const { service, eventSource, sessionContinuity } = options;

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

  const runtimeRequestHandler = async (
    input: RuntimeRequestBridgeInput,
  ): Promise<BridgeHandlerOutcome<RuntimeRequestBridgeOutput>> => {
    try {
      // 单源校验：未知方法 / 未知参数键在进 service 前被 parseStrictRuntimeParams
      // 拒绝（invalid_request），与旧 daemon 传输层行为一致。
      const method = input.method as RuntimeMethod;
      const params = parseStrictRuntimeParams(method, input.params ?? {}) as JsonValue;
      const rawResult = await service.handle(createRuntimeRequest(method, params));
      let result: RuntimeRequestBridgeOutput["result"];
      try {
        result = parseRuntimeResult(method, rawResult);
      } catch (error) {
        // 请求已经通过校验；此处的协议错误来自 daemon handler 响应，
        // 对 Host 属于 internal_failure，不能误报为客户端 invalid_request。
        throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
      }
      return { ok: true, result: { result } };
    } catch (error) {
      return bridgeFailure(error);
    }
  };

  // 动态注册的操作不在静态 DomainOperationHandlerMap 键集中，按运行时键提供 handler。
  // satisfies PicoBridgeHandlerMap 让 handler 与 spec 的输入/输出/错误码编译期对齐。
  const handlers = {
    [RUNTIME_HOST_BRIDGE_WORKSPACE_STATUS]: workspaceStatusHandler,
    [RUNTIME_HOST_BRIDGE_USAGE_GET]: usageGetHandler,
    [RUNTIME_HOST_BRIDGE_RUNTIME_REQUEST]: runtimeRequestHandler,
  } satisfies PicoBridgeHandlerMap;

  const eventBridge: RuntimeHostEventBridge | undefined = eventSource
    ? createRuntimeHostEventBridge(eventSource)
    : undefined;
  const sessionBridge = sessionContinuity
    ? createRuntimeHostSessionContinuityBridge(sessionContinuity)
    : undefined;

  const mergedHandlers = {
    ...handlers,
    ...(eventBridge?.handlers ?? {}),
    ...(sessionBridge?.handlers ?? {}),
  };

  return {
    handlers: mergedHandlers as unknown as RuntimeHostComposition["handlers"],
    releaseConnection(connectionId: string): void {
      eventBridge?.releaseConnection(connectionId);
      sessionBridge?.releaseConnection(connectionId);
    },
    beginDrain() {
      // drain 期间不再推送事件：退订所有 live 监听（既有请求照常排空）。
      eventBridge?.unsubscribeAll();
      sessionBridge?.beginDrain();
    },
    async recover() {},
    async close() {
      eventBridge?.unsubscribeAll();
      sessionBridge?.beginDrain();
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
