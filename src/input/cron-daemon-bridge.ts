import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type RuntimeJob, type RuntimeProviderInput } from "@pico/protocol";
import { LocalRuntimeClient } from "../daemon/client.js";
import { createUserDaemonInstaller } from "../daemon/user-daemon-installer.js";
import {
  resolveCanonicalPicoHome,
  resolveLocalDaemonEndpoint,
  resolveLocalDaemonServiceName,
} from "../daemon/endpoint.js";

/** The small boundary between TUI commands and the local Runtime daemon. */
export interface CronDaemonBridge {
  registerWorkspace(workspacePath: string): Promise<CronDaemonRegistration>;
  statusWorkspace(workspacePath: string): Promise<CronDaemonStatus>;
  /** Provider/config/vault deletion is daemon-owned so TUI never mutates two stores itself. */
  deleteProvider(input: ProviderDaemonDeleteInput): Promise<ProviderDaemonDeleteResult>;
  /** Trusted local IPC; the secret remains write-only and is never returned to the TUI. */
  importEnvironmentProvider?(
    input: ProviderDaemonEnvironmentImportInput,
  ): Promise<ProviderDaemonEnvironmentImportResult>;
  importAutomationCredential?(
    input: AutomationCredentialDaemonInput,
  ): Promise<CronDaemonActionResult>;
  createAutomation?(input: AutomationCreateDaemonInput): Promise<CronDaemonJobActionResult>;
  setAutomationEnabled?(
    input: AutomationJobMutationInput & { readonly enabled: boolean },
  ): Promise<CronDaemonJobActionResult>;
  deleteAutomation?(input: AutomationJobMutationInput): Promise<CronDaemonActionResult>;
}

export interface AutomationCredentialDaemonInput {
  readonly workspacePath: string;
  readonly modelRouteId: string;
  readonly expectedCredentialRef: string;
  readonly secret: string;
}

export interface AutomationCreateDaemonInput {
  readonly workspacePath: string;
  readonly name?: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly timeZone?: string;
  readonly modelRouteId: string;
  readonly expectedCredentialRef: string;
  readonly allowedTools: readonly string[];
  readonly toolNetworkPolicy: "allow" | "disabled" | "allowlist";
  readonly allowedToolNetworkHosts?: readonly string[];
  readonly enabled?: boolean;
}

export interface AutomationJobMutationInput {
  readonly workspacePath: string;
  readonly jobId: string;
}

type CronDaemonFailure = {
  readonly status: "unavailable" | "rejected";
  readonly message: string;
};

export type CronDaemonActionResult =
  | { readonly status: "ok"; readonly message: string }
  | CronDaemonFailure;

export type CronDaemonJobActionResult =
  | { readonly status: "ok"; readonly job: RuntimeJob; readonly message: string }
  | CronDaemonFailure;

export interface ProviderDaemonEnvironmentImportInput {
  readonly provider: RuntimeProviderInput;
  readonly defaultModel: string;
  readonly secret: string;
  readonly expectedRevision: string;
}

