import type { AgentSwarmStatusResult } from "../agent-graph/swarm-status.js";
import type { ToolDefinition } from "../schema/message.js";
import type {
  AgentGraphRootToolContext,
  ReadAgentGraphProjectionInput,
} from "./agent-graph-tools.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";
import { ToolAccesses } from "./tool-access.js";

export const AGENT_SWARM_STATUS_TOOL_NAME = "agent_swarm_status";
export const AGENT_SWARM_STATUS_MAX_ITEMS = 128;
const MAX_OUTPUT_BYTES = 48 * 1024;

export function createAgentSwarmStatusTool(options: {
  readonly getRootContext: () => AgentGraphRootToolContext | undefined;
  readonly port: {
    readSwarmStatus(input: ReadAgentGraphProjectionInput): Promise<AgentSwarmStatusResult>;
  };
}): BaseTool {
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
    async execute(args: string, context?: ToolExecutionContext): Promise<string> {
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
      if (
        !root ||
        root.kind !== "graph_root_supervisor" ||
        !Number.isSafeInteger(root.epoch) ||
        root.epoch < 1 ||
        [root.graphId, root.rootSessionId, root.rootTurnId, root.rootRunId].some(
          (id) =>
            typeof id !== "string" ||
            !id.trim() ||
            id !== id.trim() ||
            Buffer.byteLength(id) > 1024,
        )
      ) {
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
      // Explicit field selection prevents an expanded service payload leaking child content.
      const items = result.items.slice(0, AGENT_SWARM_STATUS_MAX_ITEMS).map((item) => ({
        workId: item.workId,
        operatorId: item.operatorId,
        status: item.status,
        ...(item.childSessionId === undefined ? {} : { childSessionId: item.childSessionId }),
        ...(item.runId === undefined ? {} : { runId: item.runId }),
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
