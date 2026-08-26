import { createHash } from "node:crypto";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";

export const AGENT_OUTPUT_MAX_BYTES = 16 * 1024;
export const AGENT_OUTPUT_MAX_REFS = 64;
export const AGENT_OUTPUT_MAX_REF_BYTES = 2 * 1024;

export type AgentOutputStatus = "success" | "failure";

/**
 * Runtime-owned identity for one exact Graph operator activation.
 *
 * The discriminant intentionally prevents a normal root/subagent Session from
 * accidentally exposing agent_output. The host must derive this context from a
 * persisted provision + claim, never from model arguments.
 */
export interface GraphOperatorActivationContext {
  readonly kind: "graph_operator_activation";
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly activationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface AgentOutputEventPayload {
  readonly schemaVersion: "pico.agent_output.v1";
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly activationId: string;
  readonly status: AgentOutputStatus;
  readonly output: string;
  readonly outputBytes: number;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  /** One terminal output per exact activation, including across process replay. */
  readonly idempotencyKey: string;
  /** Detects reuse of the activation key with a different semantic output. */
  readonly fingerprint: string;
}

export interface CommitAgentOutputInput {
  readonly activation: GraphOperatorActivationContext;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  /** Stable data body to place in the committed RuntimeEvent. */
  readonly eventPayload: AgentOutputEventPayload;
}

export interface CommitAgentOutputReceipt {
  readonly eventId: string;
  readonly recordId?: string;
  readonly replayed: boolean;
}

/** Persistence/runtime adapter supplied by the Graph host. */
export interface AgentOutputCommitPort {
  commitAgentOutput(input: CommitAgentOutputInput): Promise<CommitAgentOutputReceipt>;
}

export interface CreateAgentOutputToolOptions {
  readonly getActivationContext: () => GraphOperatorActivationContext | undefined;
  readonly port: AgentOutputCommitPort;
}

export interface AgentOutputToolResult {
  readonly status: "committed";
  readonly eventId: string;
  readonly recordId?: string;
  readonly replayed: boolean;
  readonly idempotencyKey: string;
}

interface NormalizedAgentOutputInput {
  readonly status: AgentOutputStatus;
  readonly output: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
}

class AgentOutputTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly options: CreateAgentOutputToolOptions) {}

  name(): string {
    return "agent_output";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "提交当前 Graph Operator activation 的正式终态输出。只能由 Graph Operator 调用；success/failure 必须显式声明，系统不会从自然语言推断完成状态。",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["success", "failure"],
            description: "本次 activation 的明确终态。",
          },
          output: {
            type: "string",
            description: `正式输出正文；UTF-8 编码后最多 ${AGENT_OUTPUT_MAX_BYTES} 字节。`,
          },
          evidence_refs: {
            type: "array",
            maxItems: AGENT_OUTPUT_MAX_REFS,
            items: { type: "string" },
            description: "支撑结论的稳定证据引用。",
          },
          artifact_refs: {
            type: "array",
            maxItems: AGENT_OUTPUT_MAX_REFS,
            items: { type: "string" },
            description: "本次 activation 产出的稳定制品引用。",
          },
        },
        required: ["status", "output"],
        additionalProperties: false,
      },
    };
  }

  accesses(_args: string): ToolAccesses {
    return ToolAccesses.none();
  }

  async execute(args: string, execution?: ToolExecutionContext): Promise<string> {
    execution?.signal?.throwIfAborted();
    const activation = requireGraphOperatorActivationContext(this.options.getActivationContext());
    const toolCallId = requireNonEmptyIdentity(execution?.toolCallId, "toolCallId");
    const normalized = parseAgentOutputInput(args);
    const idempotencyKey = agentOutputIdempotencyKey(activation);
    const fingerprint = agentOutputFingerprint(normalized);
    const eventPayload: AgentOutputEventPayload = {
      schemaVersion: "pico.agent_output.v1",
      graphId: activation.graphId,
      operatorId: activation.operatorId,
      operatorGeneration: activation.operatorGeneration,
      activationId: activation.activationId,
      status: normalized.status,
      output: normalized.output,
      outputBytes: Buffer.byteLength(normalized.output, "utf8"),
      evidenceRefs: normalized.evidenceRefs,
      artifactRefs: normalized.artifactRefs,
      idempotencyKey,
      fingerprint,
    };

    const receipt = await this.options.port.commitAgentOutput({
      activation,
      toolCallId,
      idempotencyKey,
      fingerprint,
      eventPayload,
    });
    execution?.signal?.throwIfAborted();
    const validatedReceipt = requireCommitReceipt(receipt);
    const result: AgentOutputToolResult = {
      status: "committed",
      eventId: validatedReceipt.eventId,
      ...(validatedReceipt.recordId ? { recordId: validatedReceipt.recordId } : {}),
      replayed: validatedReceipt.replayed,
      idempotencyKey,
    };
    return JSON.stringify(result);
  }
}

