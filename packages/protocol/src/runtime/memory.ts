// Atomic Memory Item management, settings, and context-preview contracts.
import type { JsonObject, WorkspaceParams } from "./base.js";
import type { ExecutionLearningStatus, TaskExperienceSummary } from "@pico/core";
import {
  learningVersionParam,
  experienceSummaryResult,
  experienceSummaryV3Result,
  taskExperienceParamValidators,
  taskExperienceResultValidators,
} from "./task-experience.js";
import type { TaskExperienceMethodMap } from "./task-experience.js";
import { isJsonObject } from "./base.js";
import { invalidResult } from "./errors.js";
import { invalidParams } from "./errors.js";
import {
  booleanParam,
  boundedNonEmptyStringParam,
  enumArrayParam,
  exactParamShape,
  exactResultShape,
  nonNegativeIntegerParam,
  nullableParam,
  oneOfParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultNonNegativeInteger,
  resultNullable,
  resultOneOf,
  resultString,
  stringParam,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeMemoryItemKind =
  | "preference"
  | "identity"
  | "context"
  | "knowledge"
  | "failure"
  | "note";

export type RuntimeMemoryStatementType = "fact" | "plan" | "prediction";

export type RuntimeMemoryTemporalType = "undated" | "point" | "interval" | "open_ended";

export type RuntimeMemoryScopeType = "global" | "workspace";

export type RuntimeMemoryLifecycleState = "active" | "archived";

export type RuntimeMemoryItemOrigin = "agent_extracted" | "user_requested";

export type RuntimeMemoryItemSource = JsonObject & {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly eventId: string;
};

/** Direct projection of the authoritative atomic Item and its current provenance. */
type RuntimeMemoryItemFields = JsonObject & {
  readonly sourceType?: "execution-validated" | "reviewed-reference";
  readonly taskExperience?: TaskExperienceSummary & JsonObject;
  readonly taskAcceptance?: JsonObject & {
    readonly candidateId: string;
    readonly predicateId: "test-target-pass.v1" | "command-conditions.v1";
    readonly targetId: string;
    readonly targetLabel: string;
    readonly acceptedAt: number;
    readonly claimHash: string;
    readonly scopeHash: string;
  };
  readonly itemId: string;
  readonly version: number;
  readonly content: string;
  readonly kind: RuntimeMemoryItemKind;
  readonly statementType: RuntimeMemoryStatementType;
  readonly temporalType: RuntimeMemoryTemporalType;
  readonly scopeType: RuntimeMemoryScopeType;
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly lifecycleState: RuntimeMemoryLifecycleState;
  readonly origin: RuntimeMemoryItemOrigin;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly executionEvidence?: JsonObject & {
    readonly candidateId: string;
    readonly confirmedAt: number;
    readonly verificationCount: number;
  };
};

export type RuntimeMemoryItem = RuntimeMemoryItemFields & {
  readonly sources: readonly RuntimeMemoryItemSource[];
};

/** Bounded management-list projection; complete provenance remains in memory.get. */
export type RuntimeMemoryListItem = RuntimeMemoryItemFields & {
  readonly sourceCount: number;
  readonly firstSource?: RuntimeMemoryItemSource;
};

export type RuntimeMemoryPageInfo = {
  readonly revision: number;
  readonly nextCursor?: string;
  readonly counts: { readonly active: number; readonly archived: number; readonly total: number };
};

export type RuntimeMemorySettings = JsonObject & {
  readonly enabled: boolean;
  readonly autoExtract: boolean;
  readonly recallEnabled: boolean;
  readonly version: number;
};

export type RuntimeMemoryContextBudget = JsonObject & {
  readonly maxItems: number;
  readonly maxTokens: number;
  readonly usedItems: number;
  readonly usedTokens: number;
  readonly truncated: boolean;
};

/** The exact original characters that were shown to the model. Range is zero-based, half-open. */
export type RuntimeMemoryReference = JsonObject & {
  readonly itemId: string;
  readonly content: string;
  readonly source:
    | "user-evidence"
    | "manual"
    | "assistant-note"
    | "execution-evidence"
    | "execution-validated"
    | "reviewed-reference";
  readonly excerpt: boolean;
  readonly range: { readonly start: number; readonly end: number; readonly total: number };
  readonly match: "key" | "content" | "preference";
};

export type RuntimeMemoryRecallDiagnostic = JsonObject & {
  readonly itemId: string;
  readonly reason: "selected" | "duplicate" | "budget" | "item_limit";
  readonly match: "key" | "content" | "preference";
};

export type RuntimeMemoryMetricGroup = JsonObject & {
  readonly trigger: "remember" | "extract" | "compaction";
  readonly settledCount: number;
  readonly evaluatedCount: number;
  readonly createdItemCount: number;
  readonly modelCallCount: number;
  readonly emptyCount: number;
  readonly emptyRate: number | null;
  readonly durationMs: number;
};

export type RuntimeMemoryMetrics = JsonObject & {
  readonly scope: "user";
  readonly from: number;
  readonly to: number;
  readonly groups: readonly RuntimeMemoryMetricGroup[];
  readonly unknownReceiptCount: number;
  readonly jobs?: JsonObject & {
    readonly pending: number;
    readonly working: number;
    readonly blocked: number;
    readonly oldestPendingAt?: number;
    readonly reasons: readonly (JsonObject & { readonly reason: string; readonly count: number })[];
  };
};

export type RuntimeMemoryConsolidationReason = "duplicate" | "superseded" | "stale" | "low_value";

export type RuntimeMemoryConsolidationReceipt = JsonObject & {
  readonly batchId: string;
  readonly status: "undoable" | "undone";
  readonly consideredCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly undoneAt?: number;
  readonly items: readonly (JsonObject & {
    readonly itemId: string;
    readonly fromVersion: number;
    readonly archivedVersion: number;
    readonly reason: RuntimeMemoryConsolidationReason;
  })[];
};

export type RuntimeMemoryConsolidationUndoResult =
  | {
      readonly status: "undone" | "already_undone" | "expired";
      readonly receipt: RuntimeMemoryConsolidationReceipt;
    }
  | {
      readonly status: "conflict";
      readonly batchId: string;
      readonly conflicts: readonly (JsonObject & {
        readonly itemId: string;
        readonly expectedVersion: number;
        readonly actualVersion?: number;
        readonly reason: string;
      })[];
    }
  | { readonly status: "not_found"; readonly batchId: string };

const memoryItemKindParam = oneOfParam([
  "preference",
  "identity",
  "context",
  "knowledge",
  "failure",
  "note",
]);

const memoryLifecycleStateParam = oneOfParam(["active", "archived"]);

function memoryUpdateParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      itemId: boundedNonEmptyStringParam(512),
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      content: boundedNonEmptyStringParam(32_000),
      kind: memoryItemKindParam,
      lifecycleState: memoryLifecycleStateParam,
      statementType: oneOfParam(["fact", "plan", "prediction"]),
      temporalType: oneOfParam(["undated", "point", "interval", "open_ended"]),
      eventStartedAt: nullableParam(nonNegativeIntegerParam),
      eventEndedAt: nullableParam(nonNegativeIntegerParam),
    },
  )(value);
  if (
    ![
      "content",
      "kind",
      "lifecycleState",
      "statementType",
      "temporalType",
      "eventStartedAt",
      "eventEndedAt",
    ].some((key) => Object.hasOwn(value, key))
  ) {
    throw invalidParams("memory.update 至少需要一个更新字段");
  }
}

function memorySettingsUpdateParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      workspacePath: stringParam,
      enabled: booleanParam,
      autoExtract: booleanParam,
      recallEnabled: booleanParam,
    },
  )(value);
  if (!["enabled", "autoExtract", "recallEnabled"].some((key) => Object.hasOwn(value, key))) {
    throw invalidParams("memory.settings.update 至少需要一个更新字段");
  }
}

const memorySourceResult = exactResultShape({
  sessionId: resultString,
  runId: resultString,
  turnId: resultString,
  eventId: resultString,
});

const memoryItemFieldsResult = {
  itemId: resultString,
  version: resultNonNegativeInteger,
  content: resultString,
  kind: resultOneOf(["preference", "identity", "context", "knowledge", "failure", "note"]),
  statementType: resultOneOf(["fact", "plan", "prediction"]),
  temporalType: resultOneOf(["undated", "point", "interval", "open_ended"]),
  scopeType: resultOneOf(["global", "workspace"]),
  scopeKey: resultNullable(resultString),
  eventStartedAt: resultNullable(resultNonNegativeInteger),
  eventEndedAt: resultNullable(resultNonNegativeInteger),
  observedAt: resultNonNegativeInteger,
  lifecycleState: resultOneOf(["active", "archived"]),
  origin: resultOneOf(["agent_extracted", "user_requested"]),
  contentHash: resultString,
  createdAt: resultNonNegativeInteger,
  updatedAt: resultNonNegativeInteger,
};
const executionEvidenceResult = exactResultShape({
  candidateId: resultString,
  confirmedAt: resultNonNegativeInteger,
  verificationCount: resultNonNegativeInteger,
});
const taskAcceptanceResult = exactResultShape({
  candidateId: resultString,
  predicateId: resultOneOf(["test-target-pass.v1", "command-conditions.v1"]),
  targetId: resultString,
  targetLabel: resultString,
  acceptedAt: resultNonNegativeInteger,
  claimHash: resultString,
  scopeHash: resultString,
});
const memoryItemResult = exactResultShape(
  {
    ...memoryItemFieldsResult,
    sources: resultArray(memorySourceResult),
  },
  {
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated"]),
    taskAcceptance: taskAcceptanceResult,
  },
);
const memoryListItemResult = exactResultShape(
  { ...memoryItemFieldsResult, sourceCount: resultNonNegativeInteger },
  {
    firstSource: memorySourceResult,
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated"]),
    taskAcceptance: taskAcceptanceResult,
  },
);
const memoryPageInfoResult = exactResultShape(
  {
    revision: resultNonNegativeInteger,
    counts: exactResultShape({
      active: resultNonNegativeInteger,
      archived: resultNonNegativeInteger,
      total: resultNonNegativeInteger,
    }),
  },
  { nextCursor: resultString },
);
function memoryListParams(value: Record<string, unknown>): void {
  exactParamShape(
    { workspacePath: stringParam },
    {
      lifecycleStates: enumArrayParam(["active", "archived"]),
      kinds: enumArrayParam(["preference", "identity", "context", "knowledge", "failure", "note"]),
      limit: positiveIntegerParam,
      paged: booleanParam,
      cursor: boundedNonEmptyStringParam(4_096),
      learningVersion: learningVersionParam,
    },
  )(value);
  if (("paged" in value && value.paged !== true) || ("cursor" in value && value.paged !== true))
    throw invalidParams("memory.list 游标要求 paged=true");
}
const legacyMemoryListResult = exactResultShape({ items: resultArray(memoryItemResult) });
const pagedMemoryListResult = exactResultShape({
  items: resultArray(memoryListItemResult),
  pageInfo: memoryPageInfoResult,
});

