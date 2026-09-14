import {
  resolveExistingStorageRoot,
  RuntimeHostKernel,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostCandidateOptions,
  type RuntimeHostComposition,
  type RuntimeHostCompositionContext,
} from "@pico/runtime-host";
import type { RuntimeHostBridgeService } from "./runtime-host-composition.js";
import { createRuntimeHostComposition } from "./runtime-host-composition.js";
import type { RuntimeHostEventSource } from "./runtime-host-events.js";
import {
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
  RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN,
  type BridgeOperationContext,
} from "./runtime-host-operations.js";
import {
  SessionSubscriptionRegistry,
  type SessionContinuityDataSource,
} from "./session-subscription-owner.js";

export type PicoDaemonCandidateResult =
  | { kind: "loser" }
  | { kind: "winner"; host: RuntimeHostKernel };

export interface PicoDaemonCompositionService extends Pick<RuntimeHostBridgeService, "handle"> {
  beginDrain(): void;
}

export interface PicoDaemonLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Production-specific stores and Session ownership are supplied by the outer composition root. */
export interface PicoDaemonCompositionServices {
  readonly service: PicoDaemonCompositionService;
  readonly eventSource: RuntimeHostEventSource;
  readonly sessionNotificationSource: Pick<RuntimeHostEventSource, "subscribe">;
  readonly daemonHost: PicoDaemonLifecycle;
  readonly createSessionContinuitySource: () => SessionContinuityDataSource;
  readonly attachSessionSubscriptions: (registry: SessionSubscriptionRegistry) => void;
  readonly flushSessionOverlay: (workspacePath: string, sessionId: string) => Promise<void>;
  readonly clearAndDrainSessions: () => Promise<void>;
}

export type PicoDaemonCompositionServicesFactory = (
  context: RuntimeHostCompositionContext,
) => Promise<PicoDaemonCompositionServices>;

/**
 * Pico daemon's unique Runtime Host candidate lifecycle: validate root identity,
 * elect one owner, then attach the Host-owned bridge and shutdown fences.
 */
export async function startPicoDaemonRuntimeHostCandidate(
  options: RuntimeHostCandidateOptions,
  createServices: PicoDaemonCompositionServicesFactory,
): Promise<PicoDaemonCandidateResult> {
  ensurePicoRuntimeHostOperationsRegistered();
  ensurePicoRuntimeHostEventOperationsRegistered();
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered();
  ensurePicoRuntimeHostShutdownOperationRegistered();

  const capability = await resolveExistingStorageRoot({
    path: options.rootPath,
    kind: "interactive",
    expectedRootId: options.expectedRootId,
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) return { kind: "loser" };

  const host = await RuntimeHostKernel.start({
    owner,
    ...(options.idleGraceMs === undefined ? {} : { idleGraceMs: options.idleGraceMs }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    ...(options.operationDeadlineMs === undefined
      ? {}
      : { operationDeadlineMs: options.operationDeadlineMs }),
    compositionFactory: async (context) =>
      createPicoDaemonRuntimeHostComposition(context, await createServices(context)),
  });
  return { kind: "winner", host };
}

export function createPicoDaemonRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
  services: PicoDaemonCompositionServices,
): RuntimeHostComposition {
  // A daemon is user-resident because Cron scheduling must survive interactive clients.
  // This reversible residency is released from close(), preserving graceful SIGTERM drain.
  const residency = context.acquireResidency();
  const sessionContinuity = new SessionSubscriptionRegistry(
    context.hostEpoch,
    services.createSessionContinuitySource(),
    (workspacePath, sessionId) => services.flushSessionOverlay(workspacePath, sessionId),
  );
  services.attachSessionSubscriptions(sessionContinuity);
  const unsubscribeSessionNotifications = services.sessionNotificationSource.subscribe(
    (notification) => sessionContinuity.publishRuntimeNotification(notification),
  );
  const bridge = createRuntimeHostComposition({
    // daemonHost.stop() owns service close exactly once; the bridge only owns protocol wiring.
    service: { handle: (request) => services.service.handle(request), close: () => undefined },
    eventSource: services.eventSource,
    sessionContinuity,
  });

  return {
    handlers: {
      ...bridge.handlers,
      [RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN]: async (
        _input: Record<string, never>,
        operationContext?: BridgeOperationContext,
      ) => {
        if (!operationContext?.afterResponseFlushed) {
          return {
            ok: false,
            error: {
              code: "internal_failure" as const,
              message: "runtime.shutdown requires a response-flushed barrier",
            },
          };
        }
        operationContext.afterResponseFlushed(() => context.requestDrain());
        return { ok: true, result: {} };
      },
    } as RuntimeHostComposition["handlers"],
    releaseConnection(connectionId: string): void {
      bridge.releaseConnection?.(connectionId);
    },
    beginDrain() {
      services.service.beginDrain();
      bridge.beginDrain();
    },
    async recover() {
      await services.daemonHost.start();
    },
    async close() {
      try {
        unsubscribeSessionNotifications();
        await bridge.close();
        await services.daemonHost.stop();
        await services.clearAndDrainSessions();
      } finally {
        residency.release();
      }
    },
  };
}
