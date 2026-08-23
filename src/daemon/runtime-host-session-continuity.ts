import { RuntimeProtocolError, type RuntimeParams, type RuntimeResult } from "./protocol.js";
import {
  mapRuntimeErrorCode,
  RUNTIME_HOST_BRIDGE_SESSION_SUBSCRIPTION_CLOSE,
  RUNTIME_HOST_BRIDGE_SESSION_SUBSCRIPTION_OPEN,
  RUNTIME_HOST_BRIDGE_SESSION_TRANSCRIPT_ADVANCE,
  RUNTIME_HOST_BRIDGE_SESSION_TRANSCRIPT_PAGE,
  type BridgeErrorCode,
  type BridgeOperationContext,
  type PicoBridgeSessionContinuityHandlerMap,
} from "./runtime-host-operations.js";
import { SessionSubscriptionRegistry } from "./session-subscription-owner.js";

type BridgeOutcome<Output> =
  | { ok: true; result: Output }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

export interface RuntimeHostSessionContinuityBridge {
  readonly handlers: PicoBridgeSessionContinuityHandlerMap;
  releaseConnection(connectionId: string): void;
  beginDrain(): void;
}

/** Dedicated bridge because subscription.open requires connection-scoped push capabilities. */
export function createRuntimeHostSessionContinuityBridge(
  registry: SessionSubscriptionRegistry,
): RuntimeHostSessionContinuityBridge {
  const open = async (
    input: RuntimeParams<"session.subscription.open">,
    context?: BridgeOperationContext,
  ): Promise<BridgeOutcome<RuntimeResult<"session.subscription.open">>> => {
    try {
      if (
        !context?.connectionId ||
        !context.pushEvent ||
        !context.afterResponseFlushed ||
        context.hostEpoch !== registry.hostEpoch
      ) {
        throw new Error("session.subscription.open requires an accepted Runtime Host connection");
      }
      const result = await registry.open(input, {
        connectionId: context.connectionId,
        push: (frame) => context.pushEvent!(frame as unknown as Record<string, unknown>),
      });
      context.afterResponseFlushed(() => {
        registry.activate(
          input.workspacePath,
          input.sessionId,
          result.subscriptionId,
          context.connectionId,
        );
      });
      return { ok: true, result };
    } catch (error) {
      return failure(error);
    }
  };

  const close = async (
    input: RuntimeParams<"session.subscription.close">,
    context?: BridgeOperationContext,
  ): Promise<BridgeOutcome<RuntimeResult<"session.subscription.close">>> => {
    try {
      if (!context?.connectionId) {
        throw new Error("session.subscription.close requires an accepted Runtime Host connection");
      }
      return { ok: true, result: await registry.close(input, context.connectionId) };
    } catch (error) {
      return failure(error);
    }
  };

  const page = async (
    input: RuntimeParams<"session.transcript.page">,
  ): Promise<BridgeOutcome<RuntimeResult<"session.transcript.page">>> => {
    try {
      return { ok: true, result: await registry.readTranscriptPage(input) };
    } catch (error) {
      return failure(error);
    }
  };

  const advance = async (
    input: RuntimeParams<"session.transcript.advance">,
  ): Promise<BridgeOutcome<RuntimeResult<"session.transcript.advance">>> => {
    try {
      return { ok: true, result: await registry.readTranscriptAdvance(input) };
    } catch (error) {
      return failure(error);
    }
  };

  const handlers = {
    [RUNTIME_HOST_BRIDGE_SESSION_SUBSCRIPTION_OPEN]: open,
    [RUNTIME_HOST_BRIDGE_SESSION_SUBSCRIPTION_CLOSE]: close,
    [RUNTIME_HOST_BRIDGE_SESSION_TRANSCRIPT_PAGE]: page,
    [RUNTIME_HOST_BRIDGE_SESSION_TRANSCRIPT_ADVANCE]: advance,
  } satisfies PicoBridgeSessionContinuityHandlerMap;

  return {
    handlers,
    releaseConnection: (connectionId) => registry.releaseConnection(connectionId),
    beginDrain: () => registry.shutdown(),
  };
}

function failure(error: unknown): {
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
