// Atomic Memory Item management, settings, and context-preview contracts.
import type { JsonObject, WorkspaceParams } from "./base.js";
import { invalidParams } from "./errors.js";
import {
  booleanParam,
  boundedNonEmptyStringParam,
  enumArrayParam,
  exactParamShape,
  exactResultShape,
  oneOfParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
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
export type RuntimeMemoryItem = JsonObject & {
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
  readonly sources: readonly RuntimeMemoryItemSource[];
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
    },
  )(value);
  if (!["content", "kind", "lifecycleState"].some((key) => Object.hasOwn(value, key))) {
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

const memoryItemResult = exactResultShape({
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
  sources: resultArray(memorySourceResult),
});

const memorySettingsResult = exactResultShape({
  enabled: resultBoolean,
  autoExtract: resultBoolean,
  recallEnabled: resultBoolean,
  version: resultNonNegativeInteger,
});

export type MemoryMethodMap = {
  readonly "memory.list": {
    readonly params: WorkspaceParams & {
      readonly lifecycleStates?: readonly RuntimeMemoryLifecycleState[];
      readonly kinds?: readonly RuntimeMemoryItemKind[];
      readonly limit?: number;
    };
    readonly result: { readonly items: readonly RuntimeMemoryItem[] };
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
    };
    readonly result: {
      readonly items: readonly RuntimeMemoryItem[];
      readonly budget: RuntimeMemoryContextBudget;
    };
  };
};

export const memoryParamValidators = {
  "memory.list": exactParamShape(
    { workspacePath: stringParam },
    {
      lifecycleStates: enumArrayParam(["active", "archived"]),
      kinds: enumArrayParam(["preference", "identity", "context", "knowledge", "failure", "note"]),
      limit: positiveIntegerParam,
    },
  ),
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
    { maxItems: positiveIntegerParam, maxTokens: positiveIntegerParam },
  ),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeParamValidator>>;

export const memoryResultValidators = {
  "memory.list": exactResultShape({ items: resultArray(memoryItemResult) }),
  "memory.get": exactResultShape({ item: memoryItemResult }),
  "memory.create": exactResultShape({ item: memoryItemResult }),
  "memory.update": exactResultShape({ item: memoryItemResult }),
  "memory.delete": exactResultShape({
    itemId: resultString,
    deleted: resultOneOf([true]),
  }),
  "memory.settings.get": exactResultShape({ settings: memorySettingsResult }),
  "memory.settings.update": exactResultShape({ settings: memorySettingsResult }),
  "memory.context.preview": exactResultShape({
    items: resultArray(memoryItemResult),
    budget: exactResultShape({
      maxItems: resultNonNegativeInteger,
      maxTokens: resultNonNegativeInteger,
      usedItems: resultNonNegativeInteger,
      usedTokens: resultNonNegativeInteger,
      truncated: resultBoolean,
    }),
  }),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeResultRule>>;
