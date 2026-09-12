import {
  resolveExistingStorageRoot,
  RuntimeHostKernel,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostCandidateOptions,
  type RuntimeHostComposition,
  type RuntimeHostCompositionContext,
} from "@pico/runtime-host";
import { globalSessionManager } from "../engine/session.js";
import {
  assembleProductionDaemonHost,
  createProductionRuntimeServices,
  type ProductionLocalDaemonHostOptions,
} from "./production-host.js";
import { createRuntimeHostComposition } from "./runtime-host-composition.js";
import {
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
  RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN,
  type BridgeOperationContext,
} from "./runtime-host-operations.js";
import { SessionSubscriptionRegistry } from "./session-subscription-owner.js";
import { SqliteSessionContinuitySource } from "./sqlite-session-continuity-source.js";

/**
 * Pico daemon 的唯一启动形态是 Runtime Host candidate：
 *
 *   1. 校验调用方提供的 storage root identity；
 *   2. 以 flock 选主，唯一 winner 启动 kernel，loser 退出；
 *   3. 装配 production services，并在关停时排空 cron 与 Session ownership。
 */

export interface PicoDaemonCandidateOptions extends RuntimeHostCandidateOptions {
  env?: ProductionLocalDaemonHostOptions["env"];
}

export type PicoDaemonCandidateResult =
  | { kind: "loser" }
  | { kind: "winner"; host: RuntimeHostKernel };

export async function startPicoDaemonRuntimeHostCandidate(
  options: PicoDaemonCandidateOptions,
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
    compositionFactory: (context) => createPicoDaemonComposition(context, { env: options.env }),
  });
  return { kind: "winner", host };
}

async function createPicoDaemonComposition(
  context: RuntimeHostCompositionContext,
  options: ProductionLocalDaemonHostOptions,
): Promise<RuntimeHostComposition> {
  // daemon 是用户级常驻服务（cron 调度必须存活）：持有一个长期 residency 阻止
  // idle 自退。注意不能用 retainUntilProcessExit——那是不可逆闩，会让 kernel 的
  // #waitForResidencies 永远等不到归零、优雅关停退化为 deadline 强杀。此处持有
  // 的 residency 在 close() 尾部释放（kernel 先调 composition.close 再等 residency
  // 归零，顺序恰好成立），从而"常驻 + SIGTERM 可优雅关停"两者兼得。
  const residency = context.acquireResidency();

  const services = createProductionRuntimeServices({
    ...options,
    acquireMemoryResidency: () => context.acquireResidency(),
  });
  const daemonHost = assembleProductionDaemonHost(services, options);
  const sessionContinuity = new SessionSubscriptionRegistry(
    context.hostEpoch,
    new SqliteSessionContinuitySource({
      picoHome: services.picoHome,
      planControlAvailable: () => services.desktopService.planControlAvailable(),
      readMetadata: (workspacePath, sessionId) =>
        services.desktopService.readSessionContinuityMetadata(workspacePath, sessionId),
    }),
    (workspacePath, sessionId) => services.flushSessionOverlay(workspacePath, sessionId),
  );
  services.attachSessionSubscriptions(sessionContinuity);
  const unsubscribeSessionNotifications = services.service.subscribe((notification) =>
    sessionContinuity.publishRuntimeNotification(notification),
  );
  const bridge = createRuntimeHostComposition({
    // service.close 由 daemonHost.stop() 的 closeService 单次性持有；桥接层
    // 显式声明 no-op close，避免把“缺少生命周期”误当成所有权约定。
    service: {
      handle: (request) => services.desktopService.handle(request),
      close: () => undefined,
    },
    eventSource: services.desktopService,
    sessionContinuity,
  });

  return {
    // runtime.shutdown：常驻 daemon 的优雅关停入口（等效 SIGTERM 路径——
    // 触发 kernel requestDrain → 排空 → composition.close → residency 释放 →
    // 进程退出）。必须等成功响应刷入 transport 后再请求
    // drain；否则 kernel 可能在客户端读到响应前销毁连接并暴露 read_eof。
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
    },
    releaseConnection: bridge.releaseConnection,
    beginDrain() {
      services.desktopService.beginDrain();
      // drain 期间停事件推送；cron 停止由 close() 统一收口。
      bridge.beginDrain();
    },
    async recover() {
      // kernel recovering 阶段：reconcile 注册工作区 + 启动 cron（60s deadline 兜底）。
      await daemonHost.start();
    },
    async close() {
      try {
        unsubscribeSessionNotifications();
        await bridge.close();
        // 完整 shutdown fence 链（cron ownership + service.close）。
        await daemonHost.stop();
        // SessionManager 的历史缓存可在请求结束后继续持有 durable OwnerLease。
        // Runtime Host 已停止 admission，此处必须排空缓存后进程才能退出，避免阻塞
        // 后继 Host 对同一 Session 的接管。
        await globalSessionManager.clearAndDrain();
      } finally {
        // 无论成败都放掉常驻 residency：成功路径让 kernel 完成收尾；失败路径也已
        // 过 shutdown deadline 语义（由 kernel 决定升级为强杀）。
        residency.release();
      }
    },
  };
}
