import { randomUUID } from "node:crypto";
import { logger } from "../observability/logger.js";
import type { LocalDaemonEndpoint } from "./endpoint.js";
import { removeLocalDaemonEndpoint, resolveLocalDaemonEndpoint } from "./endpoint.js";
import { LocalDaemonInstanceLock, type LocalDaemonInstanceLockOptions } from "./instance-lock.js";
import { LocalRuntimeDaemon } from "./server.js";
import type { DisposableLocalRuntimeService } from "./service.js";
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
  endpoint?: LocalDaemonEndpoint;
  registrationStore?: WorkspaceRegistrationStore;
  ownerId?: string;
  lockOptions?: Omit<LocalDaemonInstanceLockOptions, "endpoint">;
  onWorkspaceError?: (workspacePath: string, error: unknown) => void;
}

/**
 * Internal production lifetime owner. The executor remains dependency-injected;
 * this host never imports or silently falls back to the foreground AgentRuntime.
 */
export class LocalDaemonHost {
  readonly endpoint: LocalDaemonEndpoint;
  readonly ownerId: string;
  private readonly daemon: LocalRuntimeDaemon;
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly cronRuntimes = new Map<string, ManagedCronWorkspaceRuntime>();
  private instanceLock?: LocalDaemonInstanceLock;
  private state: HostState = "stopped";
  private serviceClosed = false;
  private serviceCloseSucceeded = false;
  private serviceClosePromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private reconcileQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalDaemonHostOptions) {
    this.endpoint = options.endpoint ?? resolveLocalDaemonEndpoint();
    this.ownerId = options.ownerId ?? `daemon:${process.pid}:${randomUUID()}`;
    this.registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
    this.daemon = new LocalRuntimeDaemon({ endpoint: this.endpoint, service: options.service });
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
      this.instanceLock = await LocalDaemonInstanceLock.acquire({
        endpoint: this.endpoint,
        ...this.options.lockOptions,
      });
      // Safe only after the singleton lock and active protocol ping both succeeded.
      await removeLocalDaemonEndpoint(this.endpoint);
      await this.reconcileRegisteredWorkspaces();
      await this.daemon.start();
      this.state = "running";
      for (const runtime of this.cronRuntimes.values()) runtime.start();
    } catch (error) {
      try {
        await this.closeResources();
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
      await runtime.close();
    }
    for (const workspacePath of registered) {
      if (this.cronRuntimes.has(workspacePath)) continue;
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
  }

  private async closeResources(): Promise<void> {
    await this.reconcileQueue;
    let daemonCloseError: unknown;
    try {
      await this.daemon.stop();
    } catch (error) {
      daemonCloseError = error;
    }
    const runtimes = [...this.cronRuntimes.values()];
    this.cronRuntimes.clear();
    const runtimeCloseResults = await Promise.allSettled(
      runtimes.map((runtime) => runtime.close()),
    );
    const runtimeCloseFailure = runtimeCloseResults.find((result) => result.status === "rejected");
    let serviceCloseError: unknown;
    try {
      await this.closeService();
    } catch (error) {
      serviceCloseError = error;
    } finally {
      await this.releaseInstanceLockWhenSafe({
        unfencedResourcesClosed:
          daemonCloseError === undefined && runtimeCloseFailure === undefined,
        serviceCloseSucceeded: this.serviceCloseSucceeded,
      });
    }
    if (serviceCloseError !== undefined) throw serviceCloseError;
    if (daemonCloseError !== undefined) throw daemonCloseError;
    if (runtimeCloseFailure?.status === "rejected") throw runtimeCloseFailure.reason;
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
      Promise.resolve(this.options.service.close?.()).then(() => {
        this.serviceCloseSucceeded = true;
        resolveClose();
      }, rejectClose);
    } catch (error) {
      rejectClose(error);
    }
    return closePromise;
  }

  private async releaseInstanceLockWhenSafe(options: {
    unfencedResourcesClosed: boolean;
    serviceCloseSucceeded: boolean;
  }): Promise<void> {
    const instanceLock = this.instanceLock;
    if (!instanceLock) return;
    const fence = this.options.service.shutdownOwnershipFence?.();
    if (!options.unfencedResourcesClosed || (!options.serviceCloseSucceeded && !fence)) {
      logger.error(
        { lockPath: instanceLock.lockPath },
        "Daemon shutdown could not prove ownership release; retaining singleton lock",
      );
      return;
    }
    if (!fence || !fence.pending) {
      await fence?.released;
      await instanceLock.release();
      if (this.instanceLock === instanceLock) this.instanceLock = undefined;
      return;
    }

    const deferredRelease = fence.released.then(async () => {
      await instanceLock.release();
      if (this.instanceLock === instanceLock) this.instanceLock = undefined;
    });
    void deferredRelease.catch((error: unknown) => {
      logger.error(
        { error, lockPath: instanceLock.lockPath },
        "Daemon shutdown ownership fence failed; retaining singleton lock",
      );
    });
  }
}

/** Installs only process-lifetime hooks; CLI exposure remains a separate product decision. */
export function installLocalDaemonShutdownHandlers(host: LocalDaemonHost): () => void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
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
