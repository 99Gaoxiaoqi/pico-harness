import type { LocalCommandResult, SlashCommand } from "../../input/types.js";
import type { HookifyProposal } from "../hookify/rules.js";
import type { HookManagementItem, HookManagementReview, HookManagementService } from "./service.js";

export interface HookCommandAdapterOptions {
  management: HookManagementService;
  /** 宿主负责展示完整 diff、强制确认并应用 proposal。 */
  hookify: (description: string) => Promise<{ proposal: HookifyProposal; applied: boolean }>;
}

/** 可由 Pico command registry 显式注册；不修改 input controller 或 TUI layout。 */
export function createHookManagementCommands(
  options: HookCommandAdapterOptions,
): readonly SlashCommand[] {
  return [createHooksCommand(options.management), createHookifyCommand(options.hookify)];
}

function createHooksCommand(management: HookManagementService): SlashCommand {
  return {
    name: "hooks",
    description: "List, review, trust, enable, disable, or reload Hooks",
    usage: "/hooks [list|review|trust|enable|disable|reload] [handler-id]",
    category: "system",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      const action = input.argv[0] ?? "list";
      const handlerId = input.argv[1];
      switch (action) {
        case "list":
          return message(formatList(management.list()));
        case "review":
          return message(formatReview(await management.review(requireId(action, handlerId))));
        case "trust":
          await management.trust(requireId(action, handlerId));
          return message(`Trusted Hook ${handlerId}.`);
        case "enable":
          await management.enable(requireId(action, handlerId));
          return message(`Enabled Hook ${handlerId}.`);
        case "disable":
          await management.disable(requireId(action, handlerId));
          return message(`Disabled Hook ${handlerId}.`);
        case "reload":
          return message((await management.reload()) ? "Hooks reloaded." : "Hook reload rejected.");
        default:
          return message("Usage: /hooks [list|review|trust|enable|disable|reload] [handler-id]");
      }
    },
  };
}

function createHookifyCommand(hookify: HookCommandAdapterOptions["hookify"]): SlashCommand {
  return {
    name: "hookify",
    description: "Propose a restricted Hookify rule from natural language",
    usage: "/hookify <description>",
    argumentHint: "<description>",
    category: "system",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      if (!input.args.trim()) return message("Usage: /hookify <description>");
      const result = await hookify(input.args);
      return {
        ...message(
          result.applied
            ? `Hookify rule applied: ${result.proposal.targetPath}`
            : "Hookify proposal rejected; no file was written.",
        ),
        data: result.proposal,
      };
    },
  };
}

function formatList(items: readonly HookManagementItem[]): string {
  if (items.length === 0) return "No Hooks configured.";
  return items
    .map(
      (item) =>
        `${item.id}  ${item.event}  ${item.type}  ${item.status}  ${item.source.kind}:${item.source.path}`,
    )
    .join("\n");
}

function formatReview(review: HookManagementReview): string {
  return JSON.stringify(review, null, 2);
}

function requireId(action: string, handlerId: string | undefined): string {
  if (!handlerId) throw new Error(`/hooks ${action} 需要 handler-id`);
  return handlerId;
}

function message(content: string): LocalCommandResult {
  return { type: "local", action: "message", message: content };
}
