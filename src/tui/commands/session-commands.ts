import { type SlashCommand } from "../../input/types.js";
import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, cachedArgumentCompleter, sessionAccess } from "./shared.js";

export function createSessionCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const { session, needSession } = sessionAccess(runtime);
  const sessionCompleter = cachedArgumentCompleter(
    async () => runtime.request("session.list", { workspacePath }),
    (result) =>
      result.sessions.map((entry) => ({
        value: entry.sessionId,
        label: entry.title || entry.sessionId,
        description: new Date(entry.updatedAt).toLocaleString(),
      })),
  );
  return {
    status: rpcCommand({
      name: "status",
      aliases: ["st"],
      description: "查看会话与配置状态",
      usage: "/status",
      category: "session",
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
            `编排模式：${settings.settings.orchestrationMode ?? "default"}`,
          ].join(" · "),
        };
      },
    }),
    goal: rpcCommand({
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
    rename: rpcCommand({
      name: "rename",
      description: "重命名当前会话",
      usage: "/rename <title>",
      argumentHint: "<title>",
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
    compact: rpcCommand({
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
    context: rpcCommand({
      name: "context",
      description: "Show the active route context budget and capabilities",
      usage: "/context",
      category: "model",
      availability: "always",
      execute: async (input) => {
        if (input.args.trim()) {
          return { type: "local", action: "message", message: "Usage: /context" };
        }
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("session.context.get", {
          workspacePath,
          sessionId: sid,
        });
        return {
          type: "local",
          action: "message",
          message: formatContextReport(result.context),
          data: result.context,
        };
      },
    }),
    usage: rpcCommand({
      name: "usage",
      description: "查看用量",
      usage: "/usage",
      category: "model",
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
    sessions: rpcCommand({
      name: "sessions",
      aliases: ["session-list"],
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
    resume: rpcCommand({
      name: "resume",
      description: "恢复指定会话",
      usage: "/resume <session-id>",
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
      argumentCompleter: sessionCompleter,
      execute: async (input) => {
        const target = input.argv[0];
        if (!target)
          return { type: "local", action: "message", message: "Usage: /resume <session-id>" };
        try {
          await runtime.request("session.get", { workspacePath, sessionId: target });
        } catch {
          return { type: "local", action: "message", message: `会话 ${target} 不存在。` };
        }
        await runtime.switchSession(target);
        return { type: "local", action: "message", message: `已切换到会话 ${target}。` };
      },
    }),
    fork: rpcCommand({
      name: "fork",
      description: "分叉指定会话",
      usage: "/fork <session-id>",
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
      argumentCompleter: sessionCompleter,
      execute: async (input) => {
        const target = input.argv[0];
        if (!target)
          return { type: "local", action: "message", message: "Usage: /fork <session-id>" };
        try {
          const result = await runtime.request("session.fork", {
            workspacePath,
            sessionId: target,
          });
          await runtime.switchSession(result.session.sessionId);
          let inheritedLabel = "继承设置已固化";
          try {
            const inherited = await runtime.request("session.settings.get", {
              workspacePath,
              sessionId: result.session.sessionId,
            });
            inheritedLabel = `继承协作 ${inherited.settings.collaborationMode} · 权限 ${inherited.settings.permissionMode}`;
          } catch {
            inheritedLabel = "已继承源会话设置（暂无法读取展示）";
          }
          return {
            type: "local",
            action: "message",
            message: `已分叉 ${target} → ${result.session.sessionId} 并切换；${inheritedLabel}。`,
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
    new: rpcCommand({
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
    running: createRunningInputCommands(deps),
  };
}

function formatUsage(usage: unknown): string {
  // 用量报告的累计值在 usage.total 中。
  if (usage === null || typeof usage !== "object") return "(无用量数据)";
  const total = (usage as Record<string, unknown>)["total"];
  if (total === null || typeof total !== "object") return "(无用量数据)";
  const record = total as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "totalTokens"]) {
    const value = record[key];
    if (typeof value === "number") parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? `用量：${parts.join(" · ")}` : "(无用量数据)";
}

function formatContextReport(context: unknown): string {
  if (context === null || typeof context !== "object") return "(无上下文数据)";
  const record = context as Record<string, unknown>;
  const capabilities = record["capabilities"];
  const capabilityText =
    capabilities !== null && typeof capabilities === "object"
      ? [
          (capabilities as Record<string, unknown>)["vision"] === true ? "vision" : undefined,
          (capabilities as Record<string, unknown>)["reasoning"] === true ? "reasoning" : undefined,
          (capabilities as Record<string, unknown>)["toolCall"] === true ? "tool-call" : undefined,
          (capabilities as Record<string, unknown>)["cache"] === true ? "cache" : undefined,
        ]
          .filter(Boolean)
          .join(",")
      : "";
  const numberField = (key: string): string => {
    const value = record[key];
    return typeof value === "number" ? String(value) : "?";
  };
  return [
    `Context (${String(record["routeId"] ?? "?")})`,
    `  estimated=${numberField("estimatedInputTokens")} · budget=${numberField("inputBudgetTokens")} · remaining=${numberField("remainingTokens")}`,
    `  window=${numberField("contextWindowTokens")} · reserved=${numberField("reservedOutputTokens")} · used=${numberField("usedPercent")}%`,
    ...(capabilityText ? [`  capabilities: ${capabilityText}`] : []),
  ].join("\n");
}

function createRunningInputCommands(deps: ClientCommandRegistryDeps): readonly SlashCommand[] {
  const { runtime } = deps;
  const behaviorCommand = (
    name: "steer" | "queue" | "replace",
    description: string,
    usage: string,
  ): SlashCommand =>
    rpcCommand({
      name,
      description,
      usage,
      argumentHint: "<text>",
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
