import { decodeMemoryUndoToken, encodeMemoryUndoToken } from "../../memory/memory-undo-token.js";
import { snapshotSummariesFromRewindList } from "../rewind-client-bridge.js";
import { formatRewindSelector } from "../../input/rewind-presentation.js";
import type { ClientCommandRegistryDeps } from "./types.js";
import { rpcCommand, sessionAccess } from "./shared.js";

export function createWorkspaceCommands(deps: ClientCommandRegistryDeps) {
  const { runtime, workspacePath } = deps;
  const { needSession } = sessionAccess(runtime);
  return {
    operations: rpcCommand({
      name: "operations",
      aliases: ["ops"],
      description: "Inspect and dispose storage operations needing attention",
      usage: [
        "Usage:",
        "  /operations list",
        "  /operations show <operation-id>",
        "  /operations retry <operation-id> <expected-version> [reason]",
        "  /operations abort <operation-id> <expected-version> [reason]",
      ].join("\n"),
      argumentHint: "[list|show|retry|abort]",
      category: "system",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const [action = "list", operationId, rawVersion, ...rest] = input.argv;
        const known = ["list", "show", "retry", "abort"];
        if (!known.includes(action)) {
          return msg(
            [
              "Usage:",
              "  /operations list",
              "  /operations show <operation-id>",
              "  /operations retry <operation-id> <expected-version> [reason]",
              "  /operations abort <operation-id> <expected-version> [reason]",
            ].join("\n"),
          );
        }
        try {
          if (action === "list") {
            if (operationId !== undefined) {
              return msg(
                [
                  "Usage:",
                  "  /operations list",
                  "  /operations show <operation-id>",
                  "  /operations retry <operation-id> <expected-version> [reason]",
                  "  /operations abort <operation-id> <expected-version> [reason]",
                ].join("\n"),
              );
            }
            const result = await runtime.request("operations.manage", {
              workspacePath,
              action: "list",
            });
            const operations = Array.isArray(
              (result.result as Record<string, unknown>)["operations"],
            )
              ? ((result.result as Record<string, unknown>)["operations"] as unknown[])
              : [];
            if (operations.length === 0) return msg("No storage operations need attention.");
            return msg(
              operations
                .map((raw) => {
                  const item = raw as Record<string, unknown>;
                  return `${String(item["operationId"] ?? "")} · ${String(item["kind"] ?? "")} · ${String(item["state"] ?? "")} · session ${String(item["sessionId"] ?? "")} · ${String(item["updatedAt"] ?? "")}`;
                })
                .join("\n"),
            );
          }
          if (action === "show") {
            if (!operationId) {
              return msg("Usage: /operations show <id>");
            }
            const result = await runtime.request("operations.manage", {
              workspacePath,
              action: "show",
              operationId,
            });
            return msg(
              JSON.stringify(
                (result.result as Record<string, unknown>)["operation"] ?? {},
                null,
                2,
              ),
            );
          }
          const version = Number(rawVersion);
          if (!operationId || !Number.isInteger(version) || version <= 0) {
            return msg(`Usage: /operations ${action} <id> <version> [reason]`);
          }
          const result = await runtime.request("operations.manage", {
            workspacePath,
            action: action as "retry" | "abort",
            operationId,
            expectedVersion: version,
            ...(rest.length > 0 ? { reason: rest.join(" ") } : {}),
          });
          const operation = (result.result as Record<string, unknown>)["operation"] as
            | Record<string, unknown>
            | undefined;
          const state = String(operation?.["state"] ?? "?");
          return msg(
            `Operation ${operationId} ${action === "retry" ? "已重试" : "已中止"}（state=${state}）。`,
          );
        } catch (error) {
          return msg(
            `Operations failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
    "add-dir": rpcCommand({
      name: "add-dir",
      description: "Add a directory to the current session workspace",
      usage: "/add-dir [directory]",
      argumentHint: "[directory]",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
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
            return msg(
              ["Authorized workspace roots:", ...additional.map((root) => `- ${root}`)].join("\n"),
            );
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
          return msg(
            `Add directory failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
    snapshots: rpcCommand({
      name: "snapshots",
      aliases: ["snapshot"],
      description: "List current session rewind points",
      usage: "/snapshots",
      category: "session",
      availability: "idle",
      execute: async () => {
        // rewind.list → 快照摘要 → 文本列表。
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
    rewind: rpcCommand({
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
            message:
              "No user-message checkpoints are available yet. Send a new prompt, then run /rewind again.",
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
    changes: rpcCommand({
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
        // 单文件恢复：rewind.changes 逐文件 diff + 当前指纹 →
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
    init: rpcCommand({
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
    doctor: rpcCommand({
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
    memory: rpcCommand({
      name: "memory",
      description: "Remember a workspace item or control workspace memory",
      usage: "/memory remember <text>|status|off|on",
      argumentHint: "remember <text>|status|off|on",
      category: "workspace",
      availability: "idle",
      execute: async (input) => {
        const msg = (text: string) => ({
          type: "local" as const,
          action: "message" as const,
          message: text,
        });
        const [operation, ...rest] = input.argv;
        try {
          switch (operation?.toLowerCase()) {
            case "remember": {
              const text = rest.join(" ").trim();
              if (!text) return msg("Usage: /memory remember <text>");
              const { item } = await runtime.request("memory.create", { workspacePath, text });
              return msg(
                `Remembered workspace item ${item.itemId}. Undo: /memory undo ${encodeMemoryUndoToken({ itemId: item.itemId, version: item.version })}`,
              );
            }
            case "status": {
              const [settingsResult, items] = await Promise.all([
                runtime.request("memory.settings.get", { workspacePath }),
                runtime.request("memory.list", { workspacePath, limit: 1000 }),
              ]);
              return msg(
                [
                  `Memory: ${settingsResult.settings.enabled ? "on" : "off"}`,
                  `Injection: ${settingsResult.settings.recallEnabled ? "on" : "off"}`,
                  `Automatic extraction: ${settingsResult.settings.autoExtract ? "on" : "off"}`,
                  "Validated memories are saved directly.",
                  `Active items: ${items.items.filter((item) => item.lifecycleState === "active").length}`,
                  `Archived items: ${items.items.filter((item) => item.lifecycleState === "archived").length}`,
                ].join("\n"),
              );
            }
            case "off":
            case "on": {
              const enabled = operation.toLowerCase() === "on";
              const current = await runtime.request("memory.settings.get", { workspacePath });
              if (
                current.settings.enabled === enabled &&
                current.settings.recallEnabled === enabled
              ) {
                return msg(`Memory is already ${enabled ? "on" : "off"}.`);
              }
              await runtime.request("memory.settings.update", {
                workspacePath,
                expectedVersion: current.settings.version,
                enabled,
                recallEnabled: enabled,
                idempotencyKey: `memory-toggle:${enabled ? "on" : "off"}:${current.settings.version}`,
              });
              return msg(
                enabled
                  ? "Memory enabled; controlled recall is active."
                  : "Memory disabled; recall injection and automatic extraction are off.",
              );
            }
            case "undo": {
              const token = rest[0];
              if (!token) return msg("Usage: /memory undo <token>");
              try {
                const payload = decodeMemoryUndoToken(token);
                const { item } = await runtime.request("memory.get", {
                  workspacePath,
                  itemId: payload.itemId,
                });
                if (item.version !== payload.version || item.lifecycleState !== "active") {
                  return msg(
                    "Undo unavailable: the item changed after this undo token was issued.",
                  );
                }
                await runtime.request("memory.update", {
                  workspacePath,
                  itemId: payload.itemId,
                  expectedVersion: payload.version,
                  lifecycleState: "archived",
                  idempotencyKey: `memory-undo:${payload.itemId}:${payload.version}`,
                });
                return msg(`Undone: workspace item ${payload.itemId} is archived.`);
              } catch (error) {
                return msg(
                  `Undo unavailable: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            default:
              return msg("Usage: /memory remember <text>|status|off|on");
          }
        } catch (error) {
          return msg(
            `Memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  };
}

function renderReportOutput(output: unknown): string {
  return Array.isArray(output) ? output.map(String).join("\n") : String(output ?? "(无输出)");
}
