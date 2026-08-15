import type { RuntimeMethod, RuntimeParams, RuntimeResult } from "@pico/protocol";
import { CommandRegistry, type RegistrySlashCommand } from "../input/command-registry.js";
import { createBuiltinCommands } from "../input/builtin-commands.js";
import { processUserInput } from "../input/process-user-input.js";
import { parseSlashInput } from "../input/slash-parser.js";
import { getCommandAvailability } from "../input/command-availability.js";
import type {
  InputProcessResult,
  LocalCommandResult,
  SlashCommand,
} from "../input/types.js";
import type { ClientSessionRuntime } from "./client-session-runtime.js";

/**
 * TUI 客户端斜杠命令注册表（3-D Phase 3 tier1，29 命令）。
 *
 * 复用 in-process 的解析/建议管线（parseSlashInput + CommandRegistry + 输入框
 * 建议源），命令元数据（name/aliases/usage/category/availability）镜像
 * src/input/pico-command-registry.ts，执行体换成 daemon RPC（经
 * ClientSessionRuntime.request 透传）。选择器结果沿用 LocalCommandResult 的
 * ui.open-selector/data 词汇，宿主（client-command-host）用数据化组件渲染。
 *
 * 延后（协议/边界缺口，下批）：/provider（import-env 凭据流）、/cron（add 应走
 * automation.create 而非 jobs.create + yolo 门）、/memory remember（协议无
 * memory.create）。/rewind /changes /context /operations 不在本批。
 */

export interface ClientCommandRegistryDeps {
  readonly runtime: ClientSessionRuntime;
  readonly workspacePath: string;
}

export interface ClientInputOutcome {
  readonly kind: "local" | "unknown" | "sent" | "rejected";
  readonly result?: LocalCommandResult;
  readonly message?: string;
}