const memorySettingsResult = exactResultShape({
  enabled: resultBoolean,
  autoExtract: resultBoolean,
  recallEnabled: resultBoolean,
  version: resultNonNegativeInteger,
});

const memoryReferenceResult = exactResultShape({
  itemId: resultString,
  content: resultString,
  source: resultOneOf([
    "user-evidence",
    "manual",
    "assistant-note",
    "execution-evidence",
    "execution-validated",
  ]),
  excerpt: resultBoolean,
  range: exactResultShape({
    start: resultNonNegativeInteger,
    end: resultNonNegativeInteger,
    total: resultNonNegativeInteger,
  }),
  match: resultOneOf(["key", "content", "preference"]),
});
const memoryDiagnosticResult = exactResultShape({
  itemId: resultString,
  reason: resultOneOf(["selected", "duplicate", "budget", "item_limit"]),
  match: resultOneOf(["key", "content", "preference"]),
});
const memoryMetricsResult = exactResultShape(
  {
    scope: resultOneOf(["user"]),
    from: resultNonNegativeInteger,
    to: resultNonNegativeInteger,
    groups: resultArray(
      exactResultShape({
        trigger: resultOneOf(["remember", "extract", "compaction"]),
        settledCount: resultNonNegativeInteger,
        evaluatedCount: resultNonNegativeInteger,
        createdItemCount: resultNonNegativeInteger,
        modelCallCount: resultNonNegativeInteger,
        emptyCount: resultNonNegativeInteger,
        emptyRate: resultNullable(resultFiniteNumber),
        durationMs: resultFiniteNumber,
      }),
    ),
    unknownReceiptCount: resultNonNegativeInteger,
  },
  {
    jobs: exactResultShape(
      {
        pending: resultNonNegativeInteger,
        working: resultNonNegativeInteger,
        blocked: resultNonNegativeInteger,
        reasons: resultArray(
          exactResultShape({
            reason: resultOneOf([
              "policy_disabled",
              "auto_extract_disabled",
              "untrusted_workspace",
              "workspace_unavailable",
              "model_unavailable",
              "extraction_failed",
              "retry_exhausted",
              "unknown",
            ]),
            count: resultNonNegativeInteger,
          }),
        ),
      },
      { oldestPendingAt: resultNonNegativeInteger },
    ),
  },
);

