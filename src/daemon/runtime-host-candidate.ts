import type {
  RuntimeHostCandidateOptions,
  RuntimeHostCompositionContext,
} from "@pico/runtime-host";
import { globalSessionManager } from "../engine/session.js";
import {
  assembleProductionDaemonHost,
  createProductionRuntimeServices,
  type ProductionLocalDaemonHostOptions,
} from "./production-host.js";
import {
  startPicoDaemonRuntimeHostCandidate as startHostCandidate,
  type PicoDaemonCandidateResult,
  type PicoDaemonCompositionServices,
} from "@pico/pico-host/runtime-host-candidate";
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

export async function startPicoDaemonRuntimeHostCandidate(
  options: PicoDaemonCandidateOptions,
): Promise<PicoDaemonCandidateResult> {
  return startHostCandidate(options, (context) =>
    createPicoDaemonCompositionServices(context, options),
  );
}

async function createPicoDaemonCompositionServices(
  context: RuntimeHostCompositionContext,
  options: ProductionLocalDaemonHostOptions,
): Promise<PicoDaemonCompositionServices> {
  const services = createProductionRuntimeServices({
    ...options,
    acquireMemoryResidency: () => context.acquireResidency(),
  });
  const daemonHost = assembleProductionDaemonHost(services, options);
  return {
    service: {
      handle: (request) => services.desktopService.handle(request),
      beginDrain: () => services.desktopService.beginDrain(),
    },
    eventSource: services.desktopService,
    sessionNotificationSource: services.service,
    daemonHost,
    createSessionContinuitySource: () =>
      new SqliteSessionContinuitySource({
        picoHome: services.picoHome,
        planControlAvailable: () => services.desktopService.planControlAvailable(),
        readMetadata: (workspacePath, sessionId) =>
          services.desktopService.readSessionContinuityMetadata(workspacePath, sessionId),
      }),
    attachSessionSubscriptions: (registry) => services.attachSessionSubscriptions(registry),
    flushSessionOverlay: (workspacePath, sessionId) =>
      services.flushSessionOverlay(workspacePath, sessionId),
    clearAndDrainSessions: () => globalSessionManager.clearAndDrain(),
  };
}
