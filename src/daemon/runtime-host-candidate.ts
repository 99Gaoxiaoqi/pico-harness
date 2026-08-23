import {
  parseRuntimeHostCandidateArguments,
  resolveExistingStorageRoot,
  resolveStorageRoot,
  RuntimeHostKernel,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostComposition,
  type RuntimeHostCompositionContext,
} from "@pico/runtime-host";
import { logger } from "../observability/logger.js";
import { resolveCanonicalPicoHome, resolveLocalDaemonEndpoint } from "./endpoint.js";
import {
  LocalDaemonAlreadyRunningError,
  LocalDaemonInstanceLock,
  type LocalDaemonInstanceLockOptions,
} from "./instance-lock.js";
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
} from "./runtime-host-operations.js";
import { SessionSubscriptionRegistry } from "./session-subscription-owner.js";
import { SqliteSessionContinuitySource } from "./sqlite-session-continuity-source.js";

/**
 * 3-B-3 daemon candidate：把 daemon main 从"旧传输单例宿主"迁移为 runtime-host
 * candidate 模式（flock 选主 + registration 发现）。启动序列：
 *
 *   1. 升级守卫：先抢旧 instance-lock（含 ping 探测）。旧版本 daemon 只持此锁、
 *      不持 flock——若不在此拦截，新旧两个 daemon 会各听各的传输、双跑 cron。
 *      守卫失败 = 旧 daemon 仍在运行，明确退出（exit 3），绝不并存。
 *   2. flock 选主（runtime-host 交互根）——唯一 winner 进入下一步，loser exit 2。
 *   3. RuntimeHostKernel.start + daemon composition（production services 全量装配，
 *      复用 LocalDaemonHost services-only 的 cron 编排与 shutdown fence 链）。
 *
 * 守卫锁持有到进程关停：close() 在 fence 证明资源安全释放后才放锁（fail-closed，
 * 与旧 daemon 的 releaseInstanceLockWhenSafe 同语义）。
 */

export interface PicoDaemonCandidateOptions {
  /** runtime-host 交互根路径（storage root marker 所在目录）。 */
  rootPath: string;
  /** 严格校验 rootId（connectOrSpawn spawn 路径传入）；无参自举时省略。 */
  expectedRootId?: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  operationDeadlineMs?: number;
  env?: ProductionLocalDaemonHostOptions["env"];
  lockOptions?: Omit<LocalDaemonInstanceLockOptions, "endpoint">;
}

export type PicoDaemonCandidateResult =
  | { kind: "legacy_daemon_running"; message: string }
  | { kind: "loser" }
  | { kind: "winner"; host: RuntimeHostKernel };

/**
 * 兼容两种启动形态：connectOrSpawn 的严格 kernel CLI（--root/--expected-root-id
 * 成对），以及无参自举（旧 LaunchAgent / 手动 `node main.js`）——后者以 canonical
 * PICO_HOME 为交互根推导一切。
 */
export function parsePicoDaemonCandidateArguments(
  args: readonly string[],
): PicoDaemonCandidateOptions {
  if (args.length === 0) {
    const rootPath = resolveCanonicalPicoHome();
    return { rootPath };
  }
  const parsed = parseRuntimeHostCandidateArguments(args);
  return {
    rootPath: parsed.rootPath,
    expectedRootId: parsed.expectedRootId,
    ...(parsed.legacyConfigurationRoot === undefined
      ? {}
      : { legacyConfigurationRoot: parsed.legacyConfigurationRoot }),
    ...(parsed.idleGraceMs === undefined ? {} : { idleGraceMs: parsed.idleGraceMs }),
    ...(parsed.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: parsed.handshakeTimeoutMs }),
    ...(parsed.operationDeadlineMs === undefined
      ? {}
      : { operationDeadlineMs: parsed.operationDeadlineMs }),
  };
}

