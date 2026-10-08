// Atomic Memory Item management, settings, and context-preview contracts.
import type { JsonObject, WorkspaceParams } from "./base.js";
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
  readonly source: "user-evidence" | "manual" | "assistant-note";
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
};

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
const memoryItemResult = exactResultShape({
  ...memoryItemFieldsResult,
  sources: resultArray(memorySourceResult),
});
const memoryListItemResult = exactResultShape(
  { ...memoryItemFieldsResult, sourceCount: resultNonNegativeInteger },
  { firstSource: memorySourceResult },
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
  source: resultOneOf(["user-evidence", "manual", "assistant-note"]),
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
const memoryMetricsResult = exactResultShape({
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
});

export type MemoryMethodMap = {
  readonly "memory.list": {
    readonly params: WorkspaceParams & {
      readonly lifecycleStates?: readonly RuntimeMemoryLifecycleState[];
      readonly kinds?: readonly RuntimeMemoryItemKind[];
      readonly limit?: number;
      readonly paged?: true;
      readonly cursor?: string;
    };
    readonly result:
      | { readonly items: readonly RuntimeMemoryItem[]; readonly pageInfo?: never }
      | {
          readonly items: readonly RuntimeMemoryListItem[];
          readonly pageInfo: RuntimeMemoryPageInfo;
        };
  };
  readonly "memory.get": {
    readonly params: WorkspaceParams & { readonly itemId: string };
    readonly result: { readonly item: RuntimeMemoryItem };
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
    };
    readonly result: {
      readonly items: readonly RuntimeMemoryItem[];
      readonly budget: RuntimeMemoryContextBudget;
      readonly block?: string;
      readonly references?: readonly RuntimeMemoryReference[];
      readonly diagnostics?: readonly RuntimeMemoryRecallDiagnostic[];
    };
  };
  readonly "memory.metrics.get": {
    readonly params: {
      readonly workspacePath?: string;
      readonly from?: number;
      readonly to?: number;
    };
    readonly result: { readonly metrics: RuntimeMemoryMetrics };
  };
};

export const memoryParamValidators = {
  "memory.list": memoryListParams,
  "memory.get": exactParamShape({
    workspacePath: stringParam,
    itemId: boundedNonEmptyStringParam(512),
  }),
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
    },
  ),
  "memory.metrics.get": exactParamShape(
    {},
    { workspacePath: stringParam, from: nonNegativeIntegerParam, to: nonNegativeIntegerParam },
  ),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeParamValidator>>;

export const memoryResultValidators = {
  "memory.list": (value, path) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "pageInfo"))
      pagedMemoryListResult(value, path);
    else legacyMemoryListResult(value, path);
  },
  "memory.get": exactResultShape({ item: memoryItemResult }),
  "memory.create": exactResultShape({ item: memoryItemResult }),
  "memory.update": exactResultShape({ item: memoryItemResult }),
  "memory.delete": exactResultShape({
    itemId: resultString,
    deleted: resultOneOf([true]),
  }),
  "memory.settings.get": exactResultShape({ settings: memorySettingsResult }),
  "memory.settings.update": exactResultShape({ settings: memorySettingsResult }),
  "memory.context.preview": exactResultShape(
    {
      items: resultArray(memoryItemResult),
      budget: exactResultShape({
        maxItems: resultNonNegativeInteger,
        maxTokens: resultNonNegativeInteger,
        usedItems: resultNonNegativeInteger,
        usedTokens: resultNonNegativeInteger,
        truncated: resultBoolean,
      }),
    },
    {
      block: resultString,
      references: resultArray(memoryReferenceResult),
      diagnostics: resultArray(memoryDiagnosticResult),
    },
  ),
  "memory.metrics.get": exactResultShape({ metrics: memoryMetricsResult }),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeResultRule>>;
