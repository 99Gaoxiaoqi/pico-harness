import { randomUUID } from "node:crypto";
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

  async start(): Promise<void> {
    if (this.state === "running") return;
    if (this.state !== "stopped") throw new Error(`daemon 当前处于 ${this.state}`);
    this.state = "starting";
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
      await this.closeResources();
      this.state = "stopped";
      throw error;
    }
  }

  /** Reconciles user registration without restarting the daemon. */
  async refreshRegisteredWorkspaces(): Promise<void> {
    if (this.state !== "running") throw new Error("daemon 尚未运行");
    await this.reconcileRegisteredWorkspaces();
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "stopping") return;
    this.state = "stopping";
    await this.closeResources();
    this.state = "stopped";
  }

  private async reconcileRegisteredWorkspaces(): Promise<void> {
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
    await this.daemon.stop().catch(() => undefined);
    const runtimes = [...this.cronRuntimes.values()];
    this.cronRuntimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    try {
      if (!this.serviceClosed) {
        await this.options.service.close?.();
        this.serviceClosed = true;
      }
    } finally {
      await this.instanceLock?.release();
      this.instanceLock = undefined;
    }
  }
}

/** Installs only process-lifetime hooks; CLI exposure remains a separate product decision. */
export function installLocalDaemonShutdownHandlers(host: LocalDaemonHost): () => void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void host.stop().finally(() => {
      dispose();
    });
  };
  const dispose = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return dispose;
}
