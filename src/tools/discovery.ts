import { randomUUID } from "node:crypto";
import type { DiscoveryCoordinator } from "../discovery/coordinator.js";
import type {
  DiscoveryCandidate,
  DiscoveryCheckpoint,
  DiscoveryDepth,
  DiscoveryHypothesis,
  DiscoveryReport,
} from "../discovery/contract.js";
import type { ToolDefinition } from "../schema/message.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";

export type DiscoveryCoordinatorFactory = () => DiscoveryCoordinator;

export const DISCOVERY_TOOL_NAMES = [
  "start_discovery",
  "update_discovery",
  "complete_discovery",
  "cancel_discovery",
] as const;

abstract class DiscoveryTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(protected readonly coordinator: DiscoveryCoordinatorFactory) {}

  abstract name(): (typeof DISCOVERY_TOOL_NAMES)[number];
  abstract definition(): ToolDefinition;
  abstract execute(args: string, context?: ToolExecutionContext): Promise<string>;

  accesses(): ToolAccessSet {
    return ToolAccesses.all();
  }

  protected async before() {
    const coordinator = this.coordinator();
    return { coordinator, projection: await coordinator.project() };
  }
}

export class StartDiscoveryTool extends DiscoveryTool {
  name(): "start_discovery" {
    return "start_discovery";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "开始一次有界代码发现。仅在目标位置未知、跨模块或存在多个待验证假设时使用；明确的局部任务无需启动。",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "本次发现要回答的具体问题" },
          depth: {
            type: "string",
            enum: ["quick", "balanced", "deep"],
            description: "调查预算档位，默认 balanced",
          },
          roots: {
            type: "array",
            items: { type: "string" },
            description: "可选的仓库相对根目录，默认当前工作区",
          },
          discovery_id: { type: "string", description: "可选稳定 ID" },
          operation_id: { type: "string", description: "可选幂等操作 ID" },
        },
        required: ["objective"],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseInput(args);
    const { coordinator, projection } = await this.before();
    const depth = optionalString(input, "depth");
    if (depth !== undefined && !isDiscoveryDepth(depth)) {
      throw new Error("depth 必须为 quick、balanced 或 deep");
    }
    const next = await coordinator.start({
      operationId: operationId(input, "start-discovery"),
      expectedSessionSequence: projection.sessionSequence,
      objective: requiredString(input, "objective"),
      ...(depth ? { depth } : {}),
      ...(optionalStringArray(input, "roots")
        ? { roots: optionalStringArray(input, "roots") }
        : {}),
      ...(optionalString(input, "discovery_id")
        ? { discoveryId: optionalString(input, "discovery_id") }
        : {}),
    });
    return formatProjection(next);
  }
}

export class UpdateDiscoveryTool extends DiscoveryTool {
  name(): "update_discovery" {
    return "update_discovery";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "记录 Discovery 阶段检查点。阶段按 forage→focus→deepen→verify 推进；每次提交累计工具调用和已检查文件。",
      inputSchema: {
        type: "object",
        properties: {
          discovery_id: { type: "string" },
          phase: { type: "string", enum: ["forage", "focus", "deepen", "verify"] },
          cycle: { type: "number", description: "从 1 开始的循环编号" },
          candidates: { type: "array", items: candidateSchema() },
          evidence_refs: { type: "array", items: { type: "string" } },
          hypotheses: { type: "array", items: hypothesisSchema() },
          open_questions: { type: "array", items: { type: "string" } },
          tool_calls_used: { type: "number", description: "本检查点新增的工具调用数" },
          inspected_files: { type: "array", items: { type: "string" } },
          operation_id: { type: "string", description: "可选幂等操作 ID" },
        },
        required: [
          "discovery_id",
          "phase",
          "cycle",
          "candidates",
          "evidence_refs",
          "hypotheses",
          "open_questions",
          "tool_calls_used",
          "inspected_files",
        ],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseInput(args);
    const { coordinator, projection } = await this.before();
    const checkpoint = parseCheckpoint(input);
    const next = await coordinator.checkpoint({
      operationId: operationId(input, "update-discovery"),
      expectedSessionSequence: projection.sessionSequence,
      discoveryId: requiredString(input, "discovery_id"),
      checkpoint,
    });
    return formatProjection(next);
  }
}

export class CompleteDiscoveryTool extends DiscoveryTool {
  name(): "complete_discovery" {
    return "complete_discovery";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在 Verify 阶段后完成 Discovery。报告必须包含直接证据引用；Plan 模式完成后再调用 submit_plan。",
      inputSchema: {
        type: "object",
        properties: {
          discovery_id: { type: "string" },
          summary: { type: "string" },
          confirmed_targets: { type: "array", items: candidateSchema() },
          evidence_refs: { type: "array", minItems: 1, items: { type: "string" } },
          remaining_risks: { type: "array", items: { type: "string" } },
          operation_id: { type: "string", description: "可选幂等操作 ID" },
        },
        required: [
          "discovery_id",
          "summary",
          "confirmed_targets",
          "evidence_refs",
          "remaining_risks",
        ],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseInput(args);
    const { coordinator, projection } = await this.before();
    const report: DiscoveryReport = {
      summary: requiredString(input, "summary"),
      confirmedTargets: parseCandidates(input["confirmed_targets"], "confirmed_targets"),
      evidenceRefs: requiredStringArray(input, "evidence_refs"),
      remainingRisks: requiredStringArray(input, "remaining_risks"),
    };
    const next = await coordinator.complete({
      operationId: operationId(input, "complete-discovery"),
      expectedSessionSequence: projection.sessionSequence,
      discoveryId: requiredString(input, "discovery_id"),
      report,
    });
    return formatProjection(next);
  }
}

export class CancelDiscoveryTool extends DiscoveryTool {
  name(): "cancel_discovery" {
    return "cancel_discovery";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "显式取消当前 Discovery；仅在用户改变目标或调查不再需要时使用。",
      inputSchema: {
        type: "object",
        properties: {
          discovery_id: { type: "string" },
          reason: { type: "string" },
          operation_id: { type: "string", description: "可选幂等操作 ID" },
        },
        required: ["discovery_id"],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseInput(args);
    const { coordinator, projection } = await this.before();
    const next = await coordinator.cancel({
      operationId: operationId(input, "cancel-discovery"),
      expectedSessionSequence: projection.sessionSequence,
      discoveryId: requiredString(input, "discovery_id"),
      ...(optionalString(input, "reason") ? { reason: optionalString(input, "reason") } : {}),
    });
    return formatProjection(next);
  }
}

export function createDiscoveryTools(
  coordinator: DiscoveryCoordinatorFactory,
): readonly BaseTool[] {
  return [
    new StartDiscoveryTool(coordinator),
    new UpdateDiscoveryTool(coordinator),
    new CompleteDiscoveryTool(coordinator),
    new CancelDiscoveryTool(coordinator),
  ];
}

function candidateSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      path: { type: "string" },
      symbol: { type: "string" },
      score: { type: "number" },
      reasons: { type: "array", items: { type: "string" } },
      evidence_refs: { type: "array", items: { type: "string" } },
    },
    required: ["path", "score", "reasons", "evidence_refs"],
  };
}

function hypothesisSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      statement: { type: "string" },
      status: { type: "string", enum: ["open", "supported", "rejected"] },
      evidence_refs: { type: "array", items: { type: "string" } },
    },
    required: ["id", "statement", "status", "evidence_refs"],
  };
}

function parseCheckpoint(input: UnknownRecord): DiscoveryCheckpoint {
  const phase = requiredString(input, "phase");
  if (phase !== "forage" && phase !== "focus" && phase !== "deepen" && phase !== "verify") {
    throw new Error("phase 必须为 forage、focus、deepen 或 verify");
  }
  return {
    phase,
    cycle: requiredPositiveInteger(input, "cycle"),
    candidates: parseCandidates(input["candidates"], "candidates"),
    evidenceRefs: requiredStringArray(input, "evidence_refs"),
    hypotheses: parseHypotheses(input["hypotheses"]),
    openQuestions: requiredStringArray(input, "open_questions"),
    toolCallsUsed: requiredNonNegativeInteger(input, "tool_calls_used"),
    inspectedFiles: requiredStringArray(input, "inspected_files"),
  };
}

function parseCandidates(value: unknown, label: string): DiscoveryCandidate[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value.map((item, index) => {
    const record = requiredRecord(item, `${label}[${index}]`);
    return {
      path: requiredString(record, "path"),
      ...(optionalString(record, "symbol") ? { symbol: optionalString(record, "symbol") } : {}),
      score: requiredNumber(record, "score"),
      reasons: requiredStringArray(record, "reasons"),
      evidenceRefs: requiredStringArray(record, "evidence_refs"),
    };
  });
}

function parseHypotheses(value: unknown): DiscoveryHypothesis[] {
  if (!Array.isArray(value)) throw new Error("hypotheses 必须是数组");
  return value.map((item, index) => {
    const record = requiredRecord(item, `hypotheses[${index}]`);
    const status = requiredString(record, "status");
    if (status !== "open" && status !== "supported" && status !== "rejected") {
      throw new Error("hypothesis.status 必须为 open、supported 或 rejected");
    }
    return {
      id: requiredString(record, "id"),
      statement: requiredString(record, "statement"),
      status,
      evidenceRefs: requiredStringArray(record, "evidence_refs"),
    };
  });
}

type UnknownRecord = Record<string, unknown>;

function parseInput(args: string): UnknownRecord {
  let value: unknown;
  try {
    value = JSON.parse(args) as unknown;
  } catch {
    throw new Error("参数解析失败：期望 JSON 对象");
  }
  return requiredRecord(value, "参数");
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as UnknownRecord;
}

function requiredString(input: UnknownRecord, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new Error(`${key} 必须是非空字符串`);
  return value;
}

function optionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredStringArray(input: UnknownRecord, key: string): string[] {
  const value = optionalStringArray(input, key);
  if (!value) throw new Error(`${key} 必须是字符串数组`);
  return value;
}

function optionalStringArray(input: UnknownRecord, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${key} 必须是字符串数组`);
  }
  return value.map((item) => (item as string).trim());
}

function requiredNumber(input: UnknownRecord, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
  return value;
}

function requiredPositiveInteger(input: UnknownRecord, key: string): number {
  const value = requiredNumber(input, key);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是正整数`);
  return value;
}

function requiredNonNegativeInteger(input: UnknownRecord, key: string): number {
  const value = requiredNumber(input, key);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} 必须是非负整数`);
  return value;
}

function operationId(input: UnknownRecord, prefix: string): string {
  return optionalString(input, "operation_id") ?? `${prefix}:${randomUUID()}`;
}

function isDiscoveryDepth(value: string): value is DiscoveryDepth {
  return value === "quick" || value === "balanced" || value === "deep";
}

function formatProjection(value: unknown): string {
  return JSON.stringify({ kind: "discovery", projection: value });
}