const memoryConsolidationReceiptResult = exactResultShape(
  {
    batchId: resultString,
    status: resultOneOf(["undoable", "undone"]),
    consideredCount: resultNonNegativeInteger,
    createdAt: resultNonNegativeInteger,
    expiresAt: resultNonNegativeInteger,
    items: resultArray(
      exactResultShape({
        itemId: resultString,
        fromVersion: resultNonNegativeInteger,
        archivedVersion: resultNonNegativeInteger,
        reason: resultOneOf(["duplicate", "superseded", "stale", "low_value"]),
      }),
    ),
  },
  { undoneAt: resultNonNegativeInteger },
);

const memoryConsolidationUndoResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value) || typeof value.status !== "string")
    throw invalidResult(`${path}.status 必须是字符串`);
  if (
    value.status === "undone" ||
    value.status === "already_undone" ||
    value.status === "expired"
  ) {
    exactResultShape({
      status: resultOneOf(["undone", "already_undone", "expired"]),
      receipt: memoryConsolidationReceiptResult,
    })(value, path);
    return;
  }
  if (value.status === "conflict") {
    exactResultShape({
      status: resultOneOf(["conflict"]),
      batchId: resultString,
      conflicts: resultArray(
        exactResultShape(
          {
            itemId: resultString,
            expectedVersion: resultNonNegativeInteger,
            reason: resultString,
          },
          { actualVersion: resultNonNegativeInteger },
        ),
      ),
    })(value, path);
    return;
  }
  if (value.status === "not_found") {
    exactResultShape({ status: resultOneOf(["not_found"]), batchId: resultString })(value, path);
    return;
  }
  throw invalidResult(`${path}.status 不受支持`);
};

