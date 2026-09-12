import { type RuntimeEffectiveConfig } from "@pico/protocol";
import { type ClientSessionRuntime } from "../client-session-runtime.js";
import { resolveAutomationCredentialTarget } from "../../provider/automation-credential.js";
import { resolveModelRouteCapabilities } from "../../provider/model-capabilities.js";
import { AUTOMATION_TOOL_ALLOWLIST } from "../../safety/automation-tool-policy.js";
import { normalizeExactHostname } from "../../safety/background-autonomous-policy-schema.js";
import { AutomationCredentialImportProposalStore } from "../automation-credential-proposal.js";
import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, sessionAccess } from "./shared.js";

export function createAutomationCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const { session, needSession } = sessionAccess(runtime);
  const automationCredentialProposals =
    deps.automationCredentialProposals ?? new AutomationCredentialImportProposalStore();
  const credentialEnv = deps.credentialEnv ?? process.env;
  return {
    cron: rpcCommand({
      name: "cron",
      description: "管理此工作区的持久后台 Cron 任务",
      usage:
        "/cron <status|list|credential|add|enable|disable|delete|runs> [--tool-network=allow|disabled|allowlist:host1,host2] [arguments]",
      argumentHint: "<status|list|credential|add|enable|disable|delete|runs>",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const [operation = "list", ...args] = input.argv;
        let secretToRedact: string | undefined;
        try {
          if (operation === "status") {
            const { jobs } = await runtime.request("jobs.list", { workspacePath });
            return msg(
              `Cron：${jobs.length} 个 Job（${jobs.filter((job) => job.enabled).length} 个已启用），由常驻 daemon 调度。`,
            );
          }
          if (operation === "list") {
            const { jobs } = await runtime.request("jobs.list", { workspacePath });
            if (jobs.length === 0) return msg("没有 Cron Job。");
            return msg(
              jobs
                .map(
                  (job) =>
                    `${job.jobId} · ${job.enabled ? "enabled" : "disabled"} · ${job.schedule} · ${job.name}`,
                )
                .join("\n"),
            );
          }
          if (operation === "runs") {
            const jobId = args[0];
            if (!jobId) return msg("Usage: /cron runs <job-id>");
            const { runs } = await runtime.request("jobs.history", { workspacePath, jobId });
            if (runs.length === 0) return msg("没有运行记录。");
            return msg(
              runs
                .map(
                  (run) =>
                    `${run.runId} · ${run.status} · ${new Date(run.startedAt ?? 0).toISOString()}`,
                )
                .join("\n"),
            );
          }
          if (operation === "credential") {
            const [action = "status", ...credentialArgs] = args;
            if (action !== "status" && action !== "import") return msg(clientCronCredentialUsage());
            if (
              action === "status" &&
              (credentialArgs.length > 1 || credentialArgs[0] === "--confirm")
            ) {
              return msg(clientCronCredentialUsage());
            }
            const routeArgument = credentialArgs[0] === "--confirm" ? undefined : credentialArgs[0];
            const confirmIndex = credentialArgs[0] === "--confirm" ? 0 : 1;
            const hasConfirm = credentialArgs[confirmIndex] === "--confirm";
            const proposalId = hasConfirm ? credentialArgs[confirmIndex + 1] : undefined;
            const expectedLength = hasConfirm ? confirmIndex + 2 : routeArgument ? 1 : 0;
            if (action === "import" && credentialArgs.length !== expectedLength) {
              if (hasConfirm && !proposalId) {
                return msg("禁止裸 --confirm；请先执行预览并携带返回的 proposalId。");
              }
              return msg(clientCronCredentialUsage());
            }
            const authority = await resolveClientAutomationAuthority({
              runtime,
              workspacePath,
              requestedRouteId: routeArgument,
              activeSessionId: session(),
            });
            if (authority.route.auth === "none")
              return msg(`${authority.route.id}: 免密钥，Automation 无需导入凭据。`);
            if (action === "status") {
              return msg(
                `${authority.route.id}: Provider 凭据状态 ${authority.provider.credentialStatus}（source=${authority.provider.credentialSource}）。Automation 创建时 daemon 会按精确 credentialRef 复核系统凭据库。`,
              );
            }
            const secret = firstCredentialSecret(credentialEnv[authority.route.apiKeyEnv]);
            if (!secret) {
              return msg(`缺少凭据环境变量 ${authority.route.apiKeyEnv}，无法导入。`);
            }
            const binding = clientAutomationCredentialProposalBinding(authority, secret);
            if (!hasConfirm) {
              const proposal = automationCredentialProposals.issue(binding);
              return msg(
                [
                  `将为模型路由 ${authority.route.id} 导入当前进程的 ${authority.route.apiKeyEnv}。`,
                  "凭据将由 daemon 写入系统凭据库，值不会回显或进入命令参数。",
                  `proposalId: ${proposal.proposalId}（5 分钟内、仅可使用一次）`,
                  `确认执行：/cron credential import ${authority.route.id} --confirm ${proposal.proposalId}`,
                ].join("\n"),
              );
            }
            const confirmation = automationCredentialProposals.consume(proposalId!, binding);
            if (confirmation.status === "missing") {
              return msg("credential proposal 不存在、已使用或不属于当前命令会话；请重新预览。");
            }
            if (confirmation.status === "expired") {
              return msg("credential proposal 已过期并作废；请重新预览。");
            }
            if (confirmation.status === "changed") {
              return msg("预览后模型路由、Provider 配置或环境凭据已变化；proposal 已作废。");
            }
            secretToRedact = secret;
            await runtime.request("automation.credential.import", {
              workspacePath,
              modelRouteId: authority.route.id,
              expectedCredentialRef: authority.target.ref,
              secret,
            });
            return msg(`模型路由 ${authority.route.id} 的凭据已导入（值不回显）。`);
          }
          if (operation === "add") {
            const sid = needSession();
            if (typeof sid === "object") return sid;
            const settings = await runtime.request("session.settings.get", {
              workspacePath,
              sessionId: sid,
            });
            if (settings.settings.permissionMode !== "full-access") {
              return msg(
                "Cron jobs require /mode full-access; interactive permission modes cannot run unattended.",
              );
            }
            const toolNetwork = parseClientCronToolNetwork(args);
            if (toolNetwork.args.length < 6) {
              return msg(
                "Usage: /cron add [--tool-network=allow|disabled|allowlist:host1,host2] <minute> <hour> <day> <month> <weekday> <prompt>",
              );
            }
            const [minute, hour, day, month, weekday, ...promptParts] = toolNetwork.args;
            const prompt = promptParts.join(" ").trim();
            if (!prompt) {
              return msg(
                "Usage: /cron add [--tool-network=allow|disabled|allowlist:host1,host2] <minute> <hour> <day> <month> <weekday> <prompt>",
              );
            }
            const authority = await resolveClientAutomationAuthority({
              runtime,
              workspacePath,
              requestedRouteId: settings.settings.modelRouteId,
              activeSessionId: sid,
            });
            const { job } = await runtime.request("automation.create", {
              workspacePath,
              prompt,
              schedule: [minute, hour, day, month, weekday].join(" "),
              modelRouteId: authority.route.id,
              expectedCredentialRef: authority.target.ref,
              allowedTools: [...AUTOMATION_TOOL_ALLOWLIST],
              toolNetworkPolicy: toolNetwork.policy,
              ...(toolNetwork.allowedHosts
                ? { allowedToolNetworkHosts: toolNetwork.allowedHosts }
                : {}),
              enabled: true,
            });
            return msg(
              `Cron job created: ${job.jobId} (${job.enabled ? "enabled" : "disabled"})\n${job.schedule} · ${formatClientCronToolNetwork(toolNetwork.policy, toolNetwork.allowedHosts)}`,
            );
          }
          const jobId = args[0];
          if (!jobId) return msg(`Usage: /cron ${operation} <job-id>`);
          if (operation === "enable" || operation === "disable") {
            const { job } = await runtime.request("jobs.setEnabled", {
              workspacePath,
              jobId,
              enabled: operation === "enable",
            });
            return msg(`Cron job ${job.jobId} 已${operation === "enable" ? "启用" : "停用"}。`);
          }
          if (operation === "delete") {
            const { deleted } = await runtime.request("jobs.delete", { workspacePath, jobId });
            return msg(deleted ? `Cron job ${jobId} 已删除。` : `Cron job ${jobId} 不存在。`);
          }
          return msg(
            "Usage: /cron <status|list|credential|add|enable|disable|delete|runs> [arguments]",
          );
        } catch (error) {
          return msg(`Cron failed: ${safeClientCommandError(error, secretToRedact)}`);
        }
      },
    }),
  };
}

