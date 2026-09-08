import { isSafeSubagentPresetId, type RuntimeSubagentPreset } from "@pico/protocol";
import {
  SUBAGENT_CAPABILITIES,
  requireSubagentCapability,
  type ConfiguredSubagentCatalogPort,
  type SubagentCapabilityDefinition,
} from "../agents/subagent-profiles.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";

export interface ConfiguredSubagentExecutionInput {
  readonly task: string;
  readonly definition: SubagentCapabilityDefinition;
  readonly preset?: RuntimeSubagentPreset & { modelRouteId: string };
  readonly signal?: AbortSignal;
}
export interface ConfiguredSubagentExecutionResult {
  readonly status: "completed" | "error";
  readonly sessionId: string;
  readonly childSessionId?: string;
  readonly agentName?: string;
  readonly turnId?: string;
  readonly permissionMode?: "default";
  readonly artifactIds?: readonly string[];
  readonly runId?: string;
  readonly summary: string;
  readonly patch?: { readonly path: string; readonly worktree: string; readonly branch: string };
}
export type ConfiguredSubagentExecutor = (
  input: ConfiguredSubagentExecutionInput,
) => Promise<ConfiguredSubagentExecutionResult>;
export interface ConfiguredSubagentToolsOptions {
  readonly catalog: ConfiguredSubagentCatalogPort;
  readonly execute?: ConfiguredSubagentExecutor;
  readonly capabilityUnavailableReason?: (
    definition: SubagentCapabilityDefinition,
  ) => string | undefined;
}

export async function configuredSubagentList(
  options: ConfiguredSubagentToolsOptions,
  args: string,
): Promise<string> {
  const input = JSON.parse(args) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("agent_list requires an object");
  const view = input["view"] ?? "selection";
  const cursor = input["cursor"] ?? "0";
  if (view !== "selection" && view !== "catalog")
    throw new Error("agent_list: view must be selection or catalog");
  if (typeof cursor !== "string" || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    throw new Error("agent_list: invalid cursor");
  const presets = (await options.catalog.list())
    .map((preset) => {
      const reason = options.capabilityUnavailableReason?.(
        requireSubagentCapability(preset.profile),
      );
      const availability =
        preset.availability.status === "unavailable"
          ? preset.availability
          : reason
            ? { status: "unavailable", reason }
            : preset.availability;
      return {
        subagent_id: preset.id,
        name: preset.name.slice(0, 128),
        description: preset.description.slice(0, 240),
        profile: preset.profile,
        model: preset.model.slice(0, 160),
        ...(preset.thinkingLevel ? { thinking_level: preset.thinkingLevel } : {}),
        ...availability,
      };
    })
    .filter((preset) => view === "catalog" || preset.status === "available");
  const offset = Math.min(Number(cursor), presets.length);
  const page = presets.slice(offset, offset + 8);
  const legacy = SUBAGENT_CAPABILITIES.map((definition) => {
    const reason = options.capabilityUnavailableReason?.(definition);
    return {
      agent_id: definition.id,
      profile: definition.profile,
      name: definition.name,
      description: definition.description,
      workspace: definition.workspace,
      write_back: definition.writeBack,
      ...(reason ? { status: "unavailable", reason } : { status: "available" }),
    };
  }).filter((entry) => view === "catalog" || entry.status === "available");
  const buildPage = () => ({
    view,
    presets: page,
    legacy_profiles: legacy,
    page: {
      returned: page.length,
      total: presets.length,
      ...(offset + page.length < presets.length
        ? { next_cursor: String(offset + page.length) }
        : {}),
    },
  });
  while (page.length > 1 && JSON.stringify(buildPage()).length > 7000) page.pop();
  return JSON.stringify(buildPage());
}
export class ConfiguredAgentListTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  constructor(private readonly options: ConfiguredSubagentToolsOptions) {}
  name() {
    return "agent_list";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "选择用户配置的子代理。selection 返回可运行 preset，catalog 诊断不可用原因；每页 8 条，legacy_profiles 保留旧选择。",
      inputSchema: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["selection", "catalog"] },
          cursor: { type: "string", pattern: "^[0-9]+$" },
        },
        additionalProperties: false,
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext) {
    context?.signal?.throwIfAborted();
    return configuredSubagentList(this.options, args);
  }
}
export class ConfiguredAgentSpawnTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  constructor(private readonly options: ConfiguredSubagentToolsOptions) {}
  name() {
    return "agent_spawn";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "前台等待一个有边界的持久子任务。先 agent_list 选择 subagent_id；同时提供 profile 时 subagent_id 优先。实现任务强制独立 worktree 并返回补丁，不能直接写回宿主。结果的 childSessionId/runId 可用于 agent_output 精确回读。",
      inputSchema: {
        type: "object",
        properties: {
          subagent_id: { type: "string", maxLength: 128 },
          profile: { type: "string", enum: SUBAGENT_CAPABILITIES.map((entry) => entry.profile) },
          task: { type: "string", minLength: 1, maxLength: 60000 },
          write_back: { type: "string", enum: ["summary", "patch"] },
          isolation: {
            type: "string",
            enum: ["shared", "isolated-worktree", "same_workspace", "worktree"],
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = JSON.parse(args) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("agent_spawn requires an object");
    if (typeof input["task"] !== "string" || !input["task"].trim() || input["task"].length > 60000)
      throw new Error("agent_spawn requires a bounded task (1–60000 characters)");
    context?.signal?.throwIfAborted();
    const id = input["subagent_id"];
    if (id !== undefined && !isSafeSubagentPresetId(id)) throw new Error("Invalid subagent_id");
    // Re-resolve at admission: a previously listed preset can be edited or disabled.
    const preset = id === undefined ? undefined : await this.options.catalog.resolve(id);
    const definition = requireSubagentCapability(preset?.profile ?? String(input["profile"] ?? ""));
    const reason = this.options.capabilityUnavailableReason?.(definition);
    if (reason) throw new Error(reason);
    if (input["write_back"] !== undefined && input["write_back"] !== definition.writeBack)
      throw new Error(`Profile ${definition.profile} requires write_back=${definition.writeBack}`);
    const isolation =
      input["isolation"] === "worktree"
        ? "isolated-worktree"
        : input["isolation"] === "same_workspace"
          ? "shared"
          : input["isolation"];
    if (isolation !== undefined && isolation !== definition.workspace)
      throw new Error(`Profile ${definition.profile} requires isolation=${definition.workspace}`);
    if (!this.options.execute)
      throw new Error("Persistent child executor unavailable in this host");
    const result = await this.options.execute({
      task: input["task"],
      definition,
      ...(preset ? { preset: Object.freeze({ ...preset }) } : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return JSON.stringify({
      kind: "subagent",
      ...(preset ? { subagent_id: preset.id } : {}),
      profile: definition.profile,
      ...result,
    });
  }
}
