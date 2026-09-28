import type { RuntimeSessionContextSnapshot } from "@pico/protocol";
import { type SlashCommand } from "./command-contracts.js";
import type { RpcCommandRuntime } from "./rpc-command-runtime.js";
import { rpcCommand, cachedArgumentCompleter, sessionAccess } from "./command-helpers.js";

export interface SessionCommandRuntime extends RpcCommandRuntime {
  switchSession(sessionId: string | undefined): Promise<void>;
  clearTranscript(): void;
  sendText(text: string, behavior?: "auto" | "steer" | "queue" | "replace"): Promise<boolean>;
  interrupt(): Promise<void>;
}

export interface SessionCommandRegistryDeps {
  readonly runtime: SessionCommandRuntime;
  readonly workspacePath: string;
}

export function createSessionCommands(deps: SessionCommandRegistryDeps) {
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
            `权限模式：${settings.settings.permissionMode ?? "ask"}`,
            `编排模式：${settings.settings.orchestrationMode ?? "default"}`,
          ].join(" · "),
        };
      },
    }),
    goal: rpcCommand({
      name: "goal",
      description: "查看或控制当前长程目标",
      usage: "/goal [pause|resume|clear [id]|arm 标题 | 描述 | 完成标准; 完成标准]",
      category: "session",
      availability: "always",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const args = input.args.trim();
        const [action, ...rest] = args.split(/\s+/u);
        if (action === "arm") {
          const fields = args
            .slice("arm".length)
            .trim()
            .split("|")
            .map((field) => field.trim());
          if (fields.length < 3 || fields.slice(0, 2).some((field) => !field)) {
            return {
              type: "local",
              action: "message",
              message: "Usage: /goal arm <标题> | <描述> | <完成标准; 完成标准>",
            };
          }
          const completionCriteria = fields[2]!
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean);
          const result = await runtime.request("goal.control", {
            workspacePath,
            sessionId: sid,
            action: "arm",
            title: fields[0]!,
            description: fields[1]!,
            completionCriteria,
          });
          return {
            type: "local",
            action: "message",
            message: `Goal 已设为 active，将在下一次普通用户消息开始执行：\n${formatGoalSnapshot(result.goal)}`,
          };
        }
        if (action === "pause" || action === "resume" || action === "clear") {
          const goalId = rest[0];
          const result = await runtime.request("goal.control", {
            workspacePath,
            sessionId: sid,
            action,
            ...(goalId ? { goalId } : {}),
          });
          return {
            type: "local",
            action: "message",
            message: `Goal ${action} 已处理：\n${formatGoalSnapshot(result.goal)}`,
          };
        }
        if (args)
          return {
            type: "local",
            action: "message",
            message: "Usage: /goal [pause|resume|clear [id]|arm 标题 | 描述 | 完成标准; 完成标准]",
          };
        const result = await runtime.request("goal.get", { workspacePath, sessionId: sid });
        if (!result.goal || result.goal.goals.length === 0) {
          return { type: "local", action: "message", message: "当前没有活跃目标。" };
        }
        return {
          type: "local",
          action: "message",
          message: `当前目标：\n${formatGoalSnapshot(result.goal)}`,
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
      description: "查看最近请求实际用量与当前模型历史",
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

function formatGoalSnapshot(snapshot: {
  readonly activeGoalId: string | null;
  readonly goals: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly completionCriteria: readonly string[];
    readonly budgetUsage: {
      readonly turns: number;
      readonly tokens: number;
      readonly costCNY: number;
    };
    readonly maxIterations: number;
    readonly lastEvaluation?: { readonly outcome: string; readonly reason: string };
    readonly evidence: readonly string[];
    readonly waitingReason?: string;
    readonly blockedReason?: string;
  }[];
}): string {
  return snapshot.goals
    .map((goal) =>
      [
        `· [${goal.status}] ${goal.title} (${goal.id})${snapshot.activeGoalId === goal.id ? " · 当前" : ""}`,
        `  迭代 ${goal.budgetUsage.turns}/${goal.maxIterations} · ${goal.budgetUsage.tokens} tokens · ¥${goal.budgetUsage.costCNY.toFixed(4)}`,
        `  标准：${goal.completionCriteria.join("；")}`,
        ...(goal.lastEvaluation
          ? [`  最近评估：${goal.lastEvaluation.outcome} · ${goal.lastEvaluation.reason}`]
          : []),
        ...(goal.waitingReason ? [`  等待：${goal.waitingReason}`] : []),
        ...(goal.blockedReason ? [`  终止原因：${goal.blockedReason}`] : []),
        ...(goal.evidence.length ? [`  证据：${goal.evidence.slice(-3).join("；")}`] : []),
      ].join("\n"),
    )
    .join("\n");
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

function formatContextReport(context: RuntimeSessionContextSnapshot): string {
  const request = context.latestRequest;
  const history = context.modelHistory;
  const count = (value: number | undefined) => (value === undefined ? "未知" : String(value));
  const input = request.usageStatus === "missing" ? undefined : request.inputTokens;
  const percent =
    input !== undefined && request.contextWindow
      ? ((input / request.contextWindow) * 100).toFixed(1)
      : undefined;
  return [
    `Context (${context.selectedRoute.routeId})`,
    ...(request.status === "available"
      ? [
          `  最近成功主请求 ${request.providerCallId} · ${request.providerId}/${request.modelId}`,
          `  实际输入=${count(input)} Token · 其中缓存=${count(request.cachedInputTokens)} Token · 当时窗口=${count(request.contextWindow)} Token`,
          `  上下文占用=${percent === undefined ? "未知" : `${percent}%`} · 窗口空余=${input !== undefined && request.contextWindow ? Math.max(0, request.contextWindow - input) : "未知"} Token（对应这次请求）`,
          ...(request.compaction
            ? [
                `  请求所用压缩=${request.compaction.checkpointId} · 覆盖=${request.compaction.coveredEventCount}`,
              ]
            : []),
        ]
      : [`  最近成功主请求：${request.reason ?? "尚无记录"}`]),
    ...(request.compositionStatus === "available" && request.composition
      ? [
          `  请求组成（字节 ÷ 4 估算，非实际 Token）：${request.composition.segments.map((section) => `${section.kind}=≈${Math.ceil(section.bytes / 4)}`).join(" · ")}`,
        ]
      : ["  请求组成：未知（未记录）"]),
    `  当前模型历史：≈${history.estimatedTokens} Token · ${history.messageCount} 条消息 · 压缩 ${history.compactedCount} 次`,
    `  估算算法=${history.estimationAlgorithm} · 投影水位=${history.throughSequence}；不含完整系统指令、工具定义和协议开销。`,
    ...(history.latestCompaction
      ? [
          `  当前压缩=${history.latestCompaction.checkpointId} · 覆盖=${history.latestCompaction.coveredEventCount}`,
        ]
      : []),
  ].join("\n");
}

function createRunningInputCommands(deps: SessionCommandRegistryDeps): readonly SlashCommand[] {
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
