import type { ToolDefinition } from "@pico/core";
import type { ToolPermissionCategory } from "@pico/core/tool-permission-policy";
import { ToolAccesses } from "@pico/runtime/tool-access";
import type { McpToolResult } from "./mcp-client-types.js";
import type { BaseTool, ToolExecutionContext } from "./tool-registry-contract.js";

export interface DesktopMcpToolCallInput {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export type DesktopMcpToolInvoker = (
  input: DesktopMcpToolCallInput,
  context?: ToolExecutionContext,
) => Promise<McpToolResult>;

/** Fixed model surface; the Electron authority discovers and checks the real server/tool. */
export class DesktopMcpCallTool implements BaseTool {
  readonly readOnly = false;
  readonly permissionCategory = "desktop_mcp" as ToolPermissionCategory;
  readonly fileSideEffects = { kind: "workspace" } as const;
  readonly toolset = "desktop_mcp";
  readonly recoveryMode = "never_auto_retry" as const;
  readonly executionSemantics = "exclusive_step" as const;

  constructor(private readonly invoke: DesktopMcpToolInvoker) {}

  name(): string {
    return "desktop_mcp_call";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "调用用户已启用且当前任务已获授权的 Desktop MCP 工具。server 和 tool 必须是已连接后发现的真实名称。",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "用户级 Desktop MCP server 名称" },
          tool: { type: "string", description: "该 server 实际发现的工具名称" },
          args: { type: "object", description: "传给 MCP 工具的 JSON 对象参数" },
        },
        required: ["server", "tool", "args"],
        additionalProperties: false,
      },
    };
  }

  accesses(): ToolAccesses {
    // A Desktop MCP tool may affect applications or files not visible in the JSON arguments.
    return ToolAccesses.all();
  }

  async execute(raw: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseCall(raw);
    context?.signal?.throwIfAborted();
    return JSON.stringify(await this.invoke(input, context));
  }
}

function parseCall(raw: string): DesktopMcpToolCallInput {
  if (raw.length > 1024 * 1024) throw new Error("Desktop MCP 参数超过 1 MiB 上限");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Desktop MCP 参数必须是 JSON 对象");
  }
  if (!isRecord(value)) throw new Error("Desktop MCP 参数必须是 JSON 对象");
  const server = requireName(value["server"], "server");
  const tool = requireName(value["tool"], "tool");
  const args = value["args"];
  if (!isRecord(args)) throw new Error("Desktop MCP args 必须是 JSON 对象");
  return { server, tool, args };
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`Desktop MCP ${field} 名称无效`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
