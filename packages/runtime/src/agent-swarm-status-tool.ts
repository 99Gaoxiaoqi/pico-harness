import type { ToolDefinition } from "@pico/core";
import type {
  AgentGraphRootToolContext,
  ReadAgentGraphProjectionInput,
} from "@pico/core/agent-graph-supervisor-contracts";
import type { AgentSwarmStatusResult } from "./agent-swarm-status.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesValue } from "./tool-access.js";

export const AGENT_SWARM_STATUS_TOOL_NAME = "agent_swarm_status";
export const AGENT_SWARM_STATUS_MAX_ITEMS = 128;
const MAX_OUTPUT_BYTES = 48 * 1024;
const NO_FILE_SIDE_EFFECTS = { kind: "none" } as const;

/** Minimal execution context: the outer registry may carry more metadata. */
export interface AgentSwarmStatusToolExecutionContext {
  readonly signal?: AbortSignal;
}

/** Runtime-owned adapter over a Host-supplied Graph status query. */
export interface AgentSwarmStatusTool {
  readonly readOnly: true;
  readonly fileSideEffects: typeof NO_FILE_SIDE_EFFECTS;
  readonly toolset: "agent-graph";
  name(): string;
  accesses(args: string): ToolAccessesValue;
  definition(): ToolDefinition;
  execute(args: string, context?: AgentSwarmStatusToolExecutionContext): Promise<string>;
}

export interface CreateAgentSwarmStatusToolOptions {
  readonly getRootContext: () => AgentGraphRootToolContext | undefined;
  readonly port: {
    readSwarmStatus(input: ReadAgentGraphProjectionInput): Promise<AgentSwarmStatusResult>;
  };
}

/**
 * Projects only bounded operational state. Result content, tool activity, prompts and logs
 * are explicitly excluded even if a Host port accidentally returns them.
 */
export function createAgentSwarmStatusTool(
  options: CreateAgentSwarmStatusToolOptions,
): AgentSwarmStatusTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    toolset: "agent-graph",
    name: () => AGENT_SWARM_STATUS_TOOL_NAME,
    accesses: () => ToolAccesses.none(),
    definition(): ToolDefinition {
      return {
        name: AGENT_SWARM_STATUS_TOOL_NAME,
        description:
          "读取异步 Swarm 的精简工作状态和失败原因。返回有界状态，不含子任务日志、工具活动、思考或结果正文；需要正式结果时使用结果读取工具。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      };
    },
    async execute(args: string, context?: AgentSwarmStatusToolExecutionContext): Promise<string> {
      context?.signal?.throwIfAborted();
      if (Buffer.byteLength(args, "utf8") > 1024) throw new Error("agent_swarm_status 参数过长。");
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        throw new Error("agent_swarm_status 需要空 JSON 对象。");
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length > 0
      ) {
        throw new Error("agent_swarm_status 只接受空 JSON 对象。");
      }
      const root = options.getRootContext();
      if (!isValidRootContext(root)) {
        throw new Error("agent_swarm_status 仅可由有效的 Graph root activation 调用。");
      }
      const result = await options.port.readSwarmStatus({
        graphId: root.graphId,
        epoch: root.epoch,
        rootSessionId: root.rootSessionId,
      });
      context?.signal?.throwIfAborted();
      if (result.kind !== "agent_swarm_status" || result.swarmId !== root.graphId) {
        throw new Error("agent_swarm_status 返回了不属于当前 root 的 Swarm。");
      }
      const items = result.items.slice(0, AGENT_SWARM_STATUS_MAX_ITEMS).map((item) => ({
        workId: item.workId,
        operatorId: item.operatorId,
        status: item.status,
        ...(item.childSessionId === undefined ? {} : { childSessionId: item.childSessionId }),
        ...(item.runId === undefined ? {} : { runId: item.runId }),
        ...(item.failurePhase === undefined ? {} : { failurePhase: item.failurePhase }),
        ...(item.failureReason === undefined
          ? {}
          : { failureReason: item.failureReason.slice(0, 2048) }),
      }));
      const output = {
        kind: result.kind,
        swarmId: result.swarmId,
        status: result.status,
        counts: {
          total: result.counts.total,
          queued: result.counts.queued,
          running: result.counts.running,
          blocked: result.counts.blocked,
          completed: result.counts.completed,
          failed: result.counts.failed,
          aborted: result.counts.aborted,
          cancelled: result.counts.cancelled,
          stopped: result.counts.stopped,
          superseded: result.counts.superseded,
        },
        items,
        diagnostics: (result.diagnostics ?? []).slice(0, 32).map(({ subjectId, message }) => ({
          subjectId,
          ...(message === undefined ? {} : { message: message.slice(0, 2048) }),
        })),
        availableOperatorProfiles: (result.availableOperatorProfiles ?? [])
          .slice(0, 32)
          .map(({ profileId, revision, description }) => ({
            profileId,
            revision,
            description: description.slice(0, 2048),
          })),
        truncated:
          result.items.length > items.length ||
          (result.diagnostics?.length ?? 0) > 32 ||
          (result.availableOperatorProfiles?.length ?? 0) > 32,
      };
      while (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_OUTPUT_BYTES) {
        output.truncated = true;
        if (output.items.length) output.items.pop();
        else if (output.diagnostics.length) output.diagnostics.pop();
        else if (output.availableOperatorProfiles.length) output.availableOperatorProfiles.pop();
        else throw new Error("agent_swarm_status 摘要超出输出限制。");
      }
      return JSON.stringify(output);
    },
  };
}

function isValidRootContext(
  root: AgentGraphRootToolContext | undefined,
): root is AgentGraphRootToolContext {
  return Boolean(
    root &&
    root.kind === "graph_root_supervisor" &&
    Number.isSafeInteger(root.epoch) &&
    root.epoch >= 1 &&
    [root.graphId, root.rootSessionId, root.rootTurnId, root.rootRunId].every(
      (id) =>
        typeof id === "string" &&
        Boolean(id.trim()) &&
        id === id.trim() &&
        Buffer.byteLength(id) <= 1024,
    ),
  );
}
