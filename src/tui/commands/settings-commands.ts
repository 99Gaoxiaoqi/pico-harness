import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, staticCompleter, sessionAccess } from "./shared.js";

export function createSettingsCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const { session, needSession } = sessionAccess(runtime);
  return {
    mode: rpcCommand({
      name: "mode",
      description: "查看或切换协作与权限模式",
      usage: "/mode <agent|plan|ask|auto|full-access>",
      argumentHint: "<agent|plan|ask|auto|full-access>",
      category: "session",
      availability: "idle",
      argumentCompleter: staticCompleter(["agent", "plan", "ask", "auto", "full-access"]),
      execute: async (input) => {
        const target = input.argv[0];
        const sid = session();
        if (target === undefined) {
          if (sid === undefined) {
            return {
              type: "local",
              action: "message",
              message: `协作模式：${runtime.preSessionSettings.collaborationMode ?? "agent"} · 权限：${permissionModeLabel(runtime.preSessionSettings.permissionMode ?? "ask")}（新会话预设）`,
            };
          }
          const current = await runtime.request("session.settings.get", {
            workspacePath,
            sessionId: sid,
          });
          return {
            type: "local",
            action: "message",
            message: `协作模式：${current.settings.collaborationMode ?? "agent"} · 权限：${permissionModeLabel(current.settings.permissionMode ?? "ask")}`,
          };
        }
        if (!["agent", "plan", "ask", "auto", "full-access"].includes(target)) {
          return {
            type: "local",
            action: "message",
            message: "Usage: /mode <agent|plan|ask|auto|full-access>",
          };
        }
        const collaborationTarget = target === "agent" || target === "plan";
        if (sid === undefined) {
          const updated = collaborationTarget
            ? runtime.setPreSessionCollaborationMode(target)
            : runtime.setPreSessionPermissionMode(target as PermissionMode);
          return {
            type: "local",
            action: "message",
            message: updated
              ? collaborationTarget
                ? `新会话协作模式预设为 ${target}（首条消息创建时生效）。`
                : `新会话权限预设为 ${permissionModeLabel(target as PermissionMode)}（首条消息创建时生效）。`
              : "当前无法修改新会话预设。",
          };
        }
        if (collaborationTarget) {
          await runtime.request("session.settings.update", {
            workspacePath,
            sessionId: sid,
            collaborationMode: target,
          });
          return { type: "local", action: "message", message: `协作模式已切换：${target}` };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          permissionMode: target as PermissionMode,
        });
        return {
          type: "local",
          action: "message",
          message: `权限模式已设置：${permissionModeLabel(target as PermissionMode)}`,
        };
      },
    }),
    plan: rpcCommand({
      name: "plan",
      description: "进入或退出计划模式",
      usage: "/plan [on|off]",
      argumentHint: "[on|off]",
      category: "session",
      availability: "idle",
      argumentCompleter: staticCompleter(["on", "off"]),
      execute: async (input) => {
        const target = input.argv[0] ?? "on";
        if (target !== "on" && target !== "off") {
          return { type: "local", action: "message", message: "Usage: /plan [on|off]" };
        }
        const sid = session();
        if (sid === undefined) {
          runtime.setPreSessionCollaborationMode(target === "on" ? "plan" : "agent");
          return {
            type: "local",
            action: "message",
            message: target === "on" ? "新会话将以计划模式开始。" : "新会话将以 Agent 模式开始。",
          };
        }
        // daemon 负责计划状态一致性检查。
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
    permissions: rpcCommand({
      name: "permissions",
      aliases: ["permission"],
      description: "查看或设置权限模式",
      usage: "/permissions [ask|auto|full-access]",
      argumentHint: "[ask|auto|full-access]",
      category: "permissions",
      availability: "idle",
      argumentCompleter: staticCompleter(["ask", "auto", "full-access"]),
      execute: async (input) => {
        const target = input.argv[0];
        const sid = session();
        if (target === undefined) {
          if (sid === undefined) {
            return {
              type: "local",
              action: "message",
              message: `权限模式：${permissionModeLabel(runtime.preSessionSettings.permissionMode ?? "ask")}（新会话预设）`,
            };
          }
          const current = await runtime.request("session.settings.get", {
            workspacePath,
            sessionId: sid,
          });
          return {
            type: "local",
            action: "message",
            message: `权限模式：${permissionModeLabel(current.settings.permissionMode ?? "ask")}`,
          };
        }
        if (!["ask", "auto", "full-access"].includes(target)) {
          return {
            type: "local",
            action: "message",
            message: "Usage: /permissions [ask|auto|full-access]",
          };
        }
        if (sid === undefined) {
          runtime.setPreSessionPermissionMode(target as "ask" | "auto" | "full-access");
          return {
            type: "local",
            action: "message",
            message: `新会话权限预设为 ${permissionModeLabel(target as PermissionMode)}（首条消息创建时生效）。`,
          };
        }
        await runtime.request("session.settings.update", {
          workspacePath,
          sessionId: sid,
          permissionMode: target as "ask" | "auto" | "full-access",
        });
        return {
          type: "local",
          action: "message",
          message: `权限模式已设置：${permissionModeLabel(target as PermissionMode)}`,
        };
      },
    }),
    graph: rpcCommand({
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
          const current = await runtime.request("session.settings.get", {
            workspacePath,
            sessionId: sid,
          });
          return {
            type: "local",
            action: "message",
            message: `Graph Mode：${current.settings.orchestrationMode === "graph" ? "开启" : "关闭"}`,
          };
        }
        if (target !== "on" && target !== "off") {
          return { type: "local", action: "message", message: "Usage: /graph [on|off]" };
        }
        const current = await runtime.request("session.settings.get", {
          workspacePath,
          sessionId: sid,
        });
        if (target === "on" || current.settings.orchestrationMode === "graph") {
          await runtime.request("session.settings.update", {
            workspacePath,
            sessionId: sid,
            orchestrationMode: target === "on" ? "graph" : "default",
          });
        }
        return {
          type: "local",
          action: "message",
          message: target === "on" ? "Graph Mode 已开启。" : "Graph Mode 已关闭。",
        };
      },
    }),
    swarm: rpcCommand({
      name: "swarm",
      description: "查看或切换 Swarm 编排，或用 Swarm 执行一次任务",
      usage: "/swarm [on|off|status|task]",
      argumentHint: "[on|off|status|task]",
      category: "session",
      availability: "idle",
      argumentCompleter: staticCompleter(["on", "off", "status"]),
      execute: async (input) => {
        const task = input.args.trim();
        const target = task;
        if (target && !["on", "off", "status"].includes(target)) {
          const sent = await runtime.sendInput({ kind: "text", text: task }, "auto", {
            orchestrationMode: "swarm",
          });
          return {
            type: "local",
            action: "message",
            ...(sent ? {} : { message: "Swarm 任务发送失败。" }),
          };
        }
        const sid = session();
        let mode = sid
          ? ((await runtime.request("session.settings.get", { workspacePath, sessionId: sid }))
              .settings.orchestrationMode ?? "default")
          : (runtime.preSessionSettings.orchestrationMode ?? "default");
        if (target === "on" || (target === "off" && mode === "swarm")) {
          mode = target === "on" ? "swarm" : "default";
          if (sid) {
            await runtime.request("session.settings.update", {
              workspacePath,
              sessionId: sid,
              orchestrationMode: mode,
            });
          } else {
            runtime.setPreSessionOrchestrationMode(mode);
          }
        }
        return {
          type: "local",
          action: "message",
          message: `Swarm Mode：${mode === "swarm" ? "开启" : "关闭"}；当前编排：${mode}`,
        };
      },
    }),
  };
}

type PermissionMode = "ask" | "auto" | "full-access";

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "ask") return "请求批准";
  if (mode === "auto") return "帮我批准";
  return "完全访问权限";
}
