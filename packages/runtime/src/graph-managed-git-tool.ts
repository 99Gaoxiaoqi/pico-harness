import type { ToolDefinition } from "@pico/core";
import type {
  GraphManagedGitPort,
  GraphManagedGitRequest,
} from "@pico/core/agent-output-contracts";
import type { ToolExecutionContext } from "./runtime-tool-execution.js";
import { ToolAccesses } from "./tool-access.js";

export class GraphManagedGitTool {
  readonly readOnly = false;
  readonly permissionCategory = "file_write" as const;
  readonly executionSemantics = "exclusive_step" as const;
  readonly fileSideEffects = { kind: "none" } as const;
  constructor(private readonly port: GraphManagedGitPort) {}
  name(): string {
    return "graph_git";
  }
  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "当前隔离 Graph 工作树专用 Git 通道。status 返回变更与当前 head；diff 查看全部待提交差异；commit 提交当前工作树全部非忽略变更，必须传 status 的完整 expected_head 与 message，返回真实 branch/head。不要通过 bash 执行 git status/add/commit。不能切换分支、选择仓库、推送或合并。",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["status", "diff", "commit"] },
          expected_head: {
            type: "string",
            description: "commit 必填，最近 status 返回的完整 head。",
          },
          message: { type: "string", description: "commit 必填，提交说明。" },
        },
        required: ["operation"],
        additionalProperties: false,
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    return JSON.stringify(
      await this.port.execute(parseGraphManagedGitRequest(args), context?.signal),
    );
  }
}

export function parseGraphManagedGitRequest(args: string): GraphManagedGitRequest {
  if (Buffer.byteLength(args) > 8192) throw new Error("graph_git input too large");
  const input: unknown = JSON.parse(args);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("graph_git requires an object");
  const value = input as Record<string, unknown>;
  const operation = value["operation"];
  if (operation === "status" || operation === "diff") {
    if (Object.keys(value).some((key) => key !== "operation"))
      throw new Error("graph_git unexpected input");
    return { operation };
  }
  if (
    operation !== "commit" ||
    Object.keys(value).some((key) => !["operation", "expected_head", "message"].includes(key)) ||
    typeof value["expected_head"] !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value["expected_head"]) ||
    typeof value["message"] !== "string" ||
    !value["message"].trim() ||
    value["message"].includes("\0") ||
    Buffer.byteLength(value["message"]) > 4096
  ) {
    throw new Error(
      "graph_git commit requires exact expected_head and a nonempty message (max 4096 bytes)",
    );
  }
  return { operation, expected_head: value["expected_head"], message: value["message"] };
}