/** Creates the operator-only tool without coupling it to Graph storage/runtime modules. */
export function createAgentOutputTool(options: CreateAgentOutputToolOptions): BaseTool {
  return new AgentOutputTool(options);
}

export function agentOutputIdempotencyKey(activation: GraphOperatorActivationContext): string {
  const identity = stableJson({
    graphId: activation.graphId,
    operatorId: activation.operatorId,
    operatorGeneration: activation.operatorGeneration,
    activationId: activation.activationId,
    sessionId: activation.sessionId,
    turnId: activation.turnId,
    runId: activation.runId,
  });
  return `agent-output:${createHash("sha256").update(identity).digest("hex")}`;
}

export function agentOutputFingerprint(input: {
  readonly status: AgentOutputStatus;
  readonly output: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
}): string {
  return `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

function parseAgentOutputInput(args: string): NormalizedAgentOutputInput {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("agent_output 参数解析失败：期望 JSON 对象。");
  }
  if (!isRecord(value)) {
    throw new Error("agent_output 参数无效：期望 JSON 对象。");
  }
  const allowedKeys = new Set(["status", "output", "evidence_refs", "artifact_refs"]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`agent_output 参数无效：不支持字段 ${unknownKey}。`);
  }

  const status = value["status"];
  if (status !== "success" && status !== "failure") {
    throw new Error("agent_output 参数无效：status 必须是 success 或 failure。");
  }
  const output = requiredBoundedText(value["output"], "output", AGENT_OUTPUT_MAX_BYTES);
  const evidenceRefs = normalizeRefs(value["evidence_refs"], "evidence_refs");
  const artifactRefs = normalizeRefs(value["artifact_refs"], "artifact_refs");
  if (evidenceRefs.length + artifactRefs.length > AGENT_OUTPUT_MAX_REFS) {
    throw new Error(
      `agent_output 参数无效：evidence_refs 与 artifact_refs 合计不得超过 ${AGENT_OUTPUT_MAX_REFS} 项。`,
    );
  }
  return { status, output, evidenceRefs, artifactRefs };
}

function normalizeRefs(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`agent_output 参数无效：${field} 必须是字符串数组。`);
  }
  if (value.length > AGENT_OUTPUT_MAX_REFS) {
    throw new Error(`agent_output 参数无效：${field} 不得超过 ${AGENT_OUTPUT_MAX_REFS} 项。`);
  }
  const refs = value.map((ref, index) =>
    requiredBoundedText(ref, `${field}[${index}]`, AGENT_OUTPUT_MAX_REF_BYTES),
  );
  const controlCharacterIndex = refs.findIndex((ref) => /\p{Cc}/u.test(ref));
  if (controlCharacterIndex >= 0) {
    throw new Error(`agent_output 参数无效：${field}[${controlCharacterIndex}] 不得包含控制字符。`);
  }
  if (new Set(refs).size !== refs.length) {
    throw new Error(`agent_output 参数无效：${field} 不得包含重复引用。`);
  }
  return refs;
}

function requiredBoundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`agent_output 参数无效：${field} 必须是非空字符串。`);
  }
  const normalized = value.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`agent_output 参数无效：${field} 不得超过 ${maxBytes} 字节。`);
  }
  return normalized;
}

function requireGraphOperatorActivationContext(
  value: GraphOperatorActivationContext | undefined,
): GraphOperatorActivationContext {
  if (!value || value.kind !== "graph_operator_activation") {
    throw new Error("agent_output 仅可由有效的 Graph operator activation 调用。");
  }
  requireNonEmptyIdentity(value.graphId, "graphId");
  requireNonEmptyIdentity(value.operatorId, "operatorId");
  requireNonEmptyIdentity(value.activationId, "activationId");
  requireNonEmptyIdentity(value.sessionId, "sessionId");
  requireNonEmptyIdentity(value.turnId, "turnId");
  requireNonEmptyIdentity(value.runId, "runId");
  if (!Number.isSafeInteger(value.operatorGeneration) || value.operatorGeneration < 1) {
    throw new Error("agent_output Graph operator activation context 的 operatorGeneration 无效。");
  }
  return value;
}

function requireNonEmptyIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`agent_output 调用上下文的 ${field} 无效。`);
  }
  if (Buffer.byteLength(value, "utf8") > AGENT_OUTPUT_MAX_REF_BYTES || /\p{Cc}|\s/u.test(value)) {
    throw new Error(`agent_output 调用上下文的 ${field} 无效。`);
  }
  return value;
}

function requireCommitReceipt(receipt: CommitAgentOutputReceipt): CommitAgentOutputReceipt {
  requireNonEmptyIdentity(receipt?.eventId, "commit receipt eventId");
  if (receipt.recordId !== undefined) {
    requireNonEmptyIdentity(receipt.recordId, "commit receipt recordId");
  }
  if (typeof receipt.replayed !== "boolean") {
    throw new Error("agent_output commit receipt 的 replayed 无效。");
  }
  return receipt;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