export function createClientCommandRegistry(deps: ClientCommandRegistryDeps): CommandRegistry {
  const { runtime, workspacePath } = deps;
  const session = (): string | undefined => runtime.activeSessionId;
  const needSession = (): string | LocalCommandResult => {
    const id = session();
    return id === undefined
      ? { type: "local", action: "message", message: "当前没有活跃会话；先发送一条消息或 /resume。" }
      : id;
  };

  const commands: readonly SlashCommand[] = [
    // builtin 的 /skill 是"生成提示语"兜底——客户端版走 session.send 原生
    // skill input kind（daemon 解析），此处过滤让客户端版生效。
    ...createBuiltinCommands().filter((command) => command.name !== "skill"),
    rpcCommand({
      name: "model",
      description: "查看或切换模型路由",
      usage: "/model [route]",
      argumentHint: "<provider/model|model>",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        const configured = await runtime.request("config.effective.get", { workspacePath });
        const routes = modelRoutesFromConfig(configured);
        const target = input.argv[0];
        if (target === undefined) {
          return {
            type: "local",
            action: "model",
            ui: { kind: "open-selector", selector: "model" },
            data: { modelRoutes: routes },
            message: `当前默认路由：${configured.defaultModelRouteId ?? "(未设置)"}`,
          };
        }
        const matched = routes.find(
          (route) => route.id === target || route.name === target,
        );
        if (!matched) {
          return {
            type: "local",
            action: "message",
            message: `未知模型路由 ${target}。可用：${routes.map((route) => route.id).join("、") || "(无)"}。`,
          };
        }
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const updated = await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          modelRouteId: matched.id,
        });
        return {
          type: "local",
          action: "model",
          message: `模型路由已切换：${updated.settings.modelRouteId ?? matched.id}`,
        };
      },
    }),
    rpcCommand({
      name: "thinking",
      description: "查看或设置思考强度",
      usage: "/thinking [off|low|medium|high]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const current = await runtime.request("session.settings.get", { workspacePath, sessionId: sid });
        const levels = current.settings.reasoningLevels ?? [];
        const target = input.argv[0];
        if (target === undefined) {
          return {
            type: "local",
            action: "thinking",
            message: `当前思考强度：${current.settings.thinkingEffort ?? "(默认)"}。可选：${levels.join("、") || "(跟随模型)"}。`,
          };
        }
        if (levels.length > 0 && !levels.includes(target)) {
          return {
            type: "local",
            action: "message",
            message: `未知思考强度 ${target}。可选：${levels.join("、")}。`,
          };
        }
        const updated = await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          thinkingEffort: target,
        });
        return {
          type: "local",
          action: "thinking",
          message: `思考强度已设置：${updated.settings.thinkingEffort ?? target}`,
        };
      },
    }),
    rpcCommand({
      name: "mode",
      description: "查看或切换协作模式",
      usage: "/mode [agent|plan]",
      category: "permissions",
      availability: "idle",
      argumentCompleter: staticCompleter(["agent", "plan"]),
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const target = input.argv[0];
        if (target === undefined) {
          const current = await runtime.request("session.settings.get", { workspacePath, sessionId: sid });
          return {
            type: "local",
            action: "message",
            message: `协作模式：${current.settings.collaborationMode ?? "agent"}`,
          };
        }
        if (target !== "agent" && target !== "plan") {
          return { type: "local", action: "message", message: "Usage: /mode [agent|plan]" };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          collaborationMode: target,
        });
        return { type: "local", action: "message", message: `协作模式已切换：${target}` };
      },
    }),
    rpcCommand({
      name: "plan",
      description: "进入或退出计划模式",
      usage: "/plan [on|off]",
      category: "permissions",
      availability: "idle",
      argumentCompleter: staticCompleter(["on", "off"]),
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const target = input.argv[0] ?? "on";
        if (target !== "on" && target !== "off") {
          return { type: "local", action: "message", message: "Usage: /plan [on|off]" };
        }
        // in-process 版在 off 时校验 pending 提案（PlanCoordinator）；daemon 侧
        // 对计划状态一致性自保护，客户端 v1 直接切换。
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          collaborationMode: target === "on" ? "plan" : "agent",
        });
        return {
          type: "local",
          action: "message",
          message: target === "on" ? "已进入计划模式。" : "已退出计划模式。",
        };
      },
    }),
    rpcCommand({
      name: "permissions",
      description: "查看或设置权限模式",
      usage: "/permissions [default|auto|yolo|plan]",
      category: "permissions",
      availability: "idle",
      argumentCompleter: staticCompleter(["default", "auto", "yolo", "plan"]),
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const target = input.argv[0];
        if (target === undefined) {
          const current = await runtime.request("session.settings.get", { workspacePath, sessionId: sid });
          return {
            type: "local",
            action: "message",
            message: `权限模式：${current.settings.permissionMode ?? "default"}`,
          };
        }
        if (!["default", "auto", "yolo", "plan"].includes(target)) {
          return {
            type: "local",
            action: "message",
            message: "Usage: /permissions [default|auto|yolo|plan]",
          };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          permissionMode: target as "default" | "auto" | "yolo" | "plan",
        });
        return { type: "local", action: "message", message: `权限模式已设置：${target}` };
      },
    }),
    rpcCommand({
      name: "graph",
      description: "查看或切换 Graph Mode",
      usage: "/graph [on|off]",
      category: "session",
      availability: "idle",
      argumentCompleter: staticCompleter(["on", "off"]),
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const target = input.argv[0];
        if (target === undefined) {
          const current = await runtime.request("session.settings.get", { workspacePath, sessionId: sid });
          return {
            type: "local",
            action: "message",
            message: `Graph Mode：${current.settings.orchestrationMode === "graph" ? "开启" : "关闭"}`,
          };
        }
        if (target !== "on" && target !== "off") {
          return { type: "local", action: "message", message: "Usage: /graph [on|off]" };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          orchestrationMode: target === "on" ? "graph" : "default",
        });
        return {
          type: "local",
          action: "message",
          message: target === "on" ? "Graph Mode 已开启。" : "Graph Mode 已关闭。",
        };
      },
    }),
    rpcCommand({
      name: "status",
      description: "查看会话与配置状态",
      usage: "/status",
      category: "help",
      availability: "always",
      execute: async () => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const [sessionInfo, settings] = await Promise.all([
          runtime.request("session.get", { workspacePath, sessionId: sid }),
          runtime.request("session.settings.get", { workspacePath, sessionId: sid }),
        ]);
        return {
          type: "local",
          action: "status",
          message: [
            `会话：${sessionInfo.session.title || sid}`,
            `模型路由：${settings.settings.modelRouteId ?? "(默认)"}`,
            `思考强度：${settings.settings.thinkingEffort ?? "(默认)"}`,
            `协作模式：${settings.settings.collaborationMode ?? "agent"}`,
            `权限模式：${settings.settings.permissionMode ?? "default"}`,
            `Graph：${settings.settings.orchestrationMode === "graph" ? "开" : "关"}`,
          ].join(" · "),
        };
      },
    }),
    rpcCommand({
      name: "goal",
      description: "查看当前目标",
      usage: "/goal",
      category: "session",
      availability: "always",
      execute: async () => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("goal.get", { workspacePath, sessionId: sid });
        if (!result.goal || result.goal.activeGoalId === null) {
          return { type: "local", action: "message", message: "当前没有活跃目标。" };
        }
        const goals = result.goal.goals
          .map((goal) => `· [${goal.status}] ${goal.title ?? goal.description ?? goal.id}`)
          .join("\n");
        return {
          type: "local",
          action: "message",
          message: `活跃目标 ${result.goal.activeGoalId}：\n${goals || "(无明细)"}`,
        };
      },
    }),
    rpcCommand({
      name: "rename",
      description: "重命名当前会话",
      usage: "/rename <title>",
      category: "session",
      availability: "idle",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const title = input.args.trim();
        if (!title) return { type: "local", action: "message", message: "Usage: /rename <title>" };
        const result = await runtime.request("session.rename", {
          workspacePath,
          sessionId: sid,
          title,
        });
        return {
          type: "local",
          action: "message",
          message: `会话已重命名：${result.session.title ?? title}`,
        };
      },
    }),
    rpcCommand({
      name: "compact",
      description: "压缩当前会话上下文（daemon 侧执行）",
      usage: "/compact",
      category: "session",
      availability: "idle",
      execute: async () => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("session.compact", { workspacePath, sessionId: sid });
        return {
          type: "local",
          action: "message",
          message: result.compacted
            ? `已压缩：${result.beforeMessageCount} → ${result.afterMessageCount} 条消息。`
            : "没有可压缩的内容。",
        };
      },
    }),
    rpcCommand({
      name: "init",
      description: "生成项目上下文文件（daemon 侧执行）",
      usage: "/init",
      category: "workspace",
      availability: "idle",
      execute: async () => {
        const result = await runtime.request("workspace.init", { workspacePath });
        return {
          type: "local",
          action: "message",
          message: `${result.message ?? "初始化完成"}（${result.files?.length ?? 0} 个文件）`,
        };
      },
    }),
    rpcCommand({
      name: "doctor",
      description: "运行诊断",
      usage: "/doctor [resources]",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        if (input.argv[0] === "resources") {
          const result = await runtime.request("diagnostics.resources", { workspacePath });
          return { type: "local", action: "message", message: renderReportOutput(result.output) };
        }
        const result = await runtime.request("diagnostics.run", { workspacePath });
        return { type: "local", action: "message", message: renderReportOutput(result.output) };
      },
    }),
    rpcCommand({
      name: "usage",
      description: "查看用量",
      usage: "/usage",
      category: "help",
      availability: "always",
      execute: async () => {
        const sid = session();
        const result = await runtime.request("usage.get", {
          workspacePath,
          ...(sid ? { sessionId: sid } : {}),
        });
        return { type: "local", action: "message", message: formatUsage(result.usage) };
      },
    }),
    rpcCommand({
      name: "sessions",
      description: "列出工作区会话",
      usage: "/sessions",
      category: "session",
      availability: "idle",
      execute: async () => {
        const result = await runtime.request("session.list", { workspacePath });
        const current = session();
        return {
          type: "local",
          action: "resume",
          ui: { kind: "open-selector", selector: "session" },
          data: result.sessions.map((entry) => ({
            id: entry.sessionId,
            cwd: entry.workspacePath,
            createdAt: new Date(entry.createdAt),
            updatedAt: new Date(entry.updatedAt),
            title: entry.title,
            isCurrent: entry.sessionId === current,
          })),
        };
      },
    }),
    rpcCommand({
      name: "resume",
      description: "恢复指定会话",
      usage: "/resume <session-id>",
      category: "session",
      availability: "idle",
      execute: async (input) => {
        const target = input.argv[0];
        if (!target) return { type: "local", action: "message", message: "Usage: /resume <session-id>" };
        try {
          await runtime.request("session.get", { workspacePath, sessionId: target });
        } catch {
          return { type: "local", action: "message", message: `会话 ${target} 不存在。` };
        }
        await runtime.switchSession(target);
        return { type: "local", action: "message", message: `已切换到会话 ${target}。` };
      },
    }),
    rpcCommand({
      name: "fork",
      description: "分叉指定会话",
      usage: "/fork <session-id>",
      category: "session",
      availability: "idle",
      execute: async (input) => {
        const target = input.argv[0];
        if (!target) return { type: "local", action: "message", message: "Usage: /fork <session-id>" };
        try {
          const result = await runtime.request("session.fork", {
            workspacePath,
            sessionId: target,
          });
          await runtime.switchSession(result.session.sessionId);
          return {
            type: "local",
            action: "message",
            message: `已分叉 ${target} → ${result.session.sessionId} 并切换。`,
          };
        } catch (error) {
          return {
            type: "local",
            action: "message",
            message: `分叉失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    }),
    rpcCommand({
      name: "new",
      description: "开始新会话（下次发送时创建）",
      usage: "/new",
      category: "session",
      availability: "idle",
      execute: async () => {
        await runtime.switchSession(undefined);
        runtime.clearTranscript();
        return { type: "local", action: "resume", data: { mode: "new" } };
      },
    }),
    ...createRunningInputCommands(deps),
    rpcCommand({
      name: "skill",
      description: "请求 agent 使用指定技能（daemon 侧解析）",
      usage: "/skill <name> [args]",
      category: "skill",
      availability: "always",
      execute: async (input) => {
        const skillName = input.argv[0];
        if (skillName === undefined) {
          return { type: "local", action: "message", message: "Usage: /skill <name> [args]" };
        }
        const args = input.argv.slice(1).join(" ");
        const sent = await runtime.sendInput({ kind: "skill", name: skillName, ...(args ? { args } : {}) });
        return sent
          ? { type: "local", action: "message", message: `技能 ${skillName} 已提交。` }
          : { type: "local", action: "message", message: `技能 ${skillName} 提交失败。` };
      },
    }),
    rpcCommand({
      name: "agent",
      description: "派发命名 agent 任务（daemon 侧解析）",
      usage: "/agent <name> <task>",
      category: "agent",
      availability: "always",
      execute: async (input) => {
        const agentName = input.argv[0];
        const task = input.argv.slice(1).join(" ");
        if (!agentName || !task) {
          return { type: "local", action: "message", message: "Usage: /agent <name> <task>" };
        }
        const sent = await runtime.sendInput({ kind: "agent", name: agentName, task });
        return sent
          ? { type: "local", action: "message", message: `Agent ${agentName} 任务已提交。` }
          : { type: "local", action: "message", message: `Agent ${agentName} 任务提交失败。` };
      },
    }),
    rpcCommand({
      name: "skills",
      description: "列出可用技能",
      usage: "/skills",
      category: "skill",
      availability: "always",
      execute: async () => {
        const result = await runtime.request("skills.effective.list", { workspacePath });
        const names = (result.skills as readonly { name?: string }[])
          .map((skill) => skill.name ?? "(unnamed)")
          .join("、");
        return {
          type: "local",
          action: "skills",
          message: names ? `可用技能：${names}` : "没有可用技能。",
        };
      },
    }),
    rpcCommand({
      name: "agents",
      description: "列出可用 agent",
      usage: "/agents",
      category: "agent",
      availability: "always",
      execute: async () => {
        const result = await runtime.request("catalog.agents", { workspacePath });
        const names = result.agents.map((agent) => agent.name).join("、");
        return {
          type: "local",
          action: "agents",
          message: names ? `可用 agent：${names}` : "没有可用 agent。",
        };
      },
    }),
    rpcCommand({
      name: "explore",
      description: "（已弃用）仓库探索已内建",
      usage: "/explore",
      category: "workspace",
      availability: "always",
      execute: async () => ({
        type: "local",
        action: "message",
        message: "仓库探索已内建：直接描述目标，agent 会自行扫描代码库。",
      }),
    }),
  ];
  return new CommandRegistry(commands as readonly RegistrySlashCommand[]);
}

/** /steer /queue /replace /interrupt——运行中输入行为（availability: running）。 */
function createRunningInputCommands(
  deps: ClientCommandRegistryDeps,
): readonly SlashCommand[] {
  const { runtime, workspacePath } = deps;
  const behaviorCommand = (
    name: "steer" | "queue" | "replace",
    description: string,
    usage: string,
  ): SlashCommand =>
    rpcCommand({
      name,
      description,
      usage,
      category: "session",
      availability: "running",
      execute: async (input) => {
        const text = input.args.trim();
        if (!text) return { type: "local", action: "message", message: `Usage: ${usage}` };
        const sent = await runtime.sendText(text, name);
        return sent
          ? { type: "local", action: "message", message: `已${description}。` }
          : { type: "local", action: "message", message: `${description}失败。` };
      },
    });
  return [
    behaviorCommand("steer", "转向当前 run", "/steer <guidance>"),
    behaviorCommand("queue", "排队下一条输入", "/queue <prompt>"),
    behaviorCommand("replace", "替换当前 run", "/replace <prompt>"),
    rpcCommand({
      name: "interrupt",
      aliases: ["stop"],
      description: "中断当前 run",
      usage: "/interrupt",
      category: "session",
      availability: "running",
      execute: async () => {
        await runtime.interrupt();
        return { type: "local", action: "message", message: "已请求中断。" };
      },
    }),
  ];
}

/** 处理一条输入：slash → availability 门 + 客户端注册表；非 slash → session.send。 */
export async function processClientInput(
  input: string,
  registry: CommandRegistry,
  runtime: ClientSessionRuntime,
): Promise<ClientInputOutcome> {
  // availability 门（in-process 在 repl.processTuiInput，客户端在此对等实现）：
  // running-only 命令 idle 时、idle-only 命令 running时拦截，不发 RPC。
  const parsed = parseSlashInput(input);
  if (parsed) {
    const command = registry.resolve(parsed.name);
    if (command) {
      const state: "idle" | "running" = runtime.running ? "running" : "idle";
      const availability = getCommandAvailability(command, state);
      if (!availability.available) {
        return {
          kind: "local",
          result: { type: "local", action: "message", message: `/${command.name} ${availability.disabledReason ?? "当前不可用。"}` },
        };
      }
    }
  }
  const processed: InputProcessResult = await processUserInput(input, { registry });
  switch (processed.type) {
    case "empty":
      return { kind: "rejected" };
    case "prompt":
      return (await runtime.sendText(processed.prompt)) ? { kind: "sent" } : { kind: "rejected" };
    case "local-command":
      return { kind: "local", result: processed.result };
    case "prompt-command": {
      // 客户端注册表的 /skill /agent 走 sendInput；此分支只剩 builtin /skill
      // 兜底（无本地解析），按文本上送。
      const sent = await runtime.sendText(processed.result.prompt);
      return sent ? { kind: "sent" } : { kind: "rejected" };
    }
    case "unknown-command":
      return { kind: "unknown", message: processed.message };
    default:
      return { kind: "rejected" };
  }
}

export interface ClientInputOutcome {
  readonly kind: "local" | "unknown" | "sent" | "rejected";
  readonly result?: LocalCommandResult;
  readonly message?: string;
}

function rpcCommand(spec: SlashCommand): SlashCommand {
  return { ...spec, kind: spec.kind ?? "local" };
}

function staticCompleter(values: readonly string[]) {
  return (query: string): readonly { value: string }[] =>
    values
      .filter((value) => value.startsWith(query.toLowerCase()))
      .map((value) => ({ value }));
}

function modelRoutesFromConfig(config: RuntimeResult<"config.effective.get">): {
  id: string;
  name: string;
}[] {
  const routes: { id: string; name: string }[] = [];
  for (const provider of config.providers ?? []) {
    const record = provider as Record<string, unknown>;
    const providerId = typeof record["id"] === "string" ? record["id"] : undefined;
    for (const model of record["models"] ?? []) {
      if (typeof model === "string" && providerId) {
        routes.push({ id: `${providerId}/${model}`, name: model });
      }
    }
  }
  return routes;
}

function renderReportOutput(output: unknown): string {
  return Array.isArray(output) ? output.map(String).join("\n") : String(output ?? "(无输出)");
}

function formatUsage(usage: unknown): string {
  if (usage === null || typeof usage !== "object") return "(无用量数据)";
  const record = usage as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cost"]) {
    const value = record[key];
    if (typeof value === "number") parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? `用量：${parts.join(" · ")}` : "(无用量数据)";
}