export type MemoryMethodMap = TaskExperienceMethodMap & {
  readonly "memory.learning.list": {
    readonly params: WorkspaceParams & { readonly sessionId?: string };
    readonly result: {
      readonly workspaceKey: string;
      readonly revision: number;
      readonly items: readonly ExecutionLearningStatus[];
    };
  };
  readonly "memory.learning.inspect": {
    readonly params: WorkspaceParams & { readonly candidateId: string };
    readonly result: { readonly candidate: JsonObject };
  };
  readonly "memory.learning.discard": {
    readonly params: WorkspaceParams & {
      readonly candidateId: string;
      readonly expectedRevision: number;
    };
    readonly result: { readonly discarded: true };
  };
  readonly "memory.list": {
    readonly params: WorkspaceParams & {
      readonly lifecycleStates?: readonly RuntimeMemoryLifecycleState[];
      readonly kinds?: readonly RuntimeMemoryItemKind[];
      readonly limit?: number;
      readonly paged?: true;
      readonly cursor?: string;
      readonly learningVersion?: 2 | 3;
    };
    readonly result:
      | {
          readonly items: readonly RuntimeMemoryItem[];
          readonly pageInfo?: never;
          readonly learningVersion?: 2 | 3;
        }
      | {
          readonly items: readonly RuntimeMemoryListItem[];
          readonly pageInfo: RuntimeMemoryPageInfo;
          readonly learningVersion?: 2 | 3;
        };
  };
  readonly "memory.get": {
    readonly params: WorkspaceParams & {
      readonly itemId: string;
      readonly learningVersion?: 2 | 3;
    };
    readonly result: { readonly item: RuntimeMemoryItem; readonly learningVersion?: 2 | 3 };
  };
  /** /memory remember（TUI 直写）：显式记住一条 workspace note（安全扫描 + 幂等 + 再激活）。 */
  readonly "memory.create": {
    readonly params: WorkspaceParams & { readonly text: string };
    readonly result: { readonly item: RuntimeMemoryItem };
  };
  readonly "memory.update": {
    readonly params: WorkspaceParams & {
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly content?: string;
      readonly kind?: RuntimeMemoryItemKind;
      readonly lifecycleState?: RuntimeMemoryLifecycleState;
      readonly statementType?: RuntimeMemoryStatementType;
      readonly temporalType?: RuntimeMemoryTemporalType;
      readonly eventStartedAt?: number | null;
      readonly eventEndedAt?: number | null;
    };
    readonly result: { readonly item: RuntimeMemoryItem };
  };
  readonly "memory.delete": {
    readonly params: WorkspaceParams & {
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
    };
    readonly result: { readonly itemId: string; readonly deleted: true };
  };
  readonly "memory.settings.get": {
    readonly params: { readonly workspacePath?: string };
    readonly result: { readonly settings: RuntimeMemorySettings };
  };
  readonly "memory.settings.update": {
    readonly params: {
      readonly workspacePath?: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly enabled?: boolean;
      readonly autoExtract?: boolean;
      readonly recallEnabled?: boolean;
    };
    readonly result: { readonly settings: RuntimeMemorySettings };
  };
  readonly "memory.context.preview": {
    readonly params: WorkspaceParams & {
      readonly maxItems?: number;
      readonly maxTokens?: number;
      readonly query?: string;
      readonly sessionId?: string;
      readonly learningVersion?: 2 | 3;
    };
    readonly result: {
      readonly learningVersion?: 2 | 3;
      readonly items: readonly RuntimeMemoryItem[];
      readonly budget: RuntimeMemoryContextBudget;
      readonly block?: string;
      readonly references?: readonly RuntimeMemoryReference[];
      readonly diagnostics?: readonly RuntimeMemoryRecallDiagnostic[];
    };
  };
  readonly "memory.metrics.get": {
    readonly params: {
      readonly includeJobs?: boolean;
      readonly workspacePath?: string;
      readonly from?: number;
      readonly to?: number;
    };
    readonly result: { readonly metrics: RuntimeMemoryMetrics };
  };
  readonly "memory.consolidation.history": {
    readonly params: WorkspaceParams;
    readonly result: { readonly receipts: readonly RuntimeMemoryConsolidationReceipt[] };
  };
  readonly "memory.consolidation.undo": {
    readonly params: WorkspaceParams & { readonly batchId: string };
    readonly result: RuntimeMemoryConsolidationUndoResult;
  };
};

