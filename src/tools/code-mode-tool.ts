import { randomUUID } from "node:crypto";
import type { EngineRuntimeRun } from "../engine/runtime-port.js";
import { buildRuntimeToolResultInput, redactToolResult } from "../engine/tool-result-builder.js";
import type { HookService } from "../hooks/service.js";
import type { ToolDefinition } from "../schema/message.js";
import { sharedCodeCellAdmission, type CodeCellAdmission } from "./code-cell-admission.js";
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
  readonly hookService?: Pick<HookService, "dispatch">;
  /** Trusted host override for an explicitly isolated admission scope. */
  readonly admission?: CodeCellAdmission;
}

/** Direct engine embeddings may omit durable authority; production must provide it. */
export function createCodeModeTool(options: CodeModeToolOptions): BaseTool {
  return new CodeModeTool(options);
}

class CodeModeTool implements BaseTool {
  readonly executionMode = "orchestrator" as const;
  readonly executionSemantics = "exclusive_step" as const;
  readonly recoveryMode = "never_auto_retry" as const;
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
        "Send exec alone in its assistant Step; do not combine it with other top-level calls.",
        "Call tools.<name>(object), using the tool names and input schemas shown alongside exec.",
        "Only tools explicitly enabled for nesting are callable; exec and direct-only tools are unavailable.",
        "Tool calls return their output as strings; use JSON.parse only when that tool returns JSON.",
        "Use await for dependencies and Promise.all for independent calls, then return a JSON-serializable value.",
        "The fresh sandbox has no host filesystem, process, network, timers, module imports or dynamic code generation.",
        "Limits: 30 seconds, 64 MiB memory, 64 KiB source, 1 MiB per input/output/result, 32 calls, 8 in flight.",
        "Exec requires an exclusive Step; the host admits one active cell and one waiting cell.",
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
    const permit = await (this.options.admission ?? sharedCodeCellAdmission).acquire(
      context?.signal,
    );
    if (!permit) {
      return JSON.stringify({
        ok: false,
        error: { kind: "limit_exceeded", message: "Code Mode execution queue is full" },
        toolCalls: [],
      });
    }
    try {
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
            recoveryPolicy: registry.getRecoveryPolicy?.(name, step) ?? {
              mode: "never_auto_retry",
            },
            argumentRedactionSecrets: this.redactionSecrets,
            sanitizeResult: (result) => redactToolResult(result, this.redactionSecrets),
            onCommittedResult: async (finalCall, envelope) => {
              await this.options.hookService?.dispatch(
                envelope.status === "succeeded" ? "PostToolUse" : "PostToolUseFailure",
                {
                  tool_name: finalCall.name,
                  tool_input: JSON.parse(finalCall.arguments),
                  tool_call_id: finalCall.id,
                  tool_result: structuredClone(envelope),
                },
              );
            },
          };
          const childResult = runtimeRun
            ? await runtimeRun.executeNestedTool(call, registry, childContext)
            : await (async () => {
                // Explicit in-memory embeddings retain the same bounded notification contract.
                let finalCall = call;
                let dispatched = false;
                const result = redactToolResult(
                  await registry.execute(call, {
                    ...childContext,
                    beforeDispatch: async (validatedCall) => {
                      finalCall = validatedCall;
                      dispatched = true;
                    },
                  }),
                  this.redactionSecrets,
                );
                const built = buildRuntimeToolResultInput(
                  finalCall,
                  result,
                  result.output,
                  !dispatched ? "rejected" : result.isError ? "failed" : "succeeded",
                );
                try {
                  await childContext.onCommittedResult?.(finalCall, built.envelope);
                } catch (error) {
                  // A notification failure must not invite the cell to retry physical work.
                  throw new ToolCommitBoundaryError("T2", error);
                }
                return built.input.body.storage === "inline"
                  ? {
                      ...result,
                      output: built.input.body.content,
                      isError: built.input.status !== "succeeded",
                    }
                  : result;
              })();
          if (childResult.isError) throw new Error(childResult.output);
          return childResult.output;
        },
      });
      return JSON.stringify(result);
    } finally {
      // executeCodeCell settles only after every dispatched host operation drains.
      permit.release();
    }
  }
}
