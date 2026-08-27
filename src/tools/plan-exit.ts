import { createHash, randomUUID } from "node:crypto";
import type { PlanHandoffController } from "../engine/plan-handoff.js";
import type { PlanCoordinator } from "../plan/coordinator.js";
import {
  isPlanStepStatus,
  normalizePlanProposalInput,
  PlanConflictError,
  type PlanProposalInput,
} from "../plan/contract.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";

export type PlanCoordinatorFactory = () => PlanCoordinator;

interface SubmitPlanArgs {
  readonly title: string;
  readonly overview?: string;
  readonly steps: readonly {
    readonly id?: string;
    readonly title: string;
    readonly description: string;
  }[];
  readonly risks?: readonly string[];
  readonly operationId?: string;
}

/** Submits a durable proposal and latches a normal engine handoff. */
export class SubmitPlanTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(
    private readonly coordinator: PlanCoordinatorFactory,
    private readonly handoff: PlanHandoffController,
    private readonly sessionId: string,
    private readonly runId: () => string,
  ) {}

  name(): string {
    return "submit_plan";
  }

  definition(): ToolDefinition {
    return {
      name: "submit_plan",
      description:
        "提交结构化实施计划供用户审批。成功后当前规划 Run 会正常结束；禁止在提交后继续执行或修改文件。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          overview: { type: "string" },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
              },
              required: ["title", "description"],
            },
          },
          risks: { type: "array", items: { type: "string" } },
          operationId: { type: "string" },
        },
        required: ["title", "steps"],
      },
    };
  }

  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const parsed = parseSubmitPlanArgs(args);
    const coordinator = this.coordinator();
    const before = await coordinator.project();
    const operationId = parsed.operationId ?? `submit-plan:${randomUUID()}`;
    const proposal = proposalInput(parsed);
    const revisionBase =
      before.pendingProposal ??
      (before.revisionRequest
        ? before.proposals.find(
            (candidate) =>
              candidate.planId === before.revisionRequest?.planId &&
              candidate.revision === before.revisionRequest.expectedRevision,
          )
        : undefined);
    const normalizedProposal = normalizePlanProposalInput({
      ...proposal,
      ...(revisionBase ? { planId: revisionBase.planId } : {}),
    });
    const unchanged =
      revisionBase !== undefined && sameProposalContent(revisionBase, normalizedProposal);
    if (unchanged && before.revisionRequest) {
      throw new PlanConflictError("Plan revision must change the normalized proposal content");
    }
    const projection = unchanged
      ? before
      : revisionBase
        ? await coordinator.revise({
            operationId,
            expectedSessionSequence: before.sessionSequence,
            planId: revisionBase.planId,
            expectedRevision: revisionBase.revision,
            proposal: normalizedProposal,
          })
        : await coordinator.propose({
            operationId,
            expectedSessionSequence: before.sessionSequence,
            proposal: normalizedProposal,
          });
    context?.signal?.throwIfAborted();
    const pending = projection.pendingProposal;
    if (!pending) throw new Error("Plan submission did not create a pending proposal");
    const handoff = {
      kind: "plan_handoff" as const,
      sessionId: this.sessionId,
      runId: this.runId(),
      planId: pending.planId,
      revision: pending.revision,
      expectedSessionSequence: projection.sessionSequence,
      projection,
    };
    this.handoff.mark(handoff);
    return JSON.stringify(handoff);
  }
}

function sameProposalContent(
  current: {
    readonly title: string;
    readonly overview?: string;
    readonly steps: readonly {
      readonly id: string;
      readonly title: string;
      readonly description: string;
    }[];
    readonly risks?: readonly string[];
  },
  next: PlanProposalInput,
): boolean {
  return (
    current.title === next.title &&
    current.overview === next.overview &&
    JSON.stringify(
      current.steps.map(({ id, title, description }) => ({ id, title, description })),
    ) === JSON.stringify(next.steps) &&
    JSON.stringify(current.risks ?? []) === JSON.stringify(next.risks ?? [])
  );
}

