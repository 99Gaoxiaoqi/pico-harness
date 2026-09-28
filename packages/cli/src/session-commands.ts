import type { RuntimeGoalSnapshot, RuntimeSessionContextSnapshot } from "@pico/protocol";
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
  let goalPending = false;
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
      usage: GOAL_USAGE,
      category: "session",
      availability: "always",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const message = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        if (goalPending) return message("Goal 操作正在处理中，请等待完成。");
        const args = input.args.trim();
        const [action, ...rest] = args.split(/\s+/u);
        if (action && !["arm", "pause", "resume", "clear"].includes(action))
          return message(GOAL_USAGE);
        const draft = action === "arm" ? parseGoalArmArgs(args.slice(3).trim()) : undefined;
        if (action === "arm" && !draft)
          return message(
            `${GOAL_USAGE}\n完成条件不能为空；最大迭代次数为正整数，Token 限额至少 1000。`,
          );
        if (action !== "arm" && rest.length > 1) return message(GOAL_USAGE);
        goalPending = true;
        try {
          const current = await runtime.request("goal.get", { workspacePath, sessionId: sid });
          const goal = current.goal?.currentGoal;
          if (!action)
            return message(
              goal ? `当前目标：\n${formatGoalSnapshot(current.goal)}` : "当前没有 Goal。",
            );
          if (action === "arm" && goal && ["active", "paused", "waiting"].includes(goal.status)) {
            return message(
              "当前 Goal 尚未结束，请先清除后再设置；暂停或等待中的 Goal 也不能覆盖。",
            );
          }
          if (action !== "arm" && !goal) return message("当前没有可操作的 Goal。");
          try {
            const result = await runtime.request("goal.control", {
              workspacePath,
              sessionId: sid,
              expectedRevision: goal?.revision ?? 0,
              ...(action === "arm"
                ? { action: "arm" as const, ...draft! }
                : { action: action as "pause" | "resume" | "clear", goalId: rest[0] ?? goal!.id }),
            });
            return message(
              action === "arm"
                ? `Goal 已设置，发送下一条普通用户消息后开始执行：\n${formatGoalSnapshot(result.goal)}`
                : `Goal ${action === "pause" ? "已暂停" : action === "resume" ? "已恢复" : "已清除，历史记录会保留"}：\n${formatGoalSnapshot(result.goal)}`,
            );
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "CONFLICT"
            ) {
              const latest = await runtime.request("goal.get", { workspacePath, sessionId: sid });
              return message(
                `Goal 已在另一处更新，已刷新最新状态；请检查后重新操作。\n${formatGoalSnapshot(latest.goal)}`,
              );
            }
            throw error;
          }
        } finally {
          goalPending = false;
        }
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

const GOAL_USAGE =
  "/goal [pause|resume|clear [id]|arm 完成条件 [--max-iterations N] [--token-budget N]]";

function parseGoalArmArgs(
  args: string,
): { condition: string; maxIterations: number; tokenBudget?: number } | undefined {
  const values = new Map<string, number>();
  let invalid = false;
  const condition = args
    .replace(
      /(?:^|\s)--(max-iterations|token-budget)\s+(\S+)/gu,
      (_match, key: string, value: string) => {
        const number = Number(value);
        if (
          values.has(key) ||
          !Number.isSafeInteger(number) ||
          number < (key === "token-budget" ? 1000 : 1)
        )
          invalid = true;
        values.set(key, number);
        return " ";
      },
    )
    .trim();
  if (invalid || !condition || /(?:^|\s)--\S+/u.test(condition)) return undefined;
  const tokenBudget = values.get("token-budget");
  return {
    condition,
    maxIterations: values.get("max-iterations") ?? 50,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function formatGoalSnapshot(snapshot: RuntimeGoalSnapshot | null): string {
  const goal = snapshot?.currentGoal;
  if (!goal) return "当前没有 Goal。";
  return [
    `· [${goal.status}] ${goal.condition} (${goal.id})`,
    `  迭代 ${goal.iterations}/${goal.maxIterations} · Goal token ${Math.max(0, goal.tokensNow - goal.tokensAtStart)}/${goal.tokenBudget ?? "不限额"}`,
    "  Goal token 只计首次基线后的主执行，不含评估；包含评估的人民币账单见 /usage。",
    ...(goal.armedAt !== undefined && goal.status === "active"
      ? ["  发送下一条普通用户消息后开始执行。"]
      : []),
    ...(goal.lastReason
      ? [`  最近评估：${goal.lastReason}`]
      : goal.lastEvaluation
        ? [`  最近评估：${goal.lastEvaluation.reason}`]
        : []),
  ].join("\n");
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
  const costCNY = record["costCNY"];
  if (typeof costCNY === "number" && Number.isFinite(costCNY))
    parts.push(`会话账单 ¥${costCNY.toFixed(4)}（含 Goal 评估）`);
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