type ClientAutomationAuthority = {
  readonly route: {
    readonly id: string;
    readonly providerId: string;
    readonly provider: "openai" | "claude" | "responses";
    readonly model: string;
    readonly baseURL: string;
    readonly apiKeyEnv: string;
    readonly auth?: "api-key" | "none";
    readonly source: "config";
    readonly capabilities: ReturnType<typeof resolveModelRouteCapabilities>;
  };
  readonly provider: RuntimeEffectiveConfig["providers"][number];
  readonly target: ReturnType<typeof resolveAutomationCredentialTarget>;
};

function clientAutomationCredentialProposalBinding(
  authority: ClientAutomationAuthority,
  secret: string,
) {
  return {
    routeId: authority.route.id,
    providerId: authority.route.providerId,
    credentialRef: authority.target.ref,
    providerProtocol: authority.route.provider,
    model: authority.route.model,
    baseURL: authority.route.baseURL,
    apiKeyEnv: authority.route.apiKeyEnv,
    providerConfigFingerprint: authority.provider.fingerprint,
    secret,
  };
}

function clientCronCredentialUsage(): string {
  return "Usage: /cron credential <status|import> [provider/model] [--confirm <proposalId>]";
}

async function resolveClientAutomationAuthority(input: {
  readonly runtime: ClientSessionRuntime;
  readonly workspacePath: string;
  readonly requestedRouteId?: string;
  readonly activeSessionId?: string;
}): Promise<ClientAutomationAuthority> {
  const [effectiveResult, userResult, sessionResult] = await Promise.all([
    input.runtime.request("config.effective.get", { workspacePath: input.workspacePath }),
    input.runtime.request("config.user.get", {}),
    input.requestedRouteId === undefined && input.activeSessionId
      ? input.runtime.request("session.settings.get", {
          workspacePath: input.workspacePath,
          sessionId: input.activeSessionId,
        })
      : undefined,
  ]);
  const routeId =
    input.requestedRouteId ??
    sessionResult?.settings.modelRouteId ??
    effectiveResult.config.defaultModelRouteId;
  if (!routeId) throw new Error("当前没有可用模型路由。");
  const separator = routeId.indexOf("/");
  if (separator <= 0 || separator === routeId.length - 1) {
    throw new Error("模型路由必须采用 providerID/modelID 格式。");
  }
  const providerId = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  const provider = effectiveResult.config.providers.find((entry) => entry.id === providerId);
  if (!provider || !provider.models.includes(model)) {
    throw new Error(`模型路由 ${routeId} 不存在，请刷新配置后重试。`);
  }
  const route = {
    id: routeId,
    providerId,
    provider: provider.modelProtocols?.[model] ?? provider.protocol,
    model,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    ...(provider.auth ? { auth: provider.auth } : {}),
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities(
      provider.modelProtocols?.[model] ?? provider.protocol,
      model,
      undefined,
      {
        baseURL: provider.baseURL,
      },
    ),
  };
  const userProviderRecord = userResult.config.providers.find((entry) => entry.id === providerId);
  const userProvider = userProviderRecord
    ? {
        protocol: userProviderRecord.protocol,
        ...(userProviderRecord.modelProtocols
          ? { modelProtocols: userProviderRecord.modelProtocols }
          : {}),
        baseURL: userProviderRecord.baseURL,
        apiKeyEnv: userProviderRecord.apiKeyEnv,
        ...(userProviderRecord.auth ? { auth: userProviderRecord.auth } : {}),
        models: userProviderRecord.models,
        discoverModels: userProviderRecord.discoverModels,
      }
    : undefined;
  const source = effectiveResult.config.sources[`providers.${providerId}`];
  const target = resolveAutomationCredentialTarget({
    route,
    ...(userProvider ? { userProvider } : {}),
    ...(typeof source === "string"
      ? { configSource: source as "user" | "environment" | "session" | "cli" }
      : {}),
  });
  return { route, provider, target };
}