export class UpdatePlanTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = { kind: "none" } as const;
  constructor(
    private readonly coordinator: PlanCoordinatorFactory,
    private readonly planId: string,
  ) {}
  name(): string {
    return "update_plan";
  }
  definition(): ToolDefinition {
    return {
      name: "update_plan",
      description: "更新已批准计划中一个执行步骤的状态；最后一步完成时原子完成整个 execution。",
      inputSchema: {
        type: "object",
        properties: {
          stepId: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
          note: { type: "string" },
          operationId: { type: "string" },
        },
        required: ["stepId", "status"],
      },
    };
  }
  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const value = JSON.parse(args) as Record<string, unknown>;
    if (typeof value["stepId"] !== "string" || !isPlanStepStatus(value["status"])) {
      throw new Error("update_plan requires stepId and a valid status");
    }
    const coordinator = this.coordinator();
    const before = await coordinator.project();
    const projection = await coordinator.updateStep({
      operationId: updatePlanOperationId(value["operationId"], context?.toolCallId, this.planId),
      expectedSessionSequence: before.sessionSequence,
      planId: this.planId,
      stepId: value["stepId"],
      status: value["status"],
      ...(typeof value["note"] === "string" ? { note: value["note"] } : {}),
    });
    return JSON.stringify({ kind: "plan_execution", projection });
  }
}

function updatePlanOperationId(
  explicit: unknown,
  toolCallId: string | undefined,
  planId: string,
): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (toolCallId?.trim()) {
    const digest = createHash("sha256")
      .update(planId)
      .update("\0")
      .update(toolCallId.trim())
      .digest("hex");
    return `update-plan:tool-call:${digest}`;
  }
  return `update-plan:${randomUUID()}`;
}

export class CancelPlanTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = { kind: "none" } as const;
  constructor(
    private readonly coordinator: PlanCoordinatorFactory,
    private readonly planId: string,
  ) {}
  name(): string {
    return "cancel_plan";
  }
  definition(): ToolDefinition {
    return {
      name: "cancel_plan",
      description: "明确取消当前已批准计划的执行。",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" }, operationId: { type: "string" } },
      },
    };
  }
  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }
  async execute(args: string): Promise<string> {
    const value = JSON.parse(args) as Record<string, unknown>;
    const coordinator = this.coordinator();
    const before = await coordinator.project();
    const projection = await coordinator.cancel({
      operationId:
        typeof value["operationId"] === "string"
          ? value["operationId"]
          : `cancel-plan:${randomUUID()}`,
      expectedSessionSequence: before.sessionSequence,
      planId: this.planId,
      ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
    });
    return JSON.stringify({ kind: "plan_execution", projection });
  }
}

function parseSubmitPlanArgs(args: string): SubmitPlanArgs {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("submit_plan arguments must be valid JSON");
  }
  if (!isRecord(value) || typeof value["title"] !== "string" || !Array.isArray(value["steps"])) {
    throw new Error("submit_plan requires title and steps");
  }
  const steps = value["steps"].map((step, index) => {
    if (
      !isRecord(step) ||
      typeof step["title"] !== "string" ||
      typeof step["description"] !== "string"
    ) {
      throw new Error(`submit_plan step ${index + 1} requires title and description`);
    }
    return {
      ...(typeof step["id"] === "string" ? { id: step["id"] } : {}),
      title: step["title"],
      description: step["description"],
    };
  });
  const risks = value["risks"];
  if (
    risks !== undefined &&
    (!Array.isArray(risks) || risks.some((risk) => typeof risk !== "string"))
  ) {
    throw new Error("submit_plan risks must be an array of strings");
  }
  return {
    title: value["title"],
    ...(typeof value["overview"] === "string" ? { overview: value["overview"] } : {}),
    steps,
    ...(risks ? { risks: risks as string[] } : {}),
    ...(typeof value["operationId"] === "string" ? { operationId: value["operationId"] } : {}),
  };
}

function proposalInput(input: SubmitPlanArgs): Omit<PlanProposalInput, "planId"> {
  return {
    title: input.title,
    ...(input.overview ? { overview: input.overview } : {}),
    steps: input.steps.map((step, index) => ({
      id: step.id?.trim() || `step-${index + 1}`,
      title: step.title,
      description: step.description,
    })),
    ...(input.risks?.length ? { risks: input.risks } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