export const memoryParamValidators = {
  ...taskExperienceParamValidators,
  "memory.learning.list": exactParamShape(
    { workspacePath: stringParam },
    { sessionId: boundedNonEmptyStringParam(512) },
  ),
  "memory.learning.inspect": exactParamShape({
    workspacePath: stringParam,
    candidateId: boundedNonEmptyStringParam(512),
  }),
  "memory.learning.discard": exactParamShape({
    workspacePath: stringParam,
    candidateId: boundedNonEmptyStringParam(512),
    expectedRevision: positiveIntegerParam,
  }),
  "memory.list": memoryListParams,
  "memory.get": exactParamShape(
    {
      workspacePath: stringParam,
      itemId: boundedNonEmptyStringParam(512),
    },
    { learningVersion: learningVersionParam },
  ),
  "memory.create": exactParamShape({
    workspacePath: stringParam,
    text: boundedNonEmptyStringParam(8192),
  }),
  "memory.update": memoryUpdateParams,
  "memory.delete": exactParamShape({
    workspacePath: stringParam,
    itemId: boundedNonEmptyStringParam(512),
    expectedVersion: positiveIntegerParam,
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "memory.settings.get": exactParamShape({}, { workspacePath: stringParam }),
  "memory.settings.update": memorySettingsUpdateParams,
  "memory.context.preview": exactParamShape(
    { workspacePath: stringParam },
    {
      maxItems: positiveIntegerParam,
      maxTokens: positiveIntegerParam,
      query: boundedNonEmptyStringParam(4096),
      sessionId: boundedNonEmptyStringParam(512),
      learningVersion: learningVersionParam,
    },
  ),
  "memory.metrics.get": exactParamShape(
    {},
    {
      workspacePath: stringParam,
      from: nonNegativeIntegerParam,
      to: nonNegativeIntegerParam,
      includeJobs: booleanParam,
    },
  ),
  "memory.consolidation.history": exactParamShape({ workspacePath: stringParam }),
  "memory.consolidation.undo": exactParamShape({
    workspacePath: stringParam,
    batchId: boundedNonEmptyStringParam(512),
  }),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeParamValidator>>;

const learningStates = [
  "waiting",
  "ready",
  "working",
  "saved",
  "insufficient",
  "invalidated",
  "discarded",
  "expired",
] as const;
const acceptancePredicates = ["test-target-pass.v1", "command-conditions.v1"] as const;
const hashResult: RuntimeResultRule = (value, path) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw invalidResult(`${path}不是 SHA-256 摘要`);
};
const runnerResult = exactResultShape(
  { execPath: resultString, version: resultString },
  { fingerprint: hashResult },
);
const conditionResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path}不是条件`);
  switch (value.kind) {
    case "cwd":
      return exactResultShape({ kind: resultOneOf(["cwd"]), path: resultString })(value, path);
    case "file":
      return exactResultShape({
        kind: resultOneOf(["file"]),
        path: resultString,
        hash: hashResult,
      })(value, path);
    case "json":
      return exactResultShape({
        kind: resultOneOf(["json"]),
        path: resultString,
        field: resultArray(resultString),
        value: (v, p) => {
          if (v !== null && !["string", "number", "boolean"].includes(typeof v))
            throw invalidResult(`${p}不是静态 JSON 字段`);
        },
      })(value, path);
    case "node-package":
      return exactResultShape({
        kind: resultOneOf(["node-package"]),
        path: resultString,
        name: resultString,
        version: resultString,
        entryPath: resultString,
        entryHash: hashResult,
      })(value, path);
    default:
      throw invalidResult(`${path}条件类型未知`);
  }
};
const preparationResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path}不是准备步骤`);
  switch (value.kind) {
    case "cwd":
      return exactResultShape({
        kind: resultOneOf(["cwd"]),
        path: resultString,
        source: memorySourceResult,
      })(value, path);
    case "file":
      return exactResultShape(
        {
          kind: resultOneOf(["file"]),
          path: resultString,
          afterHash: hashResult,
          source: memorySourceResult,
        },
        { beforeHash: resultNullable(hashResult), content: resultString },
      )(value, path);
    case "dependency":
      return exactResultShape({
        kind: resultOneOf(["dependency"]),
        command: resultString,
        manifestHash: hashResult,
        source: memorySourceResult,
      })(value, path);
    default:
      throw invalidResult(`${path}准备类型未知`);
  }
};
const learningCandidateResult = exactResultShape(
  {
    state: resultOneOf(learningStates),
    updatedAt: resultNonNegativeInteger,
    claim: exactResultShape(
      {
        candidateId: resultString,
        revision: resultNonNegativeInteger,
        failureKey: hashResult,
        predicateId: resultOneOf(acceptancePredicates),
        claimHash: hashResult,
        admission: exactResultShape({
          admissionId: resultString,
          workspaceKey: resultString,
          sessionId: resultString,
          runId: resultString,
          workDir: resultString,
          settingsVersion: resultNonNegativeInteger,
          deletionRevision: resultNonNegativeInteger,
          managementRevision: resultNonNegativeInteger,
          inputEpoch: resultNonNegativeInteger,
          createdAt: resultNonNegativeInteger,
        }),
        target: exactResultShape(
          {
            targetId: resultString,
            label: resultString,
            kind: resultOneOf(["node-test", "command"]),
            command: resultString,
            argv: resultArray(resultString),
            cwd: resultString,
            scopeHash: hashResult,
            entryFiles: resultArray(exactResultShape({ path: resultString, hash: hashResult })),
          },
          { testFiles: resultArray(resultString) },
        ),
        conditions: resultArray(conditionResult),
        recipe: resultArray(preparationResult),
        failedTestIds: resultArray(resultString),
        failure: memorySourceResult,
        createdAt: resultNonNegativeInteger,
      },
      { runner: runnerResult },
    ),
  },
  { itemId: resultString, reason: resultString, hypothesis: resultString },
);

