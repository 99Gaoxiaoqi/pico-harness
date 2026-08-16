import { randomUUID } from "node:crypto";
import type { RuntimeEffectiveConfig } from "@pico/protocol";
import { CommandRegistry, type RegistrySlashCommand } from "../input/command-registry.js";
import { createBuiltinCommands } from "../input/builtin-commands.js";
import { processUserInput } from "../input/process-user-input.js";
import { parseSlashInput } from "../input/slash-parser.js";
import { getCommandAvailability } from "../input/command-availability.js";
import type {
  InputProcessResult,
  LocalCommandResult,
  SlashArgumentCandidate,
  SlashArgumentCompleter,
  SlashCommand,
} from "../input/types.js";
import type { ClientSessionRuntime } from "./client-session-runtime.js";
import {
  decodeMemoryUndoToken,
  encodeMemoryUndoToken,
} from "../memory/memory-command.js";
import { snapshotSummariesFromRewindList } from "./rewind-client-bridge.js";
import { formatRewindSelector } from "../input/rewind-presentation.js";

/**
 * TUI 客户端斜杠命令注册表（3-D Phase 3 tier1，31 命令）。
 *
 * 复用 in-process 的解析/建议管线（parseSlashInput + CommandRegistry + 输入框
 * 建议源），命令元数据（name/aliases/usage/category/availability）镜像
 * src/input/pico-command-registry.ts，执行体换成 daemon RPC（经
 * ClientSessionRuntime.request 透传）。选择器结果沿用 LocalCommandResult 的
 * ui.open-selector/data 词汇，宿主（client-command-host）用数据化组件渲染。
 *
 * 延后（清单单一来源=tests/integration/tui-client-commands.test.ts 的 parity
 * 测试，分 BLOCKED=协议缺口 / DEFERRED=tier2 镜像两类；勿在此重复维护名单）。
 * /context /operations 不在本批。
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

  // 动态参���补全（tier2 收口）：RPC 拉候选 + 短 TTL 缓存（避免每次按键打
  // RPC），失败静默降级为空候选（连接中/daemon 未就绪不打扰输入）。匹配语义
  // 对齐 in-process 的包含式过滤（value/label/description）。
  const sessionCompleter = cachedArgumentCompleter(
    async () => runtime.request("session.list", { workspacePath }),
    (result) =>
      result.sessions.map((entry) => ({
        value: entry.sessionId,
        label: entry.title || entry.sessionId,
        description: new Date(entry.updatedAt).toLocaleString(),
      })),
  );
  const skillCompleter = cachedArgumentCompleter(
    async () => runtime.request("skills.effective.list", { workspacePath }),
    (result) =>
      (result.skills as readonly { name?: string }[]).map((skill) => ({
        value: skill.name ?? "",
        label: skill.name ?? "(unnamed)",
      })),
  );
  const agentCompleter = cachedArgumentCompleter(
    async () => runtime.request("catalog.agents", { workspacePath }),
    (result) => result.agents.map((agent) => ({ value: agent.name })),
  );

  const commands: readonly SlashCommand[] = [
    // builtin 的 /skill 是"生成提示语"兜底——客户端版走 session.send 原生
    // skill input kind（daemon 解析），此处过滤让客户端版生效（保留 use-skill
    // 别名与 in-process 对齐）。
    ...createBuiltinCommands().filter((command) => command.name !== "skill"),
    rpcCommand({
      name: "model",
      aliases: ["models"],
      description: "查看或切换模型路由",
      usage: "/model [name]",
      argumentHint: "[name]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        // 注意 wire 形状：result.config 才是 RuntimeEffectiveConfig（对抗评审
        // P0：flat 读取导致 /model 在真 daemon 上恒空——fake 必须编码同一嵌套）。
        const { config: configured } = await runtime.request("config.effective.get", {
          workspacePath,
        });
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
      aliases: ["effort"],
      description: "查看或设置思考强度",
      usage: "/thinking [level]",
      argumentHint: "[model level]",
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
      usage: "/mode <default|plan|auto|yolo>",
      argumentHint: "<default|plan|auto|yolo>",
      category: "session",
      availability: "idle",
      argumentCompleter: staticCompleter(["default", "plan", "auto", "yolo"]),
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const target = input.argv[0];
        if (target === undefined) {
          const current = await runtime.request("session.settings.get", { workspacePath, sessionId: sid });
          return {
            type: "local",
            action: "message",
            message: `协作模式：${current.settings.collaborationMode ?? "agent"} · 权限：${current.settings.permissionMode ?? "default"}`,
          };
        }
        if (!["default", "plan", "auto", "yolo"].includes(target)) {
          return { type: "local", action: "message", message: "Usage: /mode <default|plan|auto|yolo>" };
        }
        // 与 in-process 语义对齐（对抗评审 P1：此前 agent|plan 分叉）：SessionMode
        // 走 deprecated mode param（RuntimeInteractionMode = default|auto|yolo|plan）
        // ——daemon 侧 "plan" 进规划、其余更新权限。
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          mode: target as "default" | "plan" | "auto" | "yolo",
        });
        return { type: "local", action: "message", message: `协作模式已切换：${target}` };
      },
    }),
    rpcCommand({
      name: "plan",
      description: "进入或退出计划模式",
      usage: "/plan [on|off]",
      argumentHint: "[on|off]",
      category: "session",
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
      aliases: ["permission"],
      description: "查看或设置权限模式",
      usage: "/permissions [default|auto|yolo|plan]",
      argumentHint: "[default|auto|yolo|plan]",
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
        // permissionMode 枚举无 "plan"（协议 :695）；plan 走 deprecated permissions
        // 别名（协议 :699 支持 "plan" → 进入规划）——与 in-process 语义对齐。
        if (target === "plan") {
          await runtime.request("session.settings.update", {
            workspacePath,
            sessionId: sid,
            permissions: "plan",
          });
          return { type: "local", action: "message", message: "权限模式已设置：plan（进入规划）" };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          permissionMode: target as "default" | "auto" | "yolo",
        });
        return { type: "local", action: "message", message: `权限模式已设置：${target}` };
      },
    }),
    rpcCommand({
      name: "graph",
      description: "查看或切换 Graph Mode",
      usage: "/graph [on|off]",
      argumentHint: "[on|off]",
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
      name: "hooks",
      description: "List, review, trust, enable, disable, or reload Hooks",
      usage: "/hooks [list|review|trust|enable|disable|reload] [handler-id]",
      category: "system",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const action = input.argv[0] ?? "list";
        const handlerId = input.argv[1];
        const known = ["list", "review", "trust", "enable", "disable", "reload"];
        if (!known.includes(action)) {
          return msg("Usage: /hooks [list|review|trust|enable|disable|reload] [handler-id]");
        }
        try {
          const result = await runtime.request("hooks.manage", {
            workspacePath,
            action: action as "list" | "review" | "trust" | "enable" | "disable" | "reload",
            ...(handlerId ? { handlerId } : {}),
          });
          const outcome = result.result as Record<string, unknown>;
          if (action === "list") {
            const items = Array.isArray(outcome["items"]) ? outcome["items"] : [];
            if (items.length === 0) return msg("No Hooks configured.");
            return msg(
              items
                .map((raw) => {
                  const item = raw as Record<string, unknown>;
                  const source = item["source"] as Record<string, unknown> | undefined;
                  return `${String(item["id"] ?? "")}  ${String(item["event"] ?? "")}  ${String(item["type"] ?? "")}  ${String(item["status"] ?? "")}  ${String(source?.["kind"] ?? "")}:${String(source?.["path"] ?? "")}`;
                })
                .join("\n"),
            );
          }
          if (action === "review") {
            return msg(JSON.stringify(outcome["review"] ?? {}, null, 2));
          }
          if (action === "reload") {
            return msg(outcome["reloaded"] === true ? "Hooks reloaded." : "Hook reload rejected.");
          }
          return msg(
            outcome["ok"] === true
              ? `${action === "trust" ? "Trusted" : action === "enable" ? "Enabled" : "Disabled"} Hook ${handlerId}.`
              : "Hook operation failed.",
          );
        } catch (error) {
          return msg(`Hooks command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    rpcCommand({
      name: "add-dir",
      description: "Add a directory to the current session workspace",
      usage: "/add-dir [directory]",
      argumentHint: "[directory]",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const sid = needSession();
        if (typeof sid === "object") return sid;
        try {
          if (input.args.length === 0) {
            // 无参 = 列表：工作区本身 + 会话持久化的附加授权目录。
            const settings = await runtime.request("session.settings.get", {
              workspacePath,
              sessionId: sid,
            });
            const additional = settings.settings.additionalDirectories ?? [];
            if (additional.length === 0) {
              return msg("No workspace roots are currently authorized.");
            }
            return msg(["Authorized workspace roots:", ...additional.map((root) => `- ${root}`)].join("\n"));
          }
          const result = await runtime.request("session.directories.add", {
            workspacePath,
            sessionId: sid,
            path: input.args,
          });
          return result.added
            ? msg(`Workspace directory added: ${input.args}`)
            : msg("Directory already authorized.");
        } catch (error) {
          return msg(`Add directory failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    rpcCommand({
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
    rpcCommand({
      name: "snapshots",
      aliases: ["snapshot"],
      description: "List current session rewind points",
      usage: "/snapshots",
      category: "session",
      availability: "idle",
      execute: async () => {
        // BLOCKED 收口（2026-08-16）：rewind.* 已覆盖等价能力——纯客户端镜像，
        // 展示复用 in-process 同款纯函数（rewind.list → 快照摘要 → 文本列表）。
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("rewind.list", { workspacePath, sessionId: sid });
        const snapshots = snapshotSummariesFromRewindList(result);
        return {
          type: "local",
          action: "message",
          message: formatRewindSelector(sid, snapshots),
          data: snapshots,
        };
      },
    }),
    rpcCommand({
      name: "rewind",
      aliases: ["checkpoint"],
      description: "Open the rewind menu for code and conversation checkpoints",
      usage: "/rewind",
      category: "session",
      availability: "idle",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("rewind.list", { workspacePath, sessionId: sid });
        const snapshots = snapshotSummariesFromRewindList(result);
        if (snapshots.length === 0) {
          return {
            type: "local",
            action: "message",
            message: "No user-message checkpoints are available yet. Send a new prompt, then run /rewind again.",
          };
        }
        // 可选 message-id：预选进选择器（/changes 面板的 w 跳转用）。
        const requested = input.argv[0];
        const selected = requested
          ? snapshots.find((snapshot) => snapshot.messageId === requested)
          : undefined;
        if (requested && !selected) {
          return {
            type: "local",
            action: "message",
            message: `Cannot open Rewind: checkpoint ${requested} was not found.`,
          };
        }
        return {
          type: "local",
          action: "message",
          message: `Rewind：${snapshots.length} 个 checkpoint 可选。`,
          ui: { kind: "open-selector", selector: "rewind" },
          data: {
            sessionId: sid,
            snapshots,
            ...(selected ? { selectedMessageId: selected.messageId } : {}),
          },
        };
      },
    }),
    rpcCommand({
      name: "changes",
      description: "Preview a message checkpoint and partially rewind one file",
      usage: "/changes [message-id]",
      argumentHint: "[message-id]",
      category: "session",
      availability: "idle",
      execute: async (input) => {
        const sid = needSession();
        if (typeof sid === "object") return sid;
        const result = await runtime.request("rewind.list", { workspacePath, sessionId: sid });
        const snapshots = snapshotSummariesFromRewindList(result);
        if (snapshots.length === 0) {
          return {
            type: "local",
            action: "message",
            message: "No message checkpoint is available yet.",
          };
        }
        const requested = input.argv[0];
        const target = requested
          ? snapshots.find((snapshot) => snapshot.messageId === requested)
          : snapshots.at(-1);
        if (!target) {
          return {
            type: "local",
            action: "message",
            message: `Cannot open Changes: checkpoint ${requested} was not found.`,
          };
        }
        // 单文件恢复（tier2 收口）：rewind.changes 逐文件 diff + 当前指纹 →
        // ChangesDialogHost（↑/↓ 选文件，Enter 双击确认恢复，w 跳转完整回滚）。
        return {
          type: "local",
          action: "message",
          message: `Opening changes for ${target.messageId}.（↑/↓ 选择 · Enter 恢复选中文件 · w 完整回滚 · Esc 关闭）`,
          ui: { kind: "open-selector", selector: "changes" },
          data: { sessionId: sid, checkpointId: target.messageId },
        };
      },
    }),
    rpcCommand({
      name: "init",
      description: "生成项目上下文文件（daemon 侧执行）",
      usage: "/init",
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
      argumentHint: "[resources]",
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
    rpcCommand({
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
    rpcCommand({
      name: "resume",
      description: "恢复指定会话",
      usage: "/resume <session-id>",
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
      argumentCompleter: sessionCompleter,
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
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
      argumentCompleter: sessionCompleter,
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
      aliases: ["use-skill"],
      description: "请求 agent 使用指定技能（daemon 侧解析）",
      usage: "/skill <name> [arguments]",
      argumentHint: "<name> [arguments]",
      category: "skill",
      // 有意分歧：in-process 为 idle；客户端经 session.send 排队（daemon 决策
      // queued/steered），运行中提交合法。parity 测试按此豁免。
      availability: "always",
      argumentCompleter: skillCompleter,
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
      argumentHint: "<name> <task>",
      category: "agent",
      // 有意分歧：同 /skill——经 session.send 排队，运行中提交合法。
      availability: "always",
      argumentCompleter: agentCompleter,
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
      aliases: ["skill-list"],
      description: "列出可用技能",
      usage: "/skills",
      category: "skill",
      availability: "idle",
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
      availability: "idle",
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
      availability: "idle",
      execute: async () => ({
        type: "local",
        action: "message",
        message: "仓库探索已内建：直接描述目标，agent 会自行扫描代码库。",
      }),
    }),
    // ---- tier2 镜像（2026-08-16）：/memory /provider /cron ----
    // 元数据与 in-process 逐字段一致（parity 漂移门比对）；执行体走 daemon RPC。
    rpcCommand({
      name: "memory",
      description: "Remember a workspace fact or control workspace memory",
      usage: "/memory remember <text>|status|off|on",
      argumentHint: "remember <text>|status|off|on",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const [operation, ...rest] = input.argv;
        try {
          switch (operation?.toLowerCase()) {
            case "remember": {
              const text = rest.join(" ").trim();
              if (!text) return msg("Usage: /memory remember <text>");
              const { fact } = await runtime.request("memory.create", { workspacePath, text });
              return msg(
                `Remembered workspace fact ${fact.factId}. Undo: /memory undo ${encodeMemoryUndoToken({ factId: fact.factId, version: fact.version })}`,
              );
            }
            case "status": {
              const [settingsResult, facts, reviews] = await Promise.all([
                runtime.request("memory.settings.get", { workspacePath }),
                runtime.request("memory.list", { workspacePath, states: ["active"], limit: 500 }),
                runtime.request("memory.review.list", { workspacePath, statuses: ["pending"], limit: 500 }),
              ]);
              return msg(
                [
                  `Memory: ${settingsResult.settings.enabled ? "on" : "off"}`,
                  `Injection: ${settingsResult.settings.injectionEnabled ? "on" : "off"}`,
                  `Review mode: ${settingsResult.settings.reviewMode}`,
                  `Active facts: ${facts.facts.length}`,
                  `Pending proposals: ${reviews.proposals.length}`,
                ].join("\n"),
              );
            }
            case "off":
            case "on": {
              const enabled = operation === "on";
              const current = await runtime.request("memory.settings.get", { workspacePath });
              if (
                current.settings.enabled === enabled &&
                current.settings.injectionEnabled === enabled
              ) {
                return msg(`Memory is already ${enabled ? "on" : "off"}.`);
              }
              await runtime.request("memory.settings.update", {
                workspacePath,
                expectedVersion: current.settings.version,
                enabled,
                injectionEnabled: enabled,
                idempotencyKey: `memory-toggle:${enabled ? "on" : "off"}:${current.settings.version}`,
              });
              return msg(
                enabled
                  ? "Memory enabled; controlled recall is active."
                  : "Memory disabled; recall injection and proposal extraction are off.",
              );
            }
            case "undo": {
              const token = rest[0];
              if (!token) return msg("Usage: /memory undo <token>");
              try {
                const payload = decodeMemoryUndoToken(token);
                await runtime.request("memory.update", {
                  workspacePath,
                  factId: payload.factId,
                  expectedVersion: payload.version,
                  state: "disabled",
                  idempotencyKey: `memory-undo:${payload.factId}:${payload.version}`,
                });
                return msg(`Undone: workspace fact ${payload.factId} is disabled.`);
              } catch (error) {
                return msg(`Undo unavailable: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            default:
              return msg("Usage: /memory remember <text>|status|off|on");
          }
        } catch (error) {
          return msg(`Memory unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    rpcCommand({
      name: "provider",
      description: "Manage shared user providers without exposing credentials in command arguments",
      usage:
        "/provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
      argumentHint: "[list | import-env | default | delete]",
      category: "model",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const [subcommand = "list", first, confirmation, ...rest] = input.argv;
        if (rest.length > 0) {
          return msg(
            "Usage: /provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
          );
        }
        try {
          if (subcommand === "list" && first === undefined && confirmation === undefined) {
            const [listed, effective] = await Promise.all([
              runtime.request("provider.list", {}),
              runtime.request("config.effective.get", { workspacePath }),
            ]);
            if (listed.providers.length === 0) {
              return msg(
                "No providers configured. Set complete LLM_* variables, then run /provider import-env <id> to preview an import.",
              );
            }
            const defaultRoute = effective.config.defaultModelRouteId ?? "";
            return msg(
              listed.providers
                .map(
                  (provider) =>
                    `${provider.id} · ${provider.protocol} · ${provider.origin} · credential=${provider.credentialStatus}${defaultRoute.startsWith(`${provider.id}/`) ? " · default" : ""}\n  ${provider.baseURL}\n  models: ${provider.models.join(", ") || "discovery"}`,
                )
                .join("\n"),
            );
          }
          if (subcommand === "import-env") {
            if (!first || (confirmation !== undefined && confirmation !== "--confirm")) {
              return msg("Usage: /provider import-env <id> [--confirm]");
            }
            const baseURL = process.env.LLM_BASE_URL?.trim();
            const defaultModel = process.env.LLM_MODEL?.trim();
            const secret =
              process.env.LLM_API_KEYS?.trim() || process.env.LLM_API_KEY?.trim() || "";
            const apiKeyEnv = process.env.LLM_API_KEYS?.trim() ? "LLM_API_KEYS" : "LLM_API_KEY";
            if (!baseURL || !defaultModel || !secret) {
              return msg(
                "Import unavailable: LLM_BASE_URL, LLM_MODEL and LLM_API_KEY[S] must all be set in this process.",
              );
            }
            if (!/^[^/\s]+$/u.test(first)) {
              return msg("Provider ID cannot contain whitespace or slash.");
            }
            const models = [
              ...new Set(
                [defaultModel, ...(process.env.LLM_MODELS?.split(/[\s,]+/u) ?? [])].filter(Boolean),
              ),
            ];
            const normalizedEndpoint = baseURL.replace(/\/+$/u, "");
            if (confirmation !== "--confirm") {
              return msg(
                [
                  `Import preview for ${first}:`,
                  "protocol: openai",
                  `endpoint: ${normalizedEndpoint}`,
                  `models: ${models.join(", ")}`,
                  "credential: current process environment -> OS credential vault (value hidden)",
                  `Confirm with: /provider import-env ${first} --confirm`,
                ].join("\n"),
              );
            }
            const listed = await runtime.request("provider.list", {});
            const result = await runtime.request("provider.importEnvironment", {
              provider: {
                id: first,
                protocol: "openai",
                baseURL: normalizedEndpoint,
                apiKeyEnv,
                models,
                discoverModels: true,
              },
              defaultModel,
              secret,
              expectedRevision: listed.revision,
            });
            return msg(`Provider imported: ${result.provider.id}（credential 已入 OS 凭据库，值不回显）。`);
          }
          if (subcommand === "default" && first && confirmation === undefined) {
            if (first === "clear" || first === "none") {
              return msg("暂不支持经客户端清除默认路由；请直接编辑 daemon 用户配置。");
            }
            const current = await runtime.request("config.user.get", {});
            await runtime.request("config.user.update", {
              defaults: { ...current.config.defaults, modelRouteId: first },
              expectedRevision: current.revision,
            });
            return msg(`默认模型路由已设置：${first}。`);
          }
          if (subcommand === "delete" && first && confirmation === undefined) {
            const listed = await runtime.request("provider.list", {});
            await runtime.request("provider.delete", {
              providerId: first,
              expectedRevision: listed.revision,
            });
            return msg(`Provider deleted: ${first}。`);
          }
          return msg(
            "Usage: /provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
          );
        } catch (error) {
          return msg(`Provider command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    rpcCommand({
      name: "cron",
      description: "Manage persistent YOLO cron jobs for this workspace",
      usage:
        "/cron <status|list|credential|add|enable|disable|delete|runs> [--tool-network=allow|disabled|allowlist:host1,host2] [arguments]",
      argumentHint: "<status|list|credential|add|enable|disable|delete|runs>",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const [operation = "list", ...args] = input.argv;
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
              runs.map((run) => `${run.runId} · ${run.status} · ${new Date(run.startedAt ?? 0).toISOString()}`).join("\n"),
            );
          }
          if (operation === "add" || operation === "credential") {
            return msg(
              `/${operation} 的自动化创建含凭据注入与工具网络策略门，暂未镜像到客户端（tier2 后续）；现有 Job 的管理（list/enable/disable/delete/runs）可用。`,
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
          return msg(`Cron failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    rpcCommand({
      name: "mcp",
      description: "Inspect and control MCP server connections",
      usage: "/mcp [reload|enable|disable|reconnect|resources|read|prompts|prompt|auth]",
      category: "mcp",
      availability: "always",
      execute: async (input) => {
        const msg = (text: string) => ({ type: "local" as const, action: "message" as const, message: text });
        const [action, server] = input.argv;
        try {
          // 无参 = 状态：effective 配置面 + config.mcpServers 瞬态探测面拼合。
          if (!action) {
            const [effective, probe] = await Promise.all([
              runtime.request("mcp.effective.list", { workspacePath }),
              runtime.request("config.mcpServers", { workspacePath }).catch(() => undefined),
            ]);
            if (effective.servers.length === 0) {
              return msg("MCP status\nNo MCP servers loaded.");
            }
            const probeByServer = new Map<string, Record<string, unknown>>(
              (probe?.servers ?? []).map((entry: Record<string, unknown>) => [
                String(entry["name"] ?? ""),
                entry,
              ]),
            );
            const lines = ["MCP status"];
            for (const server of effective.servers) {
              const status = probeByServer.get(server.name);
              const transport =
                server.transport === "stdio" ? "stdio" : server.transport === "http" ? "http" : "sse";
              const enabled = server.enabled === false ? " disabled" : "";
              const source = server.source.scope === "user" ? "用户级" : server.source.scope === "project" ? "项目级" : "插件";
              const probeStatus =
                status && typeof status["status"] === "string"
                  ? ` [${status["status"]}${typeof status["toolCount"] === "number" ? ` · ${status["toolCount"]} tools` : ""}]`
                  : "";
              lines.push(`- ${server.name} [${transport}]${enabled} - ${source}${probeStatus}`);
            }
            return msg(lines.join("\n"));
          }
          if (action === "enable" || action === "disable") {
            if (!server) return msg("Usage: /mcp enable <server> | disable <server>");
            const listed = await runtime.request("mcp.user.list", {});
            const target = listed.servers.find((entry) => entry.name === server);
            if (!target) {
              return msg(
                `未在用户级配置中找到 ${server}（项目级请编辑 .pico/mcp.json，插件级只读）。`,
              );
            }
            const result = await runtime.request("mcp.user.setEnabled", {
              serverName: server,
              enabled: action === "enable",
              expectedRevision: listed.revision,
              idempotencyKey: randomUUID(),
            });
            return msg(`MCP server ${result.server.name} 已${action === "enable" ? "启用" : "停用"}（下次 run 生效）。`);
          }
          if (action === "reload") {
            // daemon 无跨 run 常驻连接管理面：reload = 配置快照刷新（下次 run 重读配置）。
            return msg(
              "MCP 配置由 daemon 在每次 run 时重读，无需 reload；重新拉取状态快照请直接运行 /mcp。",
            );
          }
          if (action === "reconnect" || action === "auth") {
            return msg(
              `/mcp ${action} 需要 daemon 侧活连接管理面（暂未镜像）：请重启 run 使新配置生效。`,
            );
          }
          if (action === "resources" || action === "read" || action === "prompts" || action === "prompt") {
            return msg(
              `/mcp ${action} 需要连接 MCP 服务器后查询（暂未镜像）：该能力属运行期工具面，客户端不做直连。`,
            );
          }
          return msg(
            "Usage: /mcp [reload|enable|disable|reconnect|resources|read|prompts|prompt|auth]",
          );
        } catch (error) {
          return msg(`MCP command failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
  ];
  return new CommandRegistry(commands as readonly RegistrySlashCommand[]);
}

/** /steer /queue /replace /interrupt——运行中输入行为（availability: running）。 */
function createRunningInputCommands(
  deps: ClientCommandRegistryDeps,
): readonly SlashCommand[] {
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
  const processed: InputProcessResult = await (async () => {
    try {
      return await processUserInput(input, { registry });
    } catch (error) {
      // 任何命令执行器内的 RPC/解析错误都不得变成 unhandled rejection 崩掉
      // TUI（对抗评审 P0）：统一降级为错误消息。
      const detail = error instanceof Error ? error.message : String(error);
      return {
        type: "local-command" as const,
        raw: input,
        command: parsed?.name ?? "",
        args: parsed?.args ?? "",
        argv: parsed?.argv ?? [],
        result: { type: "local" as const, action: "message" as const, message: `命令执行失败：${detail}` },
      };
    }
  })();
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

function rpcCommand(spec: SlashCommand): SlashCommand {
  return { ...spec, kind: spec.kind ?? "local" };
}

function staticCompleter(values: readonly string[]) {
  return (query: string): readonly { value: string }[] =>
    values
      .filter((value) => value.startsWith(query.toLowerCase()))
      .map((value) => ({ value }));
}

const ARGUMENT_COMPLETER_CACHE_TTL_MS = 5_000;

/**
 * 动态参数补全源：load 拉 RPC 数据、project 投影为候选，短 TTL 缓存避免
 * 每次按键打 RPC；load 失败静默返回空候选（补全是尽力而为的 UI 增强，
 * 不把连接问题暴露到输入路径）。过滤为包含式（value/label/description）。
 */
function cachedArgumentCompleter<T>(
  load: () => Promise<T>,
  project: (loaded: T) => readonly SlashArgumentCandidate[],
): SlashArgumentCompleter {
  let cache: { at: number; candidates: readonly SlashArgumentCandidate[] } | undefined;
  return async (query) => {
    if (cache === undefined || Date.now() - cache.at > ARGUMENT_COMPLETER_CACHE_TTL_MS) {
      try {
        cache = { at: Date.now(), candidates: project(await load()) };
      } catch {
        return [];
      }
    }
    const lowered = query.toLowerCase();
    if (!lowered) return cache.candidates;
    return cache.candidates.filter((candidate) =>
      `${candidate.value} ${candidate.label ?? ""} ${candidate.description ?? ""}`
        .toLowerCase()
        .includes(lowered),
    );
  };
}

function modelRoutesFromConfig(config: RuntimeEffectiveConfig): {
  id: string;
  name: string;
}[] {
  const routes: { id: string; name: string }[] = [];
  const providers = (Array.isArray(config.providers) ? config.providers : []) as readonly Record<
    string,
    unknown
  >[];
  for (const provider of providers) {
    const providerId = typeof provider["id"] === "string" ? provider["id"] : undefined;
    const models = Array.isArray(provider["models"]) ? provider["models"] : [];
    if (!providerId) continue;
    for (const model of models) {
      if (typeof model === "string") {
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
  // 真实形状：usage.total.{inputTokens,outputTokens,...}（对抗评审 P1——flat 读
  // 取恒打印"无用量数据"；fake 同步编码嵌套）。
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

/** /context 的 wire 报告本地格式化（字段语义同 provider/model-runtime-report）。 */
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
