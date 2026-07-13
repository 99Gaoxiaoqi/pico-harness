import { LocalRuntimeClient, resolveLocalDaemonEndpoint } from "../daemon/index.js";

/** The small boundary between TUI commands and the local Runtime daemon. */
export interface CronDaemonBridge {
  registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration>;
}

export interface CronDaemonRegistration {
  available: boolean;
  /** Safe to append directly to a user-facing slash-command result. */
  message: string;
}

export interface LocalCronDaemonBridgeOptions {
  createClient?: () => Pick<LocalRuntimeClient, "request" | "close">;
}

/**
 * Registers a workspace with an already-running daemon without making TUI own
 * its lifetime. `workspace.register` is durable daemon-owned registration;
 * merely listing jobs would only materialise an in-memory Runtime.
 */
export class LocalCronDaemonBridge implements CronDaemonBridge {
  private readonly createClient: () => Pick<LocalRuntimeClient, "request" | "close">;

  constructor(options: LocalCronDaemonBridgeOptions = {}) {
    this.createClient = options.createClient ?? (() => new LocalRuntimeClient(resolveLocalDaemonEndpoint()));
  }

  async registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration> {
    const client = this.createClient();
    try {
      const request = client.request as (method: string, params: Record<string, unknown>) => Promise<unknown>;
      await request("runtime.ping", {});
      await request("workspace.register", { workspacePath });
      return {
        available: true,
        message: "本机 Runtime daemon 已连接；当前工作区已注册，TUI 退出后仍会由 daemon 调度。",
      };
    } catch {
      return {
        available: false,
        message: "本机 Runtime daemon 未连接；任务已保存，但目前不会自动执行。启动 daemon 后重新执行 /cron enable <job-id>。",
      };
    } finally {
      client.close();
    }
  }
}
