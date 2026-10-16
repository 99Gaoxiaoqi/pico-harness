import type {
  ExperienceApplicability,
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceReuse,
  TaskExperienceReviewInput,
  TaskExperienceFeedbackInput,
} from "@pico/core";
import type { WorkspaceParams } from "./base.js";
import { isJsonObject } from "./base.js";
import { invalidParams, invalidResult } from "./errors.js";
import {
  assertNestedShape,
  boundedNonEmptyStringParam,
  exactParamShape,
  exactResultShape,
  positiveIntegerParam,
  oneOfParam,
  resultArray,
  resultBoolean,
  resultNonNegativeInteger,
  resultOneOf,
  resultString,
  stringParam,
} from "./validation.js";
import type { RuntimeParamRule, RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export const learningVersionParam: RuntimeParamRule = (v, p) => {
  if (v !== 2 && v !== 3) throw invalidParams(`${p} 必须是 2 或 3`);
};
export const experienceSourceResult = exactResultShape({
  sessionId: resultString,
  runId: resultString,
  turnId: resultString,
  eventId: resultString,
});
export const experienceApplicabilityResult = exactResultShape(
  {
    taskFamily: resultOneOf(["general", "coding", "spreadsheet"]),
    toolNames: resultArray(resultString),
    conditions: resultArray(resultString),
  },
  {
    spreadsheet: exactResultShape({
      operation: resultOneOf(["sum"]),
      header: resultOneOf([false]),
      dataKind: resultOneOf(["finite-numbers"]),
    }),
  },
);
const stringsParam: RuntimeParamRule = (v, p) => {
  if (
    !Array.isArray(v) ||
    v.length > 20 ||
    v.some((x) => typeof x !== "string" || !x.trim() || x.length > 512)
  )
    throw invalidParams(`${p} 必须是有界字符串数组`);
};
const applicabilityParam: RuntimeParamRule = (v, p) =>
  assertNestedShape(v, p, {
    taskFamily: oneOfParam(["general", "coding", "spreadsheet"]),
    toolNames: stringsParam,
    conditions: stringsParam,
  });
const summaryFields = {
  candidateId: resultString,
  contentVersion: resultNonNegativeInteger,
  recordRevision: resultNonNegativeInteger,
  review: resultOneOf(["unneeded", "pending", "approved", "rejected", "deferred"]),
  validation: resultOneOf(["unknown", "pass", "fail", "stale"]),
  enabled: resultBoolean,
  applicability: experienceApplicabilityResult,
};
const experienceMaturityResult = resultOneOf(["unassessed", "trial", "active", "suspended"]);
const experienceRiskResult = resultOneOf(["low", "high", "unclear"]);
const experiencePromotionReasonResult = resultOneOf([
  "none",
  "two_positive_reuses",
  "deterministic_validation",
  "human_approved",
]);
const experienceSummaryOptionalFields = {
  maturity: experienceMaturityResult,
  risk: experienceRiskResult,
  promotionReason: experiencePromotionReasonResult,
  positiveReuseCount: resultNonNegativeInteger,
  reviewReason: resultString,
};
export const experienceSummaryResult = exactResultShape(
  summaryFields,
  experienceSummaryOptionalFields,
);
export const experienceCandidateResult = exactResultShape(
  {
    ...summaryFields,
    kind: resultOneOf(["task-lesson"]),
    lifecycleState: resultOneOf(["active", "archived"]),
    taskId: resultString,
    taskVersion: resultNonNegativeInteger,
    workspaceKey: resultString,
    workDir: resultString,
    sessionId: resultString,
    runId: resultString,
    failureKey: resultString,
    inputEpoch: resultNonNegativeInteger,
    settingsVersion: resultNonNegativeInteger,
    deletionRevision: resultNonNegativeInteger,
    state: resultOneOf([
      "waiting",
      "ready",
      "working",
      "saved",
      "insufficient",
      "invalidated",
      "discarded",
      "expired",
    ]),
    goal: resultString,
    content: resultString,
    sources: resultArray(experienceSourceResult),
    observationIds: resultArray(resultString),
    createdAt: resultNonNegativeInteger,
    updatedAt: resultNonNegativeInteger,
  },
  {
    ...experienceSummaryOptionalFields,
    itemId: resultString,
    reason: resultString,
    modelRoute: exactResultShape(
      { providerId: resultString, modelId: resultString },
      { configRevision: resultString },
    ),
  },
);
export const experienceRequiredConditionResult: RuntimeResultRule = (v, p) => {
  if (!isJsonObject(v)) throw invalidResult(`${p} 不是适用条件`);
  if (v.kind === "native-scope")
    exactResultShape({
      kind: resultOneOf(["native-scope"]),
      candidateId: resultString,
      claimRevision: resultNonNegativeInteger,
      claimHash: resultString,
      scopeHash: resultString,
    })(v, p);
  else if (v.kind === "spreadsheet-range")
    exactResultShape({
      kind: resultOneOf(["spreadsheet-range"]),
      operation: resultOneOf(["sum"]),
      header: resultOneOf([false]),
      dataKind: resultOneOf(["finite-numbers"]),
    })(v, p);
  else throw invalidResult(`${p} 不支持的适用条件`);
};
const experienceV3Fields: Readonly<Record<string, RuntimeResultRule>> = {
  representation: resultOneOf(["case", "method"]),
  usagePolicy: resultOneOf(["case_only", "suggestion", "review_required", "blocked"]),
  matchHints: resultArray(resultString),
  requiredConditions: resultArray(experienceRequiredConditionResult),
  scopeUnresolved: resultBoolean,
  decisionKind: resultOneOf(["high_impact", "scope_expansion", "long_term_conflict"]),
  expiresAt: resultNonNegativeInteger,
  evidenceSummary: exactResultShape({
    deliveredCount: resultNonNegativeInteger,
    independentTaskCount: resultNonNegativeInteger,
    adoptedCount: resultNonNegativeInteger,
    helpfulCount: resultNonNegativeInteger,
    contradictionCount: resultNonNegativeInteger,
    results: resultArray(
      exactResultShape({
        validation: resultOneOf(["unknown", "pass", "fail", "stale"]),
        scope: resultOneOf(["unknown", "native-claim", "spreadsheet-range", "command"]),
        count: resultNonNegativeInteger,
      }),
    ),
  }),
};
function withExperienceV3Fields(base: RuntimeResultRule): RuntimeResultRule {
  return (v, p) => {
    if (!isJsonObject(v)) throw invalidResult(`${p} 不是经验记录`);
    const legacy = Object.fromEntries(
      Object.entries(v).filter(([key]) => !Object.hasOwn(experienceV3Fields, key)),
    );
    base(legacy, p);
    for (const [key, rule] of Object.entries(experienceV3Fields))
      if (Object.hasOwn(v, key)) rule(v[key], `${p}.${key}`);
  };
}
export const experienceSummaryV3Result = withExperienceV3Fields(experienceSummaryResult);
export const experienceCandidateV3Result = withExperienceV3Fields(experienceCandidateResult);
export interface RuntimeLearningReceiptSummary {
  readonly operationId: string;
  readonly sessionId: string;
  readonly committedAt: number;
  readonly createdItemCount: number;
}
const receiptSummaryResult = exactResultShape({
  operationId: resultString,
  sessionId: resultString,
  committedAt: resultNonNegativeInteger,
  createdItemCount: resultNonNegativeInteger,
});
const isV3 = (v: unknown): boolean => isJsonObject(v) && v.learningVersion === 3;
const versionedResult =
  (v2: RuntimeResultRule, v3: RuntimeResultRule): RuntimeResultRule =>
  (v, p) =>
    (isV3(v) ? v3 : v2)(v, p);
const requiredConditionsParam: RuntimeParamRule = (v, p) => {
  if (!Array.isArray(v) || v.length > 8) throw invalidParams(`${p} 最多 8 个条件`);
  try {
    v.forEach((item, index) => experienceRequiredConditionResult(item, `${p}[${index}]`));
  } catch {
    throw invalidParams(`${p} 包含不支持的条件`);
  }
};
const sourceParam: RuntimeParamRule = (v, p) => {
  assertNestedShape(v, p, {
    sessionId: boundedNonEmptyStringParam(512),
    runId: boundedNonEmptyStringParam(512),
    turnId: boundedNonEmptyStringParam(512),
    eventId: boundedNonEmptyStringParam(512),
  });
};
export const experienceReuseResult = exactResultShape(
  {
    reuseId: resultString,
    workspaceKey: resultString,
    candidateId: resultString,
    contentVersion: resultNonNegativeInteger,
    itemId: resultString,
    itemVersion: resultNonNegativeInteger,
    taskId: resultString,
    taskVersion: resultNonNegativeInteger,
    sessionId: resultString,
    runId: resultString,
    referenceHash: resultString,
    adoption: resultOneOf(["unknown", "observed", "not_applied"]),
    validation: resultOneOf(["unknown", "pass", "fail", "stale"]),
    excluded: resultBoolean,
    sources: resultArray(experienceSourceResult),
    createdAt: resultNonNegativeInteger,
    updatedAt: resultNonNegativeInteger,
  },
  { referenceContent: resultString },
);
const observationArgumentsResult: RuntimeResultRule = (v, p) => {
  if (
    !isJsonObject(v) ||
    Object.values(v).some(
      (x) => x !== null && typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean",
    )
  )
    throw invalidResult(`${p} 不是脱敏参数`);
};
export const experienceObservationResult = exactResultShape(
  {
    observationId: resultString,
    taskId: resultString,
    taskVersion: resultNonNegativeInteger,
    kind: resultOneOf(["user-input", "tool-result", "terminal"]),
    source: experienceSourceResult,
    sequence: resultNonNegativeInteger,
    summary: resultString,
    coverage: resultOneOf(["complete", "limited", "unavailable"]),
    createdAt: resultNonNegativeInteger,
  },
  {
    status: resultOneOf(["succeeded", "failed", "rejected", "cancelled", "interrupted"]),
    toolName: resultString,
    preparedEventId: resultString,
    correction: resultBoolean,
    arguments: observationArgumentsResult,
  },
);
type ReviewParams = WorkspaceParams & { readonly learningVersion?: 2 | 3 } & Omit<
    TaskExperienceReviewInput,
    "workspaceKey" | "now" | "applicability" | "requiredConditions"
  > & {
    readonly requiredConditions?: readonly (
      | {
          readonly kind: "native-scope";
          readonly candidateId: string;
          readonly claimRevision: number;
          readonly claimHash: string;
          readonly scopeHash: string;
        }
      | {
          readonly kind: "spreadsheet-range";
          readonly operation: "sum";
          readonly header: false;
          readonly dataKind: "finite-numbers";
        }
    )[];
    readonly applicability?: Pick<
      ExperienceApplicability,
      "taskFamily" | "toolNames" | "conditions"
    >;
  };
type FeedbackParams = WorkspaceParams & { readonly learningVersion?: 2 | 3 } & Omit<
    TaskExperienceFeedbackInput,
    "workspaceKey" | "now" | "source"
  > & {
    readonly source?: {
      readonly sessionId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly eventId: string;
    };
  };
export type TaskExperienceMethodMap = {
  readonly "memory.learning.query": {
    readonly params: WorkspaceParams & {
      readonly learningVersion?: 2 | 3;
      readonly representation?: "case" | "method";
      readonly usagePolicy?: TaskExperienceCandidate["usagePolicy"];
      readonly lifecycleState?: "active" | "archived";
      readonly query?: string;
      readonly sessionId?: string;
      readonly review?: TaskExperienceCandidate["review"];
      readonly limit?: number;
    };
    readonly result: {
      readonly learningVersion: 2 | 3;
      readonly workspaceKey: string;
      readonly revision: number;
      readonly items: readonly TaskExperienceCandidate[];
      readonly reuse: readonly TaskExperienceReuse[];
      readonly receipts?: readonly RuntimeLearningReceiptSummary[];
    };
  };
  readonly "memory.learning.detail": {
    readonly params: WorkspaceParams & {
      readonly candidateId: string;
      readonly learningVersion?: 2 | 3;
    };
    readonly result: {
      readonly learningVersion: 2 | 3;
      readonly candidate: TaskExperienceCandidate;
      readonly observations: readonly TaskExperienceObservation[];
      readonly reuse: readonly TaskExperienceReuse[];
    };
  };
  readonly "memory.learning.review": {
    readonly params: ReviewParams;
    readonly result: {
      readonly learningVersion: 2 | 3;
      readonly candidate: TaskExperienceCandidate;
    };
  };
  readonly "memory.learning.feedback": {
    readonly params: FeedbackParams;
    readonly result: {
      readonly learningVersion: 2 | 3;
      readonly candidate: TaskExperienceCandidate;
    };
  };
};
const legacyActions = [
  "accept",
  "edit_accept",
  "defer",
  "reject",
  "disable",
  "archive",
  "restore",
  "delete",
];
const queryOptional = {
  sessionId: boundedNonEmptyStringParam(512),
  review: oneOfParam(["unneeded", "pending", "approved", "rejected", "deferred"]),
  limit: positiveIntegerParam,
  learningVersion: learningVersionParam,
};
const reviewRequired = {
  workspacePath: stringParam,
  candidateId: boundedNonEmptyStringParam(512),
  expectedRecordRevision: positiveIntegerParam,
  expectedContentVersion: positiveIntegerParam,
  operationId: boundedNonEmptyStringParam(512),
  action: oneOfParam(legacyActions),
};
const reviewOptional = {
  content: boundedNonEmptyStringParam(2000),
  applicability: applicabilityParam,
  learningVersion: learningVersionParam,
};
const taskFeedbackRequired = {
  workspacePath: stringParam,
  candidateId: boundedNonEmptyStringParam(512),
  expectedContentVersion: positiveIntegerParam,
  operationId: boundedNonEmptyStringParam(512),
  taskId: boundedNonEmptyStringParam(512),
  taskVersion: positiveIntegerParam,
  action: oneOfParam(["not_applicable", "correct", "disable"]),
};
export const taskExperienceParamValidators = {
  "memory.learning.query": (v) =>
    (isV3(v)
      ? exactParamShape(
          { workspacePath: stringParam },
          {
            ...queryOptional,
            representation: oneOfParam(["case", "method"]),
            usagePolicy: oneOfParam(["case_only", "suggestion", "review_required", "blocked"]),
            lifecycleState: oneOfParam(["active", "archived"]),
            query: boundedNonEmptyStringParam(4096),
          },
        )
      : exactParamShape({ workspacePath: stringParam }, queryOptional))(v),
  "memory.learning.detail": exactParamShape(
    { workspacePath: stringParam, candidateId: boundedNonEmptyStringParam(512) },
    { learningVersion: learningVersionParam },
  ),
  "memory.learning.review": (v) =>
    (isV3(v)
      ? exactParamShape(
          { ...reviewRequired, action: oneOfParam([...legacyActions, "revise", "keep_case"]) },
          {
            ...reviewOptional,
            representation: oneOfParam(["case", "method"]),
            matchHints: stringsParam,
            requiredConditions: requiredConditionsParam,
          },
        )
      : exactParamShape(reviewRequired, reviewOptional))(v),
  "memory.learning.feedback": (v) =>
    (isV3(v)
      ? exactParamShape(taskFeedbackRequired, {
          learningVersion: learningVersionParam,
          source: sourceParam,
        })
      : exactParamShape(taskFeedbackRequired, { learningVersion: learningVersionParam }))(v),
} satisfies Readonly<Record<keyof TaskExperienceMethodMap, RuntimeParamValidator>>;
export const taskExperienceResultValidators = {
  "memory.learning.query": versionedResult(
    exactResultShape({
      learningVersion: resultOneOf([2]),
      workspaceKey: resultString,
      revision: resultNonNegativeInteger,
      items: resultArray(experienceCandidateResult),
      reuse: resultArray(experienceReuseResult),
    }),
    exactResultShape(
      {
        learningVersion: resultOneOf([3]),
        workspaceKey: resultString,
        revision: resultNonNegativeInteger,
        items: resultArray(experienceCandidateV3Result),
        reuse: resultArray(experienceReuseResult),
      },
      { receipts: resultArray(receiptSummaryResult) },
    ),
  ),
  "memory.learning.detail": versionedResult(
    exactResultShape({
      learningVersion: resultOneOf([2]),
      candidate: experienceCandidateResult,
      observations: resultArray(experienceObservationResult),
      reuse: resultArray(experienceReuseResult),
    }),
    exactResultShape({
      learningVersion: resultOneOf([3]),
      candidate: experienceCandidateV3Result,
      observations: resultArray(experienceObservationResult),
      reuse: resultArray(experienceReuseResult),
    }),
  ),
  "memory.learning.review": versionedResult(
    exactResultShape({ learningVersion: resultOneOf([2]), candidate: experienceCandidateResult }),
    exactResultShape({ learningVersion: resultOneOf([3]), candidate: experienceCandidateV3Result }),
  ),
  "memory.learning.feedback": versionedResult(
    exactResultShape({ learningVersion: resultOneOf([2]), candidate: experienceCandidateResult }),
    exactResultShape({ learningVersion: resultOneOf([3]), candidate: experienceCandidateV3Result }),
  ),
} satisfies Readonly<Record<keyof TaskExperienceMethodMap, RuntimeResultRule>>;
