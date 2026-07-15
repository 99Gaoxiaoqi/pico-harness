import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createUserDaemonInstaller,
  LocalRuntimeClient,
  resolveLocalDaemonEndpoint,
} from "../daemon/index.js";

/** The small boundary between TUI commands and the local Runtime daemon. */
export interface CronDaemonBridge {
  registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration>;
  statusWorkspace(workspacePath: string): Promise<CronDaemonStatus>;
  /** Provider/config/vault deletion is daemon-owned so TUI never mutates two stores itself. */
  deleteProvider(input: ProviderDaemonDeleteInput): Promise<ProviderDaemonDeleteResult>;
}

export interface ProviderDaemonDeleteInput {
  readonly providerId: string;
  readonly expectedRevision: string;
}

export type ProviderDaemonDeleteResult =
  | {
      readonly status: "deleted";
      readonly revision: string;
      readonly message: string;
    }
  | {
      readonly status: "unavailable" | "rejected";
      readonly message: string;
    };

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
  startDaemon?: () => Promise<"installed" | "process">;
}

/**
 * Registers a workspace with an already-running daemon without making TUI own
 * its lifetime. `workspace.register` is durable daemon-owned registration;
 * merely listing jobs would only materialise an in-memory Runtime.
 */
export class LocalCronDaemonBridge implements CronDaemonBridge {
  private readonly createClient: () => Pick<LocalRuntimeClient, "request" | "close">;
  private readonly startDaemon?: () => Promise<"installed" | "process">;

  constructor(options: LocalCronDaemonBridgeOptions = {}) {
    this.createClient =
      options.createClient ?? (() => new LocalRuntimeClient(resolveLocalDaemonEndpoint()));
    this.startDaemon =
      options.startDaemon ?? (options.createClient ? undefined : startOrInstallLocalDaemon);
  }

  async registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration> {
    let client = this.createClient();
    try {
      let lifetime: "existing" | "installed" | "process" = "existing";
      try {
        await client.request("runtime.ping", {});
      } catch (initialError) {
        if (!this.startDaemon) throw initialError;
        lifetime = await this.startDaemon();
        client.close();
        client = this.createClient();
        await waitForDaemon(client);
      }
      const request = client.request.bind(client);
      await request("workspace.register", { workspacePath });
      return {
        available: true,
        message:
          lifetime === "process"
            ? "本机 Runtime daemon 已启动并登记工作区；TUI 退出后仍会调度，系统重新登录后需再次启动。"
            : "本机 Runtime daemon 已连接；当前工作区已注册，TUI 退出后仍会由 daemon 调度。",
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

  async deleteProvider(input: ProviderDaemonDeleteInput): Promise<ProviderDaemonDeleteResult> {
    const client = this.createClient();
    try {
      try {
        await client.request("runtime.ping", {});
      } catch {
        return {
          status: "unavailable",
          message:
            "本机 Runtime daemon 不可达；为避免配置与系统凭证失去同步，Provider 未删除。",
        };
      }
      try {
        const value = await client.request("provider.delete", {
          providerId: input.providerId,
          expectedRevision: input.expectedRevision,
        });
        const revision = readProviderDeleteRevision(value);
        if (!revision) {
          return {
            status: "rejected",
            message: "Runtime daemon 返回了无效的 Provider 删除结果；Provider 状态未确认。",
          };
        }
        return {
          status: "deleted",
          revision,
          message: `Shared user provider ${input.providerId} 及其系统凭证已删除。`,
        };
      } catch (error) {
        return {
          status: "rejected",
          message: `Provider ${input.providerId} 未删除: ${safeDaemonMessage(error)}`,
        };
      }
    } finally {
      client.close();
    }
  }
}

async function startOrInstallLocalDaemon(): Promise<"installed" | "process"> {
  const daemonMain = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
  const installer = createUserDaemonInstaller();
  if (installer.install) {
    await installer.install({
      serviceName: "com.pico.runtime",
      executable: process.execPath,
      args: [daemonMain],
    });
    return "installed";
  }
  const child = spawn(process.execPath, [daemonMain], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return "process";
}

async function waitForDaemon(
  client: Pick<LocalRuntimeClient, "request">,
  attempts = 40,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await client.request("runtime.ping", {});
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("daemon 启动超时");
}

function readWorkspaceStatus(value: unknown): { registered: boolean } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const registered = (value as { registered?: unknown }).registered;
  const schedulerStatus = (value as { schedulerStatus?: unknown }).schedulerStatus;
  return typeof registered === "boolean" && schedulerStatus === "unknown"
    ? { registered }
    : undefined;
}

function readProviderDeleteRevision(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const deleted = (value as { deleted?: unknown }).deleted;
  const revision = (value as { revision?: unknown }).revision;
  return deleted === true && typeof revision === "string" && /^[a-f0-9]{64}$/u.test(revision)
    ? revision
    : undefined;
}

function safeDaemonMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(api[_-]?key|token|secret)\s*[=:]\s*\S+/giu, "$1=<redacted>");
}
