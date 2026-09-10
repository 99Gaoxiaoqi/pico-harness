import {
  CodeModeError,
  CodeModeToolError,
  experimental_runCodeMode,
  type CodeModeExecutionPolicy,
} from "@ai-sdk/code-mode";
import { jsonSchema, tool, type ToolSet } from "ai";

/** Product ceilings: callers may tighten these limits, never disable or widen them. */
export const DEFAULT_CODE_MODE_EXECUTION_POLICY = Object.freeze({
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 2 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxConsoleOutputBytes: 1,
  maxSourceBytes: 64 * 1024,
  maxToolInputBytes: 1024 * 1024,
  maxToolOutputBytes: 1024 * 1024,
  maxBridgeRequests: 32,
  maxInFlightBridgeRequests: 8,
} satisfies Required<CodeModeExecutionPolicy>);

export interface CodeModeToolDefinition {
  readonly name: string;
  readonly nesting: "nestable" | "direct_only";
}

export interface CodeModeDiagnostic {
  readonly kind:
    "parse_error" | "execution_error" | "unknown_tool" | "limit_exceeded" | "tool_failure";
  readonly message: string;
}

export interface CodeModeToolCall {
  readonly index: number;
  readonly name: string;
}

export type CodeModeExecutionResult =
  | { ok: true; value: unknown; toolCalls: CodeModeToolCall[] }
  | { ok: false; error: CodeModeDiagnostic; toolCalls: CodeModeToolCall[] };

export interface ExecuteCodeCellInput {
  readonly code: string;
  /** Immutable current-Step active tool snapshot, not the registry's entire catalog. */
  readonly tools: readonly CodeModeToolDefinition[];
  /** Must use the shared dispatch path (permission, resource locks, and nested T1/T2). */
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** Durable commit failures must escape the sandbox, even if cell code catches them. */
  readonly isFatalToolError?: (error: unknown) => boolean;
  readonly signal?: AbortSignal;
  /** Host-only test/embedding option; each override must tighten the product ceiling. */
  readonly executionPolicy?: Readonly<CodeModeExecutionPolicy>;
}

/**
 * One fresh QuickJS/WASM cell. Only JSON crosses the host bridge; no host OS or
 * network objects are exposed. This function never resumes or reruns a cell.
 * Settlement includes draining all physical child operations, even after abort.
 */
export async function executeCodeCell(
  input: ExecuteCodeCellInput,
): Promise<CodeModeExecutionResult> {
  const policy = resolvePolicy(input.executionPolicy);
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  const operations = new Set<Promise<unknown>>();
  const toolCalls: CodeModeToolCall[] = [];
  let fatalFailure: { error: unknown } | undefined;
  const tools = Object.create(null) as ToolSet;

  // Copy immediately: activation changes during the cell only affect the next Step.
  for (const { name, nesting } of input.tools) {
    if (nesting !== "nestable" || name === "exec" || name === "code_mode") continue;
    tools[name] = tool({
      inputSchema: jsonSchema({}),
      execute: async (args, options) => {
        if (fatalFailure) throw fatalFailure.error;
        const childSignal = options.abortSignal
          ? AbortSignal.any([signal, options.abortSignal])
          : signal;
        childSignal.throwIfAborted();
        toolCalls.push({ index: toolCalls.length + 1, name });
        // Track the physical operation, not the SDK promise that races abort.
        const operation = Promise.resolve().then(() => {
          childSignal.throwIfAborted();
          return input.callTool(name, args, childSignal);
        });
        operations.add(operation);
        try {
          return await operation;
        } catch (error) {
          if (input.isFatalToolError?.(error)) {
            fatalFailure ??= { error };
            controller.abort(error);
            throw error;
          }
          throw new CodeModeToolError(error instanceof Error ? error.message : String(error), {
            toolName: name,
          });
        } finally {
          operations.delete(operation);
        }
      },
    });
  }

  let value: unknown;
  let failure: { error: unknown } | undefined;
  try {
    signal.throwIfAborted();
    value = await experimental_runCodeMode({
      js: input.code,
      tools,
      toolExecutionOptions: { abortSignal: signal },
      options: { executionPolicy: policy },
    });
  } catch (error) {
    failure = { error };
  } finally {
    // Terminate detached work too; callers must wait for cancellation cleanup.
    controller.abort(failure?.error ?? new Error("Code Mode cell has finished"));
    while (operations.size > 0) await Promise.allSettled([...operations]);
  }
  if (fatalFailure) throw fatalFailure.error;
  input.signal?.throwIfAborted();
  if (failure) return { ok: false, error: diagnostic(failure.error), toolCalls };
  return { ok: true, value: value ?? null, toolCalls };
}

function resolvePolicy(overrides: Readonly<CodeModeExecutionPolicy> | undefined) {
  const policy = { ...DEFAULT_CODE_MODE_EXECUTION_POLICY };
  for (const key of Object.keys(policy) as (keyof typeof policy)[]) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > policy[key]) {
      throw new RangeError(`Code Mode ${key} must be an integer between 1 and ${policy[key]}`);
    }
    policy[key] = value;
  }
  return policy;
}

function diagnostic(error: unknown): CodeModeDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const runtimeError = error as { code?: unknown; name?: unknown; stack?: unknown } | null;
  const isRuntimeError =
    error instanceof Error &&
    (runtimeError?.code === "RUN_ERROR" || runtimeError?.code === "RUN_USER_SOURCE_ERROR");
  if (
    error instanceof SyntaxError ||
    (isRuntimeError &&
      error.name === "SyntaxError" &&
      /\n\s+at code-mode\.js:\d+:\d+\s*$/.test(error.stack ?? ""))
  ) {
    return { kind: "parse_error", message };
  }
  if (
    (isRuntimeError || error instanceof CodeModeError) &&
    (runtimeError?.name === "InternalError" || runtimeError?.name === "RangeError") &&
    /interrupted|out of memory|stack (?:size|overflow)/i.test(message)
  ) {
    return { kind: "limit_exceeded", message };
  }
  if (error instanceof CodeModeError) {
    if (
      [
        "CODE_MODE_TIMEOUT",
        "CODE_MODE_CONCURRENCY_LIMIT",
        "CODE_MODE_SOURCE_TOO_LARGE",
        "CODE_MODE_BRIDGE_LIMIT",
      ].includes(error.code)
    ) {
      return { kind: "limit_exceeded", message };
    }
    if (error.code === "CODE_MODE_SERIALIZATION_ERROR") {
      return {
        kind: /exceeds? the \d+ byte size limit/i.test(message) ? "limit_exceeded" : "tool_failure",
        message,
      };
    }
    if (error.code === "CODE_MODE_TOOL_ERROR") {
      return { kind: /^Unknown tool:/i.test(message) ? "unknown_tool" : "tool_failure", message };
    }
  }
  return { kind: "execution_error", message };
}