const memoryItemV2Result = exactResultShape(
  { ...memoryItemFieldsResult, sources: resultArray(memorySourceResult) },
  {
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated", "reviewed-reference"]),
    taskAcceptance: taskAcceptanceResult,
    taskExperience: experienceSummaryResult,
  },
);
const memoryListItemV2Result = exactResultShape(
  { ...memoryItemFieldsResult, sourceCount: resultNonNegativeInteger },
  {
    firstSource: memorySourceResult,
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated", "reviewed-reference"]),
    taskAcceptance: taskAcceptanceResult,
    taskExperience: experienceSummaryResult,
  },
);
const memoryItemV3Result = exactResultShape(
  { ...memoryItemFieldsResult, sources: resultArray(memorySourceResult) },
  {
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated", "reviewed-reference"]),
    taskAcceptance: taskAcceptanceResult,
    taskExperience: experienceSummaryV3Result,
  },
);
const memoryListItemV3Result = exactResultShape(
  { ...memoryItemFieldsResult, sourceCount: resultNonNegativeInteger },
  {
    firstSource: memorySourceResult,
    executionEvidence: executionEvidenceResult,
    sourceType: resultOneOf(["execution-validated", "reviewed-reference"]),
    taskAcceptance: taskAcceptanceResult,
    taskExperience: experienceSummaryV3Result,
  },
);
const memoryReferenceV2Result = exactResultShape({
  itemId: resultString,
  content: resultString,
  source: resultOneOf([
    "user-evidence",
    "manual",
    "assistant-note",
    "execution-evidence",
    "execution-validated",
    "reviewed-reference",
  ]),
  excerpt: resultBoolean,
  range: exactResultShape({
    start: resultNonNegativeInteger,
    end: resultNonNegativeInteger,
    total: resultNonNegativeInteger,
  }),
  match: resultOneOf(["key", "content", "preference"]),
});
const isV2 = (v: unknown) =>
  isJsonObject(v) && (v.learningVersion === 2 || v.learningVersion === 3);