function firstCredentialSecret(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function parseClientCronToolNetwork(args: readonly string[]): {
  readonly args: readonly string[];
  readonly policy: "allow" | "disabled" | "allowlist";
  readonly allowedHosts?: readonly string[];
} {
  const option = args[0];
  if (!option?.startsWith("--tool-network=")) return { args, policy: "allow" };
  const value = option.slice("--tool-network=".length);
  if (value === "allow") return { args: args.slice(1), policy: "allow" };
  if (value === "disabled") return { args: args.slice(1), policy: "disabled" };
  if (value.startsWith("allowlist:")) {
    const allowedHosts = [
      ...new Set(value.slice("allowlist:".length).split(",").map(normalizeExactHostname)),
    ];
    if (allowedHosts.length === 0) throw new Error("工具网络 allowlist 不能为空。");
    return { args: args.slice(1), policy: "allowlist", allowedHosts };
  }
  throw new Error(
    "工具网络策略必须是 allow、disabled 或 allowlist:host1,host2；它不控制模型 Provider 网络。",
  );
}

function formatClientCronToolNetwork(
  policy: "allow" | "disabled" | "allowlist",
  allowedHosts?: readonly string[],
): string {
  return policy === "disabled"
    ? "工具网络：关闭（模型 Provider 网络不受此项控制）"
    : policy === "allow"
      ? "工具网络：允许所有符合后台资格的工具联网（模型 Provider 网络独立）"
      : `工具网络：仅允许 ${allowedHosts?.join(", ") ?? "<invalid>"}（模型 Provider 网络不受此项控制）`;
}

function safeClientCommandError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutKnownSecret = secret ? message.replaceAll(secret, "<redacted>") : message;
  return withoutKnownSecret.replace(/(api[_-]?key|token|secret)\s*[=:]\s*\S+/giu, "$1=<redacted>");
}
