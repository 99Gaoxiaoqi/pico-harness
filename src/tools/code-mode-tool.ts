import { randomUUID } from "node:crypto";
import type { EngineRuntimeRun } from "../engine/runtime-port.js";
import { redactToolResult } from "../engine/tool-result-builder.js";
import type { ToolDefinition } from "../schema/message.js";
import { executeCodeCell } from "./code-mode.js";
import {
  WORKSPACE_FILE_SIDE_EFFECTS,
  ToolCommitBoundaryError,
  type BaseTool,
  type Registry,
  type ToolExecutionContext,
} from "./registry.js";

export interface CodeModeToolOptions {
  readonly registry: Registry;
  /** Production hosts supply this callback; missing live authority fails closed. */
  readonly getRuntimeRun?: () => EngineRuntimeRun | undefined;
  readonly redactionSecrets?: readonly string[];
}

/** Direct engine embeddings may omit durable authority; production must provide it. */
export function createCodeModeTool(options: CodeModeToolOptions): BaseTool {
  return new CodeModeTool(options);
}

class CodeModeTool implements BaseTool {
  readonly executionMode = "orchestrator" as const;
  readonly nesting = "direct_only" as const;
  // The parent engine captures rollback history for possible nested writes.
  readonly fileSideEffects = WORKSPACE_FILE_SIDE_EFFECTS;

  private readonly redactionSecrets: readonly string[];
  constructor(private readonly options: CodeModeToolOptions) {
    this.redactionSecrets = [...new Set(options.redactionSecrets ?? [])]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  name(): string {
    return "exec";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: [
        "Execute one bounded JavaScript orchestration cell over tools active in this Step.",
        "Call tools.<name>(object), using the tool names and input schemas shown alongside exec.",
        "Only tools explicitly enabled for nesting are callable; exec and direct-only tools are unavailable.",
        "Tool calls return their output as strings; use JSON.parse only when that tool returns JSON.",
        "Use await for dependencies and Promise.all for independent calls, then return a JSON-serializable value.",
        "The fresh sandbox has no host filesystem, process, network, timers, module imports or dynamic code generation.",
        "Limits: 30 seconds, 64 MiB memory, 64 KiB source, 1 MiB per input/output/result, 32 calls, 8 in flight.",
        "The entire cell is never automatically retried; inspect structured failure diagnostics before any new cell.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript async function body." } },
        required: ["code"],
        additionalProperties: false,
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input: unknown = JSON.parse(args);
    if (
      typeof input !== "object" ||
      input === null ||
      !("code" in input) ||
      typeof input.code !== "string"
    ) {
      throw new Error("exec requires a string code argument");
    }
    const step = context?.step;
    const parentToolCallId = context?.toolCallId;
    if (!step || !parentToolCallId) {
      throw new Error("exec requires a current Step snapshot and parent tool call ID");
    }
    const runtimeRun = this.options.getRuntimeRun?.();
    if (this.options.getRuntimeRun && !runtimeRun) {
      throw new Error("exec requires an active durable RuntimeRun in this host");
    }
    const { registry } = this.options;
    const tools = [...step.visibleToolNames].map((name) => ({
      name,
      nesting: registry.getNesting?.(name, step) ?? "direct_only",
    }));
    const result = await executeCodeCell({
      code: input.code,
      tools,
      signal: context?.signal,
      isFatalToolError: (error) => error instanceof ToolCommitBoundaryError,
      callTool: async (name, childInput, signal) => {
        const call = {
          id: `code-mode:${randomUUID()}`,
          name,
          arguments: JSON.stringify(childInput),
        };
        const childContext: ToolExecutionContext = {
          signal,
          toolCallId: call.id,
          parentToolCallId,
          step,
          origin: "code_mode",
          sanitizeResult: (result) => redactToolResult(result, this.redactionSecrets),
        };
        const childResult = runtimeRun
          ? await runtimeRun.executeNestedTool(call, registry, childContext)
          : redactToolResult(await registry.execute(call, childContext), this.redactionSecrets);
        if (childResult.isError) throw new Error(childResult.output);
        return childResult.output;
      },
    });
    return JSON.stringify(result);
  }
}
