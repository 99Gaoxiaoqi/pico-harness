import { LocalRuntimeClient, resolveLocalDaemonEndpoint } from "../daemon/index.js";

/** The small boundary between TUI commands and the local Runtime daemon. */
export interface CronDaemonBridge {
  registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration>;
  statusWorkspace(workspacePath: string): Promise<CronDaemonStatus>;
}

export interface CronDaemonRegistration {
  available: boolean;
  /** Safe to append directly to a user-facing slash-command result. */
  message: string;
}

export interface CronDaemonStatus {
  available: boolean;
  registered?: boolean;
  /** User-facing text; installation is deliberately unknown when only socket reachability is known. */
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
    this.createClient =
      options.createClient ?? (() => new LocalRuntimeClient(resolveLocalDaemonEndpoint()));
  }

  async registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration> {
    const client = this.createClient();
    try {
      const request = client.request as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      await request("runtime.ping", {});
      await request("workspace.register", { workspacePath });
      return {
        available: true,
        message: "本机 Runtime daemon 已连接；当前工作区已注册，TUI 退出后仍会由 daemon 调度。",
      };
    } catch {
      return {
        available: false,
        message:
          "本机 Runtime daemon 未连接；任务已保存，但目前不会自动执行。启动 daemon 后重新执行 /cron enable <job-id>。",
      };
    } finally {
      client.close();
    }
  }

  async statusWorkspace(workspacePath: string): Promise<CronDaemonStatus> {
    const client = this.createClient();
    try {
      const request = client.request as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      await request("runtime.ping", {});
      const value = await request("workspace.status", { workspacePath });
      const status = readWorkspaceStatus(value);
      if (!status) {
        return {
          available: true,
          message: "本机 Runtime daemon 已连接；当前工作区登记状态未知，守护安装状态也未知。",
        };
      }
      return {
        available: true,
        registered: status.registered,
        message: `本机 Runtime daemon 已连接；当前工作区${status.registered ? "已" : "未"}登记；守护安装状态未知。`,
      };
    } catch {
      return {
        available: false,
        message: "本机 Runtime daemon 不可达；当前只能查看本地账本，已保存的任务不会自动执行。",
      };
    } finally {
      client.close();
    }
  }
}

function readWorkspaceStatus(value: unknown): { registered: boolean } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registered = (value as { registered?: unknown }).registered;
  const schedulerStatus = (value as { schedulerStatus?: unknown }).schedulerStatus;
  return typeof registered === "boolean" && schedulerStatus === "unknown"
    ? { registered }
    : undefined;
}
