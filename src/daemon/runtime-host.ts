import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { logger } from "../observability/logger.js";
import type { DisposableLocalRuntimeService, ShutdownOwnershipFence } from "./service.js";
import type {
  CronWorkspaceRuntimeFactory,
  ManagedCronWorkspaceRuntime,
} from "./cron-workspace-runtime.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import type { CronRunRecord } from "../tasks/runtime-types.js";

type HostState = "stopped" | "starting" | "running" | "stopping";

export interface LocalDaemonHostOptions {
  service: DisposableLocalRuntimeService;
  cronRuntimeFactory: CronWorkspaceRuntimeFactory;
  registrationStore?: WorkspaceRegistrationStore;
  ownerId?: string;
  onWorkspaceError?: (workspacePath: string, error: unknown) => void;
}

/**
 * Internal production lifetime owner. The executor remains dependency-injected;
 * this host never imports or silently falls back to the foreground AgentRuntime.
 *
 * 3-D Phase 5（2026-08-16）：旧传输（endpoint/instance-lock/LocalRuntimeDaemon）
 * 已退役——本类只编排 service + cron runtime 生命周期与 shutdown fence 链，
 * 单例与传输由 kernel 的 flock 选主与 NDJSON endpoint 承担。
 */
export class LocalDaemonHost {
  readonly ownerId: string;
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly cronRuntimes = new Map<string, ManagedCronWorkspaceRuntime>();
  private readonly cronShutdownRuntimes = new Map<string, ManagedCronWorkspaceRuntime>();
  private readonly cronShutdownFailures = new Map<string, unknown>();
  private state: HostState = "stopped";
  private serviceClosed = false;
  private serviceClosePromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private reconcileQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalDaemonHostOptions) {
    this.ownerId = options.ownerId ?? `daemon:${process.pid}:${randomUUID()}`;
    this.registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
  }

  get status(): HostState {
    return this.state;
  }

  get registeredWorkspaces(): readonly string[] {
    return [...this.cronRuntimes.keys()].sort();
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return Promise.reject(new Error("daemon 正在停止"));
    if (this.state === "running") return Promise.resolve();
    if (this.state !== "stopped") return Promise.reject(new Error(`daemon 当前处于 ${this.state}`));
    if (this.serviceClosed) {
      return Promise.reject(new Error("daemon host 已关闭，请创建新 host 后重启"));
    }
    this.state = "starting";
    const startPromise = Promise.resolve().then(() => this.startOnce());
    this.startPromise = startPromise;
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === startPromise) this.startPromise = undefined;
      },
    );
    return startPromise;
  }

  private async startOnce(): Promise<void> {
    try {
      await this.reconcileRegisteredWorkspaces();
      this.state = "running";
      for (const runtime of this.cronRuntimes.values()) runtime.start();
    } catch (error) {
      try {
        await this.closeResources();
      } catch (cleanupError) {
        // 启动失败后的清理失败不应掩盖原始启动错误（否则无法定位启动根因）。
        logger.error(
          { cleanupError, startupError: error },
          "Daemon startup failed and cleanup also failed",
        );
      } finally {
        this.state = "stopped";
      }
      throw error;
    }
  }

  /** Reconciles user registration without restarting the daemon. */
  async refreshRegisteredWorkspaces(): Promise<void> {
    if (this.state !== "running") throw new Error("daemon 尚未运行");
    await this.reconcileRegisteredWorkspaces();
  }

  async runCronJobNow(workspacePath: string, cronJobId: string): Promise<CronRunRecord> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const runtime = this.cronRuntimes.get(canonical);
    if (!runtime) throw new Error(`工作区尚未启动 Cron runtime: ${canonical}`);
    if (!runtime.runNow) throw new Error("当前 Cron runtime 不支持立即运行");
    return runtime.runNow(cronJobId);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped" && !this.startPromise) return Promise.resolve();
    const stopPromise = Promise.resolve().then(() => this.stopOnce());
    this.stopPromise = stopPromise;
    void stopPromise.then(
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined;
      },
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = undefined;
      },
    );
    return stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const starting = this.startPromise;
    if (starting) await starting.catch(() => undefined);
    if (this.state === "stopped") return;
    this.state = "stopping";
    try {
      await this.closeResources();
    } finally {
      this.state = "stopped";
    }
  }

  private async reconcileRegisteredWorkspaces(): Promise<void> {
    const queued = this.reconcileQueue.then(
      () => this.performReconcileRegisteredWorkspaces(),
      () => this.performReconcileRegisteredWorkspaces(),
    );
    this.reconcileQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  private async performReconcileRegisteredWorkspaces(): Promise<void> {
    const registered = new Set(await this.registrationStore.list());
    for (const [workspacePath, runtime] of this.cronRuntimes) {
      if (registered.has(workspacePath)) continue;
      this.cronRuntimes.delete(workspacePath);
      this.cronShutdownRuntimes.set(workspacePath, runtime);
      try {
        runtime.beginClose?.();
        await runtime.close();
        this.trackCronOwnershipRelease(workspacePath, runtime);
      } catch (error) {
        this.cronShutdownFailures.set(workspacePath, error);
      }
    }
    for (const workspacePath of registered) {
      if (this.cronRuntimes.has(workspacePath)) continue;
      if (this.cronShutdownRuntimes.has(workspacePath)) continue;
      // 目录已不存在的注册项不物化 cron runtime（注册表 list() 已过滤缺失
      // 目录，这里是过滤与物化之间的竞态护栏）。真机事故（2026-08-16）：真
      // home 累积 54 个存活 %TEMP% e2e 工作区，reconcile 全量物化把常驻
      // daemon 拖进 ~30% CPU 定时器风暴——根治在 e2e 隔离 daemon root。
      // 不自动 unregister（网络盘暂时不可达时会误删），仅跳过。
      if (!existsSync(workspacePath)) continue;
      try {
        const runtime = await this.options.cronRuntimeFactory.create({
          workspacePath,
          ownerId: this.ownerId,
        });
        runtime.recoverInterruptedRuns();
        this.cronRuntimes.set(workspacePath, runtime);
        if (this.state === "running") runtime.start();
      } catch (error) {
        this.options.onWorkspaceError?.(workspacePath, error);
      }
    }
    const shutdownFailure = this.cronShutdownFailures.values().next();
    if (!shutdownFailure.done) throw shutdownFailure.value;
    const reactivatedWhileClosing = [...registered].find((workspacePath) =>
      this.cronShutdownRuntimes.has(workspacePath),
    );
    if (reactivatedWhileClosing) {
      throw new Error(`Cron runtime 仍在关闭，暂时无法重新注册: ${reactivatedWhileClosing}`);
    }
  }

  private trackCronOwnershipRelease(
    workspacePath: string,
    runtime: ManagedCronWorkspaceRuntime,
  ): void {
    const ownership = readCronOwnershipFence(runtime);
    if (ownership.error !== undefined) {
      this.cronShutdownFailures.set(workspacePath, ownership.error);
      return;
    }
    if (!ownership.fence) {
      if (this.cronShutdownRuntimes.get(workspacePath) === runtime) {
        this.cronShutdownRuntimes.delete(workspacePath);
      }
      return;
    }
    void ownership.fence.released.then(
      () => {
        if (
          this.cronShutdownRuntimes.get(workspacePath) === runtime &&
          !this.cronShutdownFailures.has(workspacePath)
        ) {
          this.cronShutdownRuntimes.delete(workspacePath);
          if (this.state === "running") {
            void this.reconcileRegisteredWorkspaces().catch((error: unknown) => {
              this.options.onWorkspaceError?.(workspacePath, error);
            });
          }
        }
      },
      (error: unknown) => {
        this.cronShutdownFailures.set(workspacePath, error);
      },
    );
  }

  private async closeResources(): Promise<void> {
    await this.reconcileQueue;
    const runtimes = [
      ...new Set([...this.cronRuntimes.values(), ...this.cronShutdownRuntimes.values()]),
    ];
    this.cronRuntimes.clear();
    const runtimeClosePromises = runtimes.map(async (runtime) => {
      runtime.beginClose?.();
      await runtime.close();
    });
    let serviceCloseError: unknown;
    try {
      await this.closeService();
    } catch (error) {
      serviceCloseError = error;
    }
    const runtimeCloseResults = await Promise.allSettled(runtimeClosePromises);
    const runtimeCloseFailure = runtimeCloseResults.find((result) => result.status === "rejected");
    const priorRuntimeCloseFailure = this.cronShutdownFailures.values().next();
    const cronOwnership = runtimes.map(readCronOwnershipFence);
    const cronOwnershipFailure = cronOwnership.find(
      (ownership) => ownership.error !== undefined,
    )?.error;
    if (serviceCloseError !== undefined) throw serviceCloseError;
    if (runtimeCloseFailure?.status === "rejected") throw runtimeCloseFailure.reason;
    if (priorRuntimeCloseFailure.done !== true) throw priorRuntimeCloseFailure.value;
    if (cronOwnershipFailure !== undefined) throw cronOwnershipFailure;
  }

  private closeService(): Promise<void> {
    if (this.serviceClosePromise) return this.serviceClosePromise;
    // A DisposableLocalRuntimeService is single-use even when its close reports failure.
    this.serviceClosed = true;
    let resolveClose: () => void = () => undefined;
    let rejectClose: (reason: unknown) => void = () => undefined;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.serviceClosePromise = closePromise;
    try {
      Promise.resolve(this.options.service.close?.()).then(resolveClose, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return closePromise;
  }
}

function readCronOwnershipFence(runtime: ManagedCronWorkspaceRuntime): {
  fence?: ShutdownOwnershipFence;
  error?: unknown;
} {
  const readPending = runtime.hasPendingOwnership;
  const waitForRelease = runtime.waitForOwnershipRelease;
  if (!readPending && !waitForRelease) return {};
  if (!readPending || !waitForRelease) {
    return {
      error: new Error(
        "Cron runtime ownership fence 不完整：hasPendingOwnership 与 waitForOwnershipRelease 必须同时提供",
      ),
    };
  }
  try {
    return {
      fence: {
        pending: readPending.call(runtime),
        released: waitForRelease.call(runtime),
      },
    };
  } catch (error) {
    return { error };
  }
}

/** Installs only process-lifetime hooks; CLI exposure remains a separate product decision. */
export function installLocalDaemonShutdownHandlers(host: LocalDaemonHost): () => void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      // 第二次信号：优雅关闭仍未结束则强制退出，避免 cleanup 卡住时无法中断。
      process.exit(130);
    }
    stopping = true;
    void host.stop().then(
      () => dispose(),
      (error: unknown) => {
        logger.error({ error }, "Daemon shutdown failed after process signal");
        dispose();
      },
    );
  };
  const dispose = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return dispose;
}
