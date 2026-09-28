// Plan, goal, discovery, approval, and prompt contracts with their boundary rules.
import type {
  ApprovalId,
  JsonObject,
  JsonValue,
  PlanId,
  PromptId,
  RunId,
  SessionId,
  WorkspaceParams,
} from "./base.js";
import { invalidParams } from "./errors.js";
import { runtimeRunResult } from "./session.js";
import type { RuntimeRun } from "./session.js";
import {
  assertNestedShape,
  exactParamShape,
  exactResultShape,
  finiteNumberParam,
  jsonValueParam,
  oneOfParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultNullable,
  resultOneOf,
  resultShape,
  resultString,
  resultStringArray,
  stringArrayParam,
  stringParam,
  workspaceSessionParams,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimePlanStep = JsonObject & {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "pending" | "in_progress" | "completed" | "skipped";
  readonly note?: string;
};

export type RuntimePlanProposal = JsonObject & {
  readonly planId: PlanId;
  readonly revision: number;
  readonly title: string;
  readonly overview?: string;
  readonly steps: readonly RuntimePlanStep[];
  readonly risks?: readonly string[];
  readonly status: "pending" | "stale" | "approved" | "rejected";
  readonly proposedAt: string;
};

export type RuntimePlanExecution = JsonObject & {
  readonly graph?: JsonObject & { readonly graphId: string; readonly epoch: number };
  readonly planId: PlanId;
  readonly revision: number;
  readonly status: "active" | "interrupted" | "completed" | "cancelled";
  readonly steps: readonly RuntimePlanStep[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
};

export type RuntimePlanRevisionRequest = JsonObject & {
  readonly planId: PlanId;
  readonly expectedRevision: number;
  readonly feedback: string;
  readonly operationId: string;
  readonly requestedAt: string;
};

export type RuntimePlanProjection = JsonObject & {
  readonly sessionId: SessionId;
  readonly sessionSequence: number;
  readonly controlEpoch?: string;
  readonly operationId?: string;
  readonly proposals: readonly RuntimePlanProposal[];
  readonly latestProposal?: RuntimePlanProposal;
  readonly pendingProposal?: RuntimePlanProposal;
  readonly execution?: RuntimePlanExecution;
  readonly revisionRequest?: RuntimePlanRevisionRequest;
  readonly reviewClaim?: JsonObject & {
    readonly operationId: string;
    readonly planId: PlanId;
    readonly revision: number;
    readonly controlEpoch: string;
    readonly action:
      | "execute"
      | "continue_editing"
      | "reject_exit"
      | "resume_execution"
      | "cancel_execution"
      | "replan_execution";
    readonly feedback?: string;
    readonly claimedAt: string;
  };
};

export type RuntimePlanControlSnapshot = JsonObject & {
  readonly version: 1;
  readonly availability: "ready" | "unavailable";
  readonly state:
    | "none"
    | "pending_review"
    | "admitting"
    | "admitted"
    | "committed_executing"
    | "revision"
    | "interrupted"
    | "recovery_required"
    | "terminal";
  readonly projection: RuntimePlanProjection;
  readonly activeRunId?: RunId;
  readonly operationId?: string;
};

export type RuntimeDiscoveryDepth = "quick" | "balanced" | "deep";

export type RuntimeDiscoveryStatus = "active" | "interrupted" | "completed" | "cancelled";

export type RuntimeDiscoveryRun = JsonObject & {
  readonly discoveryId: string;
  readonly objective: string;
  readonly depth: RuntimeDiscoveryDepth;
  readonly phase: "forage" | "focus" | "deepen" | "verify";
  readonly status: RuntimeDiscoveryStatus;
  readonly cycle: number;
  readonly inspectedFiles: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly openQuestions: readonly string[];
  readonly candidates: readonly JsonObject[];
  readonly branches: readonly JsonObject[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reason?: string;
  readonly report?: JsonObject;
};

export type RuntimeDiscoveryProjection = JsonObject & {
  readonly sessionId: SessionId;
  readonly sessionSequence: number;
  readonly discoveries: readonly RuntimeDiscoveryRun[];
  readonly latest?: RuntimeDiscoveryRun;
  readonly active?: RuntimeDiscoveryRun;
};

export type RuntimeGoalStatus =
  | "active"
  | "waiting"
  | "paused"
  | "achieved"
  | "impossible"
  | "stalled"
  | "budget_limited"
  | "max_iterations"
  | "cleared";

export type RuntimeGoalEvaluation = {
  readonly met?: boolean;
  readonly impossible?: boolean;
  readonly progress?: boolean;
  readonly waiting?: boolean;
  readonly evaluatorFailed?: boolean;
  readonly reason: string;
  readonly at: number;
};

export type RuntimeGoal = {
  readonly id: string;
  readonly revision: number;
  readonly condition: string;
  readonly status: RuntimeGoalStatus;
  readonly createdAt: number;
  readonly maxIterations: number;
  readonly blockCap: number;
  readonly tokenBudget?: number;
  readonly iterations: number;
  readonly tokensAtStart: number;
  readonly tokensNow: number;
  readonly tokensBaselinePending: boolean;
  readonly consecutiveNoProgress: number;
  readonly lastReason?: string;
  readonly lastEvaluation?: RuntimeGoalEvaluation;
  readonly armedAt?: number;
  readonly pausedAt?: number;
  readonly achievedAt?: number;
};

export type RuntimeGoalContinuationIntent = {
  readonly goalId: string;
  readonly revision: number;
  readonly generation: number;
  readonly triggeringRunId?: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly runId: string;
  readonly daemonRunId: string;
  readonly turnId: string;
  readonly invocationId: string;
  readonly runStartedEventId: string;
  readonly runStartedAt: number;
};

export type RuntimeGoalExecutionRef = RuntimeGoalContinuationIntent & {
  readonly origin: "user" | "goal";
  readonly started?: boolean;
};

export type RuntimeGoalControlLease = {
  readonly goalId: string;
  readonly generation: number;
};

export type RuntimeGoalCoordinator = {
  readonly pendingContinuation: RuntimeGoalContinuationIntent | null;
  readonly currentExecution: RuntimeGoalExecutionRef | null;
  readonly lastSettledRunId?: string;
  readonly workTokens: number;
  readonly accountedRunIds: readonly string[];
};

export type RuntimeGoalSnapshot = {
  readonly stateVersion: 3;
  readonly currentGoal: RuntimeGoal | null;
  readonly controlLease: RuntimeGoalControlLease | null;
  readonly coordinator: RuntimeGoalCoordinator;
};

const runtimeGoalResult = exactResultShape(
  {
    id: resultString,
    revision: resultFiniteNumber,
    condition: resultString,
    status: resultOneOf([
      "active",
      "waiting",
      "paused",
      "achieved",
      "impossible",
      "stalled",
      "budget_limited",
      "max_iterations",
      "cleared",
    ]),
    createdAt: resultFiniteNumber,
    maxIterations: resultFiniteNumber,
    blockCap: resultFiniteNumber,
    iterations: resultFiniteNumber,
    tokensAtStart: resultFiniteNumber,
    tokensNow: resultFiniteNumber,
    tokensBaselinePending: resultBoolean,
    consecutiveNoProgress: resultFiniteNumber,
    lastEvaluation: exactResultShape(
      { reason: resultString, at: resultFiniteNumber },
      {
        met: resultBoolean,
        impossible: resultBoolean,
        progress: resultBoolean,
        waiting: resultBoolean,
        evaluatorFailed: resultBoolean,
      },
    ),
  },
  {
    tokenBudget: resultFiniteNumber,
    lastReason: resultString,
    armedAt: resultFiniteNumber,
    pausedAt: resultFiniteNumber,
    achievedAt: resultFiniteNumber,
  },
);

const runtimeGoalContinuationIntentResult = exactResultShape(
  {
    goalId: resultString,
    revision: resultFiniteNumber,
    generation: resultFiniteNumber,
    prompt: resultString,
    createdAt: resultFiniteNumber,
    runId: resultString,
    daemonRunId: resultString,
    turnId: resultString,
    invocationId: resultString,
    runStartedEventId: resultString,
    runStartedAt: resultFiniteNumber,
  },
  { triggeringRunId: resultString },
);

const runtimeGoalCoordinatorResult = exactResultShape(
  {
    pendingContinuation: resultNullable(runtimeGoalContinuationIntentResult),
    currentExecution: resultNullable(
      exactResultShape(
        {
          goalId: resultString,
          revision: resultFiniteNumber,
          generation: resultFiniteNumber,
          prompt: resultString,
          createdAt: resultFiniteNumber,
          runId: resultString,
          daemonRunId: resultString,
          turnId: resultString,
          invocationId: resultString,
          runStartedEventId: resultString,
          runStartedAt: resultFiniteNumber,
          origin: resultOneOf(["user", "goal"]),
        },
        { triggeringRunId: resultString, started: resultBoolean },
      ),
    ),
    workTokens: resultFiniteNumber,
    accountedRunIds: resultStringArray,
  },
  { lastSettledRunId: resultString },
);

const runtimeGoalSnapshotResult = exactResultShape({
  stateVersion: resultOneOf([3]),
  currentGoal: resultNullable(runtimeGoalResult),
  controlLease: resultNullable(
    exactResultShape({ goalId: resultString, generation: resultFiniteNumber }),
  ),
  coordinator: runtimeGoalCoordinatorResult,
});

const runtimePlanStepResult = resultShape(
  {
    id: resultString,
    title: resultString,
    description: resultString,
    status: resultOneOf(["pending", "in_progress", "completed", "skipped"]),
  },
  { note: resultString },
);

const runtimePlanProposalResult = resultShape(
  {
    planId: resultString,
    revision: resultFiniteNumber,
    title: resultString,
    steps: resultArray(runtimePlanStepResult),
    status: resultOneOf(["pending", "stale", "approved", "rejected"]),
    proposedAt: resultString,
  },
  { overview: resultString, risks: resultStringArray },
);

export const runtimePlanProjectionResult = resultShape(
  {
    sessionId: resultString,
    sessionSequence: resultFiniteNumber,
    proposals: resultArray(runtimePlanProposalResult),
  },
  {
    latestProposal: runtimePlanProposalResult,
    pendingProposal: runtimePlanProposalResult,
    execution: resultShape(
      {
        planId: resultString,
        revision: resultFiniteNumber,
        status: resultOneOf(["active", "interrupted", "completed", "cancelled"]),
        steps: resultArray(runtimePlanStepResult),
        startedAt: resultString,
        updatedAt: resultString,
      },
      { reason: resultString },
    ),
    controlEpoch: resultString,
    operationId: resultString,
    revisionRequest: resultShape({
      planId: resultString,
      expectedRevision: resultFiniteNumber,
      feedback: resultString,
      operationId: resultString,
      requestedAt: resultString,
    }),
    reviewClaim: resultShape(
      {
        operationId: resultString,
        planId: resultString,
        revision: resultFiniteNumber,
        controlEpoch: resultString,
        action: resultOneOf([
          "execute",
          "continue_editing",
          "reject_exit",
          "resume_execution",
          "cancel_execution",
          "replan_execution",
        ]),
        claimedAt: resultString,
      },
      { feedback: resultString },
    ),
  },
);

export const runtimePlanControlSnapshotResult = resultShape(
  {
    version: resultOneOf([1]),
    availability: resultOneOf(["ready", "unavailable"]),
    state: resultOneOf([
      "none",
      "pending_review",
      "admitting",
      "admitted",
      "committed_executing",
      "revision",
      "interrupted",
      "recovery_required",
      "terminal",
    ]),
    projection: runtimePlanProjectionResult,
  },
  { activeRunId: resultString, operationId: resultString },
);

export type PlanningMethodMap = {
  readonly "goal.get": {
    readonly params: WorkspaceParams & { readonly sessionId: SessionId };
    readonly result: { readonly goal: RuntimeGoalSnapshot | null };
  };
  readonly "goal.control": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly action: "arm" | "pause" | "resume" | "clear";
      readonly expectedRevision: number;
      readonly goalId?: string;
      readonly condition?: string;
      readonly tokenBudget?: number;
      readonly maxIterations?: number;
      readonly blockCap?: number;
    };
    readonly result: { readonly goal: RuntimeGoalSnapshot };
  };
  readonly "approval.respond": {
    readonly params: WorkspaceParams & {
      readonly approvalId: ApprovalId;
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly decision: "allow_once" | "allow_session" | "deny";
      readonly reason?: string;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "plan.respond": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly planId: PlanId;
      readonly action:
        | "execute"
        | "continue_editing"
        | "reject_exit"
        | "resume_execution"
        | "cancel_execution"
        | "replan_execution";
      readonly expectedRevision: number;
      readonly expectedSessionSequence: number;
      readonly controlEpoch: string;
      readonly feedback?: string;
    };
    readonly result: {
      readonly accepted: boolean;
      readonly projection: RuntimePlanProjection;
      readonly run?: RuntimeRun;
    };
  };
  readonly "prompt.respond": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly answer: JsonValue;
      readonly idempotencyKey?: string;
    };
    readonly result: { readonly accepted: boolean; readonly alreadyResolved: boolean };
  };
  readonly "prompt.cancel": {
    readonly params: WorkspaceParams & {
      readonly promptId: PromptId;
      readonly runId?: RunId;
      readonly sessionId?: SessionId;
      readonly reason?: string;
    };
    readonly result: { readonly cancelled: boolean };
  };
};

