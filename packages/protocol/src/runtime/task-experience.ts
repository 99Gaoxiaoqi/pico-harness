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
import type { RuntimeParamRule, RuntimeResultRule } from "./validation.js";

export const learningVersionParam: RuntimeParamRule = (v, p) => {
  if (v !== 2) throw invalidParams(`${p} 必须是 2`);
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
export const experienceSummaryResult = exactResultShape(summaryFields);
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
    itemId: resultString,
    reason: resultString,
    modelRoute: exactResultShape(
      { providerId: resultString, modelId: resultString },
      { configRevision: resultString },
    ),
  },
);
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
type ReviewParams = WorkspaceParams &
  Omit<TaskExperienceReviewInput, "workspaceKey" | "now" | "applicability"> & {
    readonly applicability?: Pick<
      ExperienceApplicability,
      "taskFamily" | "toolNames" | "conditions"
    >;
  };
type FeedbackParams = WorkspaceParams & Omit<TaskExperienceFeedbackInput, "workspaceKey" | "now">;
export type TaskExperienceMethodMap = {
  readonly "memory.learning.query": {
    readonly params: WorkspaceParams & {
      readonly sessionId?: string;
      readonly review?: TaskExperienceCandidate["review"];
      readonly limit?: number;
    };
    readonly result: {
      readonly learningVersion: 2;
      readonly workspaceKey: string;
      readonly revision: number;
      readonly items: readonly TaskExperienceCandidate[];
      readonly reuse: readonly TaskExperienceReuse[];
    };
  };
  readonly "memory.learning.detail": {
    readonly params: WorkspaceParams & { readonly candidateId: string };
    readonly result: {
      readonly learningVersion: 2;
      readonly candidate: TaskExperienceCandidate;
      readonly observations: readonly TaskExperienceObservation[];
      readonly reuse: readonly TaskExperienceReuse[];
    };
  };
  readonly "memory.learning.review": {
    readonly params: ReviewParams;
    readonly result: { readonly learningVersion: 2; readonly candidate: TaskExperienceCandidate };
  };
  readonly "memory.learning.feedback": {
    readonly params: FeedbackParams;
    readonly result: { readonly learningVersion: 2; readonly candidate: TaskExperienceCandidate };
  };
};
export const taskExperienceParamValidators = {
  "memory.learning.query": exactParamShape(
    { workspacePath: stringParam },
    {
      sessionId: boundedNonEmptyStringParam(512),
      review: oneOfParam(["unneeded", "pending", "approved", "rejected", "deferred"]),
      limit: positiveIntegerParam,
    },
  ),
  "memory.learning.detail": exactParamShape({
    workspacePath: stringParam,
    candidateId: boundedNonEmptyStringParam(512),
  }),
  "memory.learning.review": exactParamShape(
    {
      workspacePath: stringParam,
      candidateId: boundedNonEmptyStringParam(512),
      expectedRecordRevision: positiveIntegerParam,
      expectedContentVersion: positiveIntegerParam,
      operationId: boundedNonEmptyStringParam(512),
      action: oneOfParam([
        "accept",
        "edit_accept",
        "defer",
        "reject",
        "disable",
        "archive",
        "restore",
        "delete",
      ]),
    },
    { content: boundedNonEmptyStringParam(2000), applicability: applicabilityParam },
  ),
  "memory.learning.feedback": exactParamShape({
    workspacePath: stringParam,
    candidateId: boundedNonEmptyStringParam(512),
    expectedContentVersion: positiveIntegerParam,
    operationId: boundedNonEmptyStringParam(512),
    taskId: boundedNonEmptyStringParam(512),
    taskVersion: positiveIntegerParam,
    action: oneOfParam(["not_applicable", "correct", "disable"]),
  }),
};
const version = resultOneOf([2]);
export const taskExperienceResultValidators = {
  "memory.learning.query": exactResultShape({
    learningVersion: version,
    workspaceKey: resultString,
    revision: resultNonNegativeInteger,
    items: resultArray(experienceCandidateResult),
    reuse: resultArray(experienceReuseResult),
  }),
  "memory.learning.detail": exactResultShape({
    learningVersion: version,
    candidate: experienceCandidateResult,
    observations: resultArray(experienceObservationResult),
    reuse: resultArray(experienceReuseResult),
  }),
  "memory.learning.review": exactResultShape({
    learningVersion: version,
    candidate: experienceCandidateResult,
  }),
  "memory.learning.feedback": exactResultShape({
    learningVersion: version,
    candidate: experienceCandidateResult,
  }),
};
