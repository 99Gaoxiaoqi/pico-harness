import type { ToolDefinition } from "../schema/message.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";
import { ToolAccesses } from "./tool-access.js";

export interface ConfiguredSubagentOutputQuery {
  readonly locator: "child_session_latest" | "child_session_run" | "legacy_run" | "legacy_turn";
  readonly childSessionId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  readonly view: "result" | "events" | "runtime_events" | "all";
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface ConfiguredSubagentOutputPort {
  read(query: ConfiguredSubagentOutputQuery): Promise<unknown>;
}

/** Register only in root sessions; Graph operator agent_output remains its separate write tool. */
export function createConfiguredSubagentOutputTool(options: {
  readonly port: ConfiguredSubagentOutputPort;
}): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => "agent_output",
    accesses: () => ToolAccesses.none(),
    definition(): ToolDefinition {
      return {
        name: "agent_output",
        description:
          "读取当前父会话已启动子代理的真实历史输出。优先使用 agent_spawn 返回的 child_session_id，locator=child_session_latest 读取最新运行，child_session_run 加 run_id 读取指定运行。view=result 读取结果摘要；runtime_events/all 仅用于有限诊断。不能读取任意会话或路径。",
        inputSchema: {
          type: "object",
          properties: {
            locator: {
              type: "string",
              enum: ["child_session_latest", "child_session_run", "legacy_run", "legacy_turn"],
            },
            child_session_id: { type: "string", minLength: 1, maxLength: 256 },
            run_id: { type: "string", minLength: 1, maxLength: 256 },
            turn_id: { type: "string", minLength: 1, maxLength: 256 },
            view: { type: "string", enum: ["result", "events", "runtime_events", "all"] },
            max_events: { type: "integer", minimum: 1, maximum: 100 },
            max_bytes: { type: "integer", minimum: 1024, maximum: 131072 },
          },
          additionalProperties: false,
        },
      };
    },
    async execute(args: string, context?: ToolExecutionContext): Promise<string> {
      context?.signal?.throwIfAborted();
      const query = parseQuery(args);
      const output = await options.port.read(query);
      context?.signal?.throwIfAborted();
      return JSON.stringify(output);
    },
  };
}

function parseQuery(args: string): ConfiguredSubagentOutputQuery {
  const value: unknown = JSON.parse(args);
  if (!isRecord(value)) throw new Error("agent_output requires a JSON object");
  const allowed = [
    "locator",
    "child_session_id",
    "run_id",
    "turn_id",
    "view",
    "max_events",
    "max_bytes",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("agent_output does not accept paths or unknown fields");
  const childSessionId = identity(value["child_session_id"]);
  const runId = identity(value["run_id"]);
  const turnId = identity(value["turn_id"]);
  const locator =
    value["locator"] ??
    (childSessionId
      ? runId
        ? "child_session_run"
        : "child_session_latest"
      : runId && !turnId
        ? "legacy_run"
        : turnId && !runId
          ? "legacy_turn"
          : undefined);
  if (value["locator"] === undefined && childSessionId && turnId)
    throw new Error(
      "agent_output cannot combine child_session_id and turn_id without an explicit locator",
    );
  if (
    locator !== "child_session_latest" &&
    locator !== "child_session_run" &&
    locator !== "legacy_run" &&
    locator !== "legacy_turn"
  )
    throw new Error("agent_output requires a valid child or legacy locator");
  if (
    (locator === "child_session_latest" && !childSessionId) ||
    (locator === "child_session_run" && (!childSessionId || !runId)) ||
    (locator === "legacy_run" && !runId) ||
    (locator === "legacy_turn" && !turnId)
  )
    throw new Error(`agent_output locator ${locator} is missing its required identity`);
  const view = value["view"] ?? "runtime_events";
  if (view !== "result" && view !== "events" && view !== "runtime_events" && view !== "all")
    throw new Error("agent_output view is invalid");
  return {
    locator,
    ...(locator === "child_session_latest" || locator === "child_session_run"
      ? { childSessionId }
      : {}),
    ...(locator === "child_session_run" || locator === "legacy_run" ? { runId } : {}),
    ...(locator === "legacy_turn" ? { turnId } : {}),
    view,
    maxEvents: boundedInteger(value["max_events"], 30, 1, 100),
    maxBytes: boundedInteger(value["max_bytes"], 16 * 1024, 1024, 128 * 1024),
  };
}

function identity(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\s/\\\p{Cc}]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("agent_output locator identity is invalid");
  return value;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`agent_output bound must be an integer between ${min} and ${max}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