export const planningParamValidators = {
  "goal.get": workspaceSessionParams,
  "goal.control": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      action: oneOfParam(["arm", "pause", "resume", "clear"]),
      expectedRevision: finiteNumberParam,
    },
    {
      goalId: stringParam,
      condition: stringParam,
      tokenBudget: finiteNumberParam,
      maxIterations: finiteNumberParam,
      blockCap: finiteNumberParam,
    },
  ),
  "approval.respond": exactParamShape(
    {
      workspacePath: stringParam,
      approvalId: stringParam,
      decision: oneOfParam(["allow_once", "allow_session", "deny"]),
    },
    {
      runId: stringParam,
      sessionId: stringParam,
      reason: stringParam,
      idempotencyKey: stringParam,
    },
  ),
  "plan.respond": (value: Record<string, unknown>) => {
    assertNestedShape(
      value,
      "params",
      {
        workspacePath: stringParam,
        sessionId: stringParam,
        planId: stringParam,
        action: oneOfParam([
          "execute",
          "continue_editing",
          "reject_exit",
          "resume_execution",
          "cancel_execution",
          "replan_execution",
        ]),
        expectedRevision: finiteNumberParam,
        expectedSessionSequence: finiteNumberParam,
        controlEpoch: stringParam,
      },
      { feedback: stringParam },
    );
    if (value["action"] === "continue_editing") {
      const feedback = value["feedback"];
      if (typeof feedback !== "string" || feedback.trim().length === 0) {
        throw invalidParams("params.feedback 在 continue_editing 时为必填字段");
      }
    }
  },
  "prompt.respond": exactParamShape(
    { workspacePath: stringParam, promptId: stringParam, answer: jsonValueParam },
    { runId: stringParam, sessionId: stringParam, idempotencyKey: stringParam },
  ),
  "prompt.cancel": exactParamShape(
    { workspacePath: stringParam, promptId: stringParam },
    { runId: stringParam, sessionId: stringParam, reason: stringParam },
  ),
} satisfies Readonly<Record<keyof PlanningMethodMap, RuntimeParamValidator>>;

export const planningResultValidators = {
  "goal.get": exactResultShape({ goal: resultNullable(runtimeGoalSnapshotResult) }),
  "goal.control": exactResultShape({ goal: runtimeGoalSnapshotResult }),
  "approval.respond": exactResultShape({
    accepted: resultBoolean,
    alreadyResolved: resultBoolean,
  }),
  "plan.respond": exactResultShape(
    { accepted: resultBoolean, projection: runtimePlanProjectionResult },
    { run: runtimeRunResult },
  ),
  "prompt.respond": exactResultShape({
    accepted: resultBoolean,
    alreadyResolved: resultBoolean,
  }),
  "prompt.cancel": exactResultShape({ cancelled: resultBoolean }),
} satisfies Readonly<Record<keyof PlanningMethodMap, RuntimeResultRule>>;