export async function startPicoDaemonRuntimeHostCandidate(
  options: PicoDaemonCandidateOptions,
): Promise<PicoDaemonCandidateResult> {
  ensurePicoRuntimeHostOperationsRegistered();
  ensurePicoRuntimeHostEventOperationsRegistered();
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered();
  ensurePicoRuntimeHostShutdownOperationRegistered();

  // 1) 升级守卫：旧单例锁 + ping。
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const legacyEndpoint = resolveLocalDaemonEndpoint({ env });
  let legacyLock: LocalDaemonInstanceLock;
  try {
    legacyLock = await LocalDaemonInstanceLock.acquire({
      endpoint: legacyEndpoint,
      ...(options.lockOptions ?? {}),
    });
  } catch (error) {
    if (error instanceof LocalDaemonAlreadyRunningError) {
      return {
        kind: "legacy_daemon_running",
        message:
          "检测到旧版本 Runtime daemon 仍在运行（单例锁存活）。请先停止旧 daemon 后再启动新版本。",
      };
    }
    throw error;
  }

  // 2) flock 选主。
  const capability = options.expectedRootId
    ? await resolveExistingStorageRoot({
        path: options.rootPath,
        kind: "interactive",
        expectedRootId: options.expectedRootId,
      })
    : await resolveStorageRoot({ path: options.rootPath, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) {
    await legacyLock.release().catch(() => undefined);
    return { kind: "loser" };
  }

  // 3) kernel + daemon composition。
  try {
    const host = await RuntimeHostKernel.start({
      owner,
      ...(options.idleGraceMs === undefined ? {} : { idleGraceMs: options.idleGraceMs }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.operationDeadlineMs === undefined
        ? {}
        : { operationDeadlineMs: options.operationDeadlineMs }),
      compositionFactory: (context) =>
        createPicoDaemonComposition(context, { env: options.env }, legacyLock),
    });
    return { kind: "winner", host };
  } catch (error) {
    // kernel.start 失败时自身已回收 owner；这里补放守卫锁。
    await legacyLock.release().catch(() => undefined);
    throw error;
  }
}

async function createPicoDaemonComposition(
  context: RuntimeHostCompositionContext,
  options: ProductionLocalDaemonHostOptions,
  legacyLock: LocalDaemonInstanceLock,
): Promise<RuntimeHostComposition> {
  // daemon 是用户级常驻服务（cron 调度必须存活）：持有一个长期 residency 阻止
  // idle 自退。注意不能用 retainUntilProcessExit——那是不可逆闩，会让 kernel 的
  // #waitForResidencies 永远等不到归零、优雅关停退化为 deadline 强杀。此处持有
  // 的 residency 在 close() 尾部释放（kernel 先调 composition.close 再等 residency
  // 归零，顺序恰好成立），从而"常驻 + SIGTERM 可优雅关停"两者兼得。
  const residency = context.acquireResidency();

  const services = createProductionRuntimeServices(options);
  const daemonHost = assembleProductionDaemonHost(services, options);
  const sessionContinuity = new SessionSubscriptionRegistry(
    context.hostEpoch,
    new SqliteSessionContinuitySource({
      picoHome: services.picoHome,
      readMetadata: (workspacePath, sessionId) =>
        services.desktopService.readSessionContinuityMetadata(workspacePath, sessionId),
    }),
  );
  services.attachSessionSubscriptions(sessionContinuity);
  const unsubscribeSessionNotifications = services.service.subscribe((notification) =>
    sessionContinuity.publishRuntimeNotification(notification),
  );
  const bridge = createRuntimeHostComposition({
    // service.close 由 daemonHost.stop() 的 closeService 单次性持有；桥接层拿
    // 不带 close 的视图，避免双重 close。
    service: { handle: (request) => services.desktopService.handle(request) },
    eventSource: services.desktopService,
    sessionContinuity,
  });

  return {
    // runtime.shutdown：常驻 daemon 的优雅关停入口（等效 SIGTERM 路径——
    // 触发 kernel requestDrain → 排空 → composition.close → 守卫锁释放 →
    // residency 释放 → 进程退出）。handler 返回后 kernel 会等本操作排空并
    // 把响应写出，再 destroy 连接，客户端无需额外确认握手。
    handlers: {
      ...bridge.handlers,
      [RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN]: async () => {
        context.requestDrain();
        return { ok: true, result: {} };
      },
    },
    releaseConnection: bridge.releaseConnection,
    beginDrain() {
      // drain 期间停事件推送；cron 停止由 close() 统一收口（与旧 daemon 停机序一致）。
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
        // 完整 shutdown fence 链（cron ownership + service.close + 锁保留语义）。
        await daemonHost.stop();
        await legacyLock.release();
      } catch (error) {
        logger.error({ error }, "Pico daemon candidate 关停失败，保留升级守卫锁（fail-closed）");
        throw error;
      } finally {
        // 无论成败都放掉常驻 residency：成功路径让 kernel 完成收尾；失败路径也已
        // 过 shutdown deadline 语义（由 kernel 决定升级为强杀）。
        residency.release();
      }
    },
  };
}