const learningResultVersion = (v: unknown): 2 | 3 =>
  isJsonObject(v) && v.learningVersion === 3 ? 3 : 2;
const previewRule = (v2: boolean, version: 2 | 3 = 2) =>
  exactResultShape(
    {
      items: resultArray(
        v2 ? (version === 3 ? memoryItemV3Result : memoryItemV2Result) : memoryItemResult,
      ),
      budget: exactResultShape({
        maxItems: resultNonNegativeInteger,
        maxTokens: resultNonNegativeInteger,
        usedItems: resultNonNegativeInteger,
        usedTokens: resultNonNegativeInteger,
        truncated: resultBoolean,
      }),
      ...(v2 ? { learningVersion: resultOneOf([version]) } : {}),
    },
    {
      block: resultString,
      references: resultArray(v2 ? memoryReferenceV2Result : memoryReferenceResult),
      diagnostics: resultArray(memoryDiagnosticResult),
    },
  );
export const memoryResultValidators = {
  ...taskExperienceResultValidators,
  "memory.learning.list": exactResultShape({
    workspaceKey: resultString,
    revision: resultNonNegativeInteger,
    items: resultArray(
      exactResultShape(
        {
          candidateId: resultString,
          revision: resultNonNegativeInteger,
          workspaceKey: resultString,
          sessionId: resultString,
          runId: resultString,
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
          predicateId: resultOneOf(["test-target-pass.v1", "command-conditions.v1"]),
          targetId: resultString,
          targetLabel: resultString,
          updatedAt: resultNonNegativeInteger,
          sources: resultArray(memorySourceResult),
        },
        { itemId: resultString, reason: resultString },
      ),
    ),
  }),
  "memory.learning.inspect": exactResultShape({ candidate: learningCandidateResult }),
  "memory.learning.discard": exactResultShape({ discarded: resultOneOf([true]) }),
  "memory.list": (value, path) => {
    if (isV2(value)) {
      const paged = Object.hasOwn(value as object, "pageInfo");
      exactResultShape({
        learningVersion: resultOneOf([learningResultVersion(value)]),
        items: resultArray(
          learningResultVersion(value) === 3
            ? paged
              ? memoryListItemV3Result
              : memoryItemV3Result
            : paged
              ? memoryListItemV2Result
              : memoryItemV2Result,
        ),
        ...(paged ? { pageInfo: memoryPageInfoResult } : {}),
      })(value, path);
    } else if (value && typeof value === "object" && Object.hasOwn(value, "pageInfo"))
      pagedMemoryListResult(value, path);
    else legacyMemoryListResult(value, path);
  },
  "memory.get": (v, p) =>
    (isV2(v)
      ? exactResultShape({
          learningVersion: resultOneOf([learningResultVersion(v)]),
          item: learningResultVersion(v) === 3 ? memoryItemV3Result : memoryItemV2Result,
        })
      : exactResultShape({ item: memoryItemResult }))(v, p),
  "memory.create": exactResultShape({ item: memoryItemResult }),
  "memory.update": exactResultShape({ item: memoryItemResult }),
  "memory.delete": exactResultShape({
    itemId: resultString,
    deleted: resultOneOf([true]),
  }),
  "memory.settings.get": exactResultShape({ settings: memorySettingsResult }),
  "memory.settings.update": exactResultShape({ settings: memorySettingsResult }),
  "memory.context.preview": (v, p) => previewRule(isV2(v), learningResultVersion(v))(v, p),
  "memory.metrics.get": exactResultShape({ metrics: memoryMetricsResult }),
  "memory.consolidation.history": exactResultShape({
    receipts: resultArray(memoryConsolidationReceiptResult),
  }),
  "memory.consolidation.undo": memoryConsolidationUndoResult,
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeResultRule>>;