export type ProviderDaemonEnvironmentImportResult =
  | {
      readonly status: "imported";
      readonly revision: string;
      readonly message: string;
    }
  | {
      readonly status: "unavailable" | "rejected";
      readonly message: string;
    };

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
  env?: Readonly<Record<string, string | undefined>>;
  picoHome?: string;
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
    const env = options.env ?? process.env;
    const picoHome = resolveCanonicalPicoHome({ env, picoHome: options.picoHome });
    const endpoint = resolveLocalDaemonEndpoint({ env, picoHome });
    const serviceName = resolveLocalDaemonServiceName({ env, picoHome });
    this.createClient = options.createClient ?? (() => new LocalRuntimeClient(endpoint));
    this.startDaemon =
      options.startDaemon ??
      (options.createClient
        ? undefined
        : () => startOrInstallLocalDaemon({ picoHome, serviceName }));
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
          message: "本机 Runtime daemon 不可达；为避免配置与系统凭证失去同步，Provider 未删除。",
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

  async importEnvironmentProvider(
    input: ProviderDaemonEnvironmentImportInput,
  ): Promise<ProviderDaemonEnvironmentImportResult> {
    const client = this.createClient();
    try {
      try {
        await client.request("runtime.ping", {});
      } catch {
        return {
          status: "unavailable",
          message:
            "本机 Runtime daemon 不可达；为避免用户配置与系统凭证失去同步，Provider 未导入。",
        };
      }
      try {
        const value = await client.request("provider.importEnvironment", {
          provider: input.provider,
          defaultModel: input.defaultModel,
          secret: input.secret,
          expectedRevision: input.expectedRevision,
        });
        const revision = readProviderImportRevision(value);
        if (!revision) {
          return {
            status: "rejected",
            message: "Runtime daemon 返回了无效的 Provider 导入结果；Provider 状态未确认。",
          };
        }
        return {
          status: "imported",
          revision,
          message: `Provider ${input.provider.id} 已导入共享用户配置，凭证已写入系统凭证库。`,
        };
      } catch (error) {
        return {
          status: "rejected",
          message: `Provider ${input.provider.id} 未导入: ${safeDaemonMessage(error, input.secret)}`,
        };
      }
    } finally {
      client.close();
    }
  }

  async importAutomationCredential(
    input: AutomationCredentialDaemonInput,
  ): Promise<CronDaemonActionResult> {
    return this.withConnectedDaemon(
      async (client) => {
        await client.request("automation.credential.import", {
          workspacePath: input.workspacePath,
          modelRouteId: input.modelRouteId,
          expectedCredentialRef: input.expectedCredentialRef,
          secret: input.secret,
        });
        return {
          status: "ok" as const,
          message: `模型路由 ${input.modelRouteId} 的凭证已由 Runtime daemon 写入系统凭证库。`,
        };
      },
      "Automation 凭证未导入",
      input.secret,
    );
  }

  async createAutomation(input: AutomationCreateDaemonInput): Promise<CronDaemonJobActionResult> {
    return this.withConnectedDaemon(async (client) => {
      const value = await client.request("automation.create", {
        workspacePath: input.workspacePath,
        ...(input.name ? { name: input.name } : {}),
        prompt: input.prompt,
        schedule: input.schedule,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        modelRouteId: input.modelRouteId,
        expectedCredentialRef: input.expectedCredentialRef,
        allowedTools: input.allowedTools,
        toolNetworkPolicy: input.toolNetworkPolicy,
        ...(input.allowedToolNetworkHosts
          ? { allowedToolNetworkHosts: input.allowedToolNetworkHosts }
          : {}),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
      const job = readRuntimeJob(value);
      if (!job) throw new Error("Runtime daemon 返回了无效的 Automation 创建结果");
      return {
        status: "ok" as const,
        job,
        message: `Runtime daemon 已创建 Automation ${job.jobId}。`,
      };
    }, "Automation 未创建");
  }

  async setAutomationEnabled(
    input: AutomationJobMutationInput & { readonly enabled: boolean },
  ): Promise<CronDaemonJobActionResult> {
    return this.withConnectedDaemon(async (client) => {
      const value = await client.request("jobs.setEnabled", {
        workspacePath: input.workspacePath,
        jobId: input.jobId,
        enabled: input.enabled,
      });
      const job = readRuntimeJob(value);
      if (!job) throw new Error("Runtime daemon 返回了无效的 Automation 变更结果");
      return {
        status: "ok" as const,
        job,
        message: `Automation ${job.jobId} 已${job.enabled ? "启用" : "禁用"}。`,
      };
    }, `Automation ${input.jobId} 未变更`);
  }

  async deleteAutomation(input: AutomationJobMutationInput): Promise<CronDaemonActionResult> {
    return this.withConnectedDaemon(async (client) => {
      await client.request("jobs.delete", {
        workspacePath: input.workspacePath,
        jobId: input.jobId,
      });
      return {
        status: "ok" as const,
        message: `Automation ${input.jobId} 已删除。`,
      };
    }, `Automation ${input.jobId} 未删除`);
  }

  private async withConnectedDaemon<Result>(
    operation: (client: Pick<LocalRuntimeClient, "request" | "close">) => Promise<Result>,
    failureLabel: string,
    secret?: string,
  ): Promise<Result | CronDaemonFailure> {
    const client = this.createClient();
    try {
      try {
        await client.request("runtime.ping", {});
      } catch {
        return {
          status: "unavailable",
          message: `本机 Runtime daemon 不可达；${failureLabel}。`,
        };
      }
      try {
        return await operation(client);
      } catch (error) {
        return {
          status: "rejected",
          message: `${failureLabel}: ${safeDaemonMessage(error, secret)}`,
        };
      }
    } finally {
      client.close();
    }
  }
}

async function startOrInstallLocalDaemon(input: {
  picoHome: string;
  serviceName: string;
}): Promise<"installed" | "process"> {
  const daemonMain = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
  const installer = createUserDaemonInstaller();
  if (installer.install) {
    await installer.install({
      serviceName: input.serviceName,
      executable: process.execPath,
      args: [daemonMain],
      environment: { PICO_HOME: input.picoHome },
    });
    return "installed";
  }
  const child = spawn(process.execPath, [daemonMain], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PICO_HOME: input.picoHome },
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

function readProviderImportRevision(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const provider = (value as { provider?: unknown }).provider;
  const revision = (value as { revision?: unknown }).revision;
  return typeof provider === "object" &&
    provider !== null &&
    typeof revision === "string" &&
    /^[a-f0-9]{64}$/u.test(revision)
    ? revision
    : undefined;
}

function readRuntimeJob(value: unknown): RuntimeJob | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const job = (value as { job?: unknown }).job;
  if (typeof job !== "object" || job === null || Array.isArray(job)) return undefined;
  const record = job as Record<string, unknown>;
  if (
    typeof record["jobId"] !== "string" ||
    typeof record["workspacePath"] !== "string" ||
    typeof record["name"] !== "string" ||
    typeof record["prompt"] !== "string" ||
    typeof record["schedule"] !== "string" ||
    typeof record["enabled"] !== "boolean" ||
    typeof record["status"] !== "string" ||
    typeof record["updatedAt"] !== "number"
  ) {
    return undefined;
  }
  return job as RuntimeJob;
}

function safeDaemonMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutKnownSecret = secret ? message.split(secret).join("<redacted>") : message;
  return withoutKnownSecret.replace(/(api[_-]?key|token|secret)\s*[=:]\s*\S+/giu, "$1=<redacted>");
}
