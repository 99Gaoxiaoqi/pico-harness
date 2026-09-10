// Memory item, review, and settings contracts, including retained wire-compatible names.
import type { JsonObject, WorkspaceParams } from "./base.js";
import { invalidParams } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  boundedNonEmptyStringParam,
  confidenceParam,
  enumArrayParam,
  exactParamShape,
  exactResultShape,
  nullableParam,
  oneOfParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultNonNegativeInteger,
  resultNonNegativeNumber,
  resultNullable,
  resultOneOf,
  resultString,
  stringParam,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeMemoryKind = "preference" | "correction" | "project_fact" | "reference";

export type RuntimeMemoryFactState = "active" | "disabled" | "archived" | "forgotten";

export type RuntimeMemoryProposalStatus = "pending" | "accepted" | "rejected" | "deleted";

export type RuntimeMemoryProposalConflictStatus = "none" | "potential" | "confirmed" | "resolved";

export type RuntimeMemoryFact = JsonObject & {
  /** Atomic Item metadata; legacy envelope names remain wire-compatible during cutover. */
  readonly atomic?: RuntimeAtomicMemoryDetails;
  readonly factId: string;
  readonly kind: RuntimeMemoryKind;
  readonly title: string | null;
  readonly content: string | null;
  readonly confidence: number;
  readonly state: RuntimeMemoryFactState;
  readonly pinned: boolean;
  readonly sourceId?: string;
  readonly source?: RuntimeMemorySourceMetadata;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forgottenAt?: string;
};

export type RuntimeAtomicMemoryDetails = JsonObject & {
  readonly itemId: string;
  readonly kind: "preference" | "identity" | "context" | "knowledge" | "failure" | "note";
  readonly scopeType: "global" | "workspace";
  readonly scopeKey: string | null;
  readonly statementType: "fact" | "plan" | "prediction";
  readonly temporalType: "undated" | "point" | "interval" | "open_ended";
  readonly observedAt: number;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly origin: "agent_extracted" | "user_requested";
};

export type RuntimeMemorySourceMetadata = JsonObject & {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly availability: "available" | "unavailable";
  readonly invalidatedAt?: string;
  readonly invalidationCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RuntimeMemoryProposal = JsonObject & {
  readonly proposalId: string;
  readonly kind: RuntimeMemoryKind;
  readonly title: string | null;
  readonly content: string | null;
  readonly reason: string | null;
  readonly confidence: number;
  readonly status: RuntimeMemoryProposalStatus;
  readonly conflictStatus: RuntimeMemoryProposalConflictStatus;
  readonly sourceId?: string;
  readonly conflictFactId?: string;
  readonly resolvedFactId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewedAt?: string;
  readonly deletedAt?: string;
};

export type RuntimeMemorySettings = JsonObject & {
  readonly enabled: boolean;
  readonly autoPropose: boolean;
  readonly autoCommit: boolean;
  readonly injectionEnabled: boolean;
  readonly reviewMode: "eco" | "balanced" | "quality";
  readonly version: number;
  readonly updatedAt: string;
};

export type RuntimeMemoryReviewBudget = JsonObject & {
  readonly mode: RuntimeMemorySettings["reviewMode"];
  readonly allowed: boolean;
  readonly reason: "available" | "eco-mode" | "budget-exhausted";
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number;
  readonly nextRecoveryAt?: string;
};

export type RuntimeMemoryContextBudget = JsonObject & {
  readonly maxFacts: number;
  readonly maxTokens: number;
  readonly usedFacts: number;
  readonly usedTokens: number;
  readonly truncated: boolean;
};

const memoryKindParam = oneOfParam(["preference", "correction", "project_fact", "reference"]);

const memoryFactStateParam = oneOfParam(["active", "disabled", "archived"]);

function memoryUpdateParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      factId: boundedNonEmptyStringParam(512),
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      kind: memoryKindParam,
      title: boundedNonEmptyStringParam(512),
      content: boundedNonEmptyStringParam(32_000),
      confidence: confidenceParam,
      state: memoryFactStateParam,
      pinned: booleanParam,
      expiresAt: nullableParam(boundedNonEmptyStringParam(128)),
      lastUsedAt: nullableParam(boundedNonEmptyStringParam(128)),
    },
  )(value);
  if (
    !["kind", "title", "content", "confidence", "state", "pinned", "expiresAt", "lastUsedAt"].some(
      (key) => Object.hasOwn(value, key),
    )
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
      autoPropose: booleanParam,
      autoCommit: (candidate, path) => {
        if (candidate !== false) throw invalidParams(`${path} 首版只允许为 false`);
      },
      injectionEnabled: booleanParam,
      reviewMode: oneOfParam(["eco", "balanced", "quality"]),
    },
  )(value);
  if (
    !["enabled", "autoPropose", "autoCommit", "injectionEnabled", "reviewMode"].some((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    throw invalidParams("memory.settings.update 至少需要一个更新字段");
  }
}

function memoryReviewResolveParams(value: Record<string, unknown>): void {
  exactParamShape(
    {
      workspacePath: stringParam,
      proposalId: boundedNonEmptyStringParam(512),
      resolution: oneOfParam(["accepted", "rejected"]),
      expectedVersion: positiveIntegerParam,
      idempotencyKey: boundedNonEmptyStringParam(512),
    },
    {
      factId: boundedNonEmptyStringParam(512),
      patch: (candidate, path) => {
        assertNestedShape(
          candidate,
          path,
          {},
          {
            kind: oneOfParam(["preference", "correction", "project_fact", "reference"]),
            title: boundedNonEmptyStringParam(512),
            content: boundedNonEmptyStringParam(32_000),
            reason: boundedNonEmptyStringParam(4_000),
            confidence: confidenceParam,
          },
        );
        if (Object.keys(candidate as Record<string, unknown>).length === 0) {
          throw invalidParams(`${path} 至少需要一个更新字段`);
        }
      },
    },
  )(value);
  if (value["resolution"] === "rejected" && value["patch"] !== undefined) {
    throw invalidParams("params.patch 仅能用于批准建议");
  }
}

const memoryFactResult = exactResultShape(
  {
    factId: resultString,
    kind: resultOneOf(["preference", "correction", "project_fact", "reference"]),
    title: resultNullable(resultString),
    content: resultNullable(resultString),
    confidence: resultFiniteNumber,
    state: resultOneOf(["active", "disabled", "archived", "forgotten"]),
    pinned: resultBoolean,
    version: resultFiniteNumber,
    createdAt: resultString,
    updatedAt: resultString,
  },
  {
    atomic: exactResultShape({
      itemId: resultString,
      kind: resultOneOf(["preference", "identity", "context", "knowledge", "failure", "note"]),
      scopeType: resultOneOf(["global", "workspace"]),
      scopeKey: resultNullable(resultString),
      statementType: resultOneOf(["fact", "plan", "prediction"]),
      temporalType: resultOneOf(["undated", "point", "interval", "open_ended"]),
      observedAt: resultFiniteNumber,
      eventStartedAt: resultNullable(resultFiniteNumber),
      eventEndedAt: resultNullable(resultFiniteNumber),
      origin: resultOneOf(["agent_extracted", "user_requested"]),
    }),
    sourceId: resultString,
    source: exactResultShape(
      {
        sourceId: resultString,
        sessionId: resultString,
        availability: resultOneOf(["available", "unavailable"]),
        createdAt: resultString,
        updatedAt: resultString,
      },
      {
        branchId: resultString,
        invalidatedAt: resultString,
        invalidationCode: resultString,
      },
    ),
    expiresAt: resultString,
    lastUsedAt: resultString,
    forgottenAt: resultString,
  },
);

const memoryProposalResult = exactResultShape(
  {
    proposalId: resultString,
    kind: resultOneOf(["preference", "correction", "project_fact", "reference"]),
    title: resultNullable(resultString),
    content: resultNullable(resultString),
    reason: resultNullable(resultString),
    confidence: resultFiniteNumber,
    status: resultOneOf(["pending", "accepted", "rejected", "deleted"]),
    conflictStatus: resultOneOf(["none", "potential", "confirmed", "resolved"]),
    version: resultFiniteNumber,
    createdAt: resultString,
    updatedAt: resultString,
  },
  {
    sourceId: resultString,
    conflictFactId: resultString,
    resolvedFactId: resultString,
    reviewedAt: resultString,
    deletedAt: resultString,
  },
);

const memorySettingsResult = exactResultShape({
  enabled: resultBoolean,
  autoPropose: resultBoolean,
  autoCommit: resultBoolean,
  injectionEnabled: resultBoolean,
  reviewMode: resultOneOf(["eco", "balanced", "quality"]),
  version: resultFiniteNumber,
  updatedAt: resultString,
});

const memoryReviewBudgetResult = exactResultShape(
  {
    mode: resultOneOf(["eco", "balanced", "quality"]),
    allowed: resultBoolean,
    reason: resultOneOf(["available", "eco-mode", "budget-exhausted"]),
    calls: resultNonNegativeInteger,
    inputTokens: resultNonNegativeInteger,
    outputTokens: resultNonNegativeInteger,
    costUsd: resultNonNegativeNumber,
    maxCalls: resultNonNegativeInteger,
    maxInputTokens: resultNonNegativeInteger,
    maxOutputTokens: resultNonNegativeInteger,
    maxCostUsd: resultNonNegativeNumber,
  },
  { nextRecoveryAt: resultString },
);

export type MemoryMethodMap = {
  readonly "memory.list": {
    readonly params: WorkspaceParams & {
      readonly states?: readonly RuntimeMemoryFactState[];
      readonly kinds?: readonly RuntimeMemoryKind[];
      readonly limit?: number;
    };
    readonly result: { readonly facts: readonly RuntimeMemoryFact[] };
  };
  readonly "memory.get": {
    readonly params: WorkspaceParams & { readonly factId: string };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  /** /memory remember（TUI 直写）：显式记住一条 workspace fact（安全扫描 + 幂等 + 再激活）。 */
  readonly "memory.create": {
    readonly params: WorkspaceParams & { readonly text: string };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.update": {
    readonly params: WorkspaceParams & {
      readonly factId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly kind?: RuntimeMemoryKind;
      readonly title?: string;
      readonly content?: string;
      readonly confidence?: number;
      readonly state?: Exclude<RuntimeMemoryFactState, "forgotten">;
      readonly pinned?: boolean;
      readonly expiresAt?: string | null;
      readonly lastUsedAt?: string | null;
    };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.forget": {
    readonly params: WorkspaceParams & {
      readonly factId: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
    };
    readonly result: { readonly fact: RuntimeMemoryFact };
  };
  readonly "memory.review.list": {
    readonly params: WorkspaceParams & {
      readonly statuses?: readonly RuntimeMemoryProposalStatus[];
      readonly limit?: number;
    };
    readonly result: { readonly proposals: readonly RuntimeMemoryProposal[] };
  };
  readonly "memory.review.resolve": {
    readonly params: WorkspaceParams & {
      readonly proposalId: string;
      readonly resolution: "accepted" | "rejected";
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly factId?: string;
      readonly patch?: {
        readonly kind?: RuntimeMemoryKind;
        readonly title?: string;
        readonly content?: string;
        readonly reason?: string;
        readonly confidence?: number;
      };
    };
    readonly result: {
      readonly proposal: RuntimeMemoryProposal;
      readonly fact?: RuntimeMemoryFact;
    };
  };
  readonly "memory.settings.get": {
    readonly params: { readonly workspacePath?: string };
    readonly result: {
      readonly settings: RuntimeMemorySettings;
      readonly reviewBudget: RuntimeMemoryReviewBudget;
    };
  };
  readonly "memory.settings.update": {
    readonly params: {
      readonly workspacePath?: string;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly enabled?: boolean;
      readonly autoPropose?: boolean;
      readonly autoCommit?: false;
      readonly injectionEnabled?: boolean;
      readonly reviewMode?: "eco" | "balanced" | "quality";
    };
    readonly result: {
      readonly settings: RuntimeMemorySettings;
      readonly reviewBudget: RuntimeMemoryReviewBudget;
    };
  };
  readonly "memory.context.preview": {
    readonly params: WorkspaceParams & {
      readonly maxFacts?: number;
      readonly maxTokens?: number;
    };
    readonly result: {
      readonly facts: readonly RuntimeMemoryFact[];
      readonly budget: RuntimeMemoryContextBudget;
    };
  };
};

export const memoryParamValidators = {
  "memory.list": exactParamShape(
    { workspacePath: stringParam },
    {
      states: enumArrayParam(["active", "disabled", "archived", "forgotten"]),
      kinds: enumArrayParam(["preference", "correction", "project_fact", "reference"]),
      limit: positiveIntegerParam,
    },
  ),
  "memory.get": exactParamShape({
    workspacePath: stringParam,
    factId: boundedNonEmptyStringParam(512),
  }),
  "memory.create": exactParamShape({
    workspacePath: stringParam,
    text: boundedNonEmptyStringParam(8192),
  }),
  "memory.update": memoryUpdateParams,
  "memory.forget": exactParamShape({
    workspacePath: stringParam,
    factId: boundedNonEmptyStringParam(512),
    expectedVersion: positiveIntegerParam,
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "memory.review.list": exactParamShape(
    { workspacePath: stringParam },
    {
      statuses: enumArrayParam(["pending", "accepted", "rejected", "deleted"]),
      limit: positiveIntegerParam,
    },
  ),
  "memory.review.resolve": memoryReviewResolveParams,
  "memory.settings.get": exactParamShape({}, { workspacePath: stringParam }),
  "memory.settings.update": memorySettingsUpdateParams,
  "memory.context.preview": exactParamShape(
    { workspacePath: stringParam },
    { maxFacts: positiveIntegerParam, maxTokens: positiveIntegerParam },
  ),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeParamValidator>>;

export const memoryResultValidators = {
  "memory.list": exactResultShape({ facts: resultArray(memoryFactResult) }),
  "memory.get": exactResultShape({ fact: memoryFactResult }),
  "memory.create": exactResultShape({ fact: memoryFactResult }),
  "memory.update": exactResultShape({ fact: memoryFactResult }),
  "memory.forget": exactResultShape({ fact: memoryFactResult }),
  "memory.review.list": exactResultShape({ proposals: resultArray(memoryProposalResult) }),
  "memory.review.resolve": exactResultShape(
    { proposal: memoryProposalResult },
    { fact: memoryFactResult },
  ),
  "memory.settings.get": exactResultShape({
    settings: memorySettingsResult,
    reviewBudget: memoryReviewBudgetResult,
  }),
  "memory.settings.update": exactResultShape({
    settings: memorySettingsResult,
    reviewBudget: memoryReviewBudgetResult,
  }),
  "memory.context.preview": exactResultShape({
    facts: resultArray(memoryFactResult),
    budget: exactResultShape({
      maxFacts: resultFiniteNumber,
      maxTokens: resultFiniteNumber,
      usedFacts: resultFiniteNumber,
      usedTokens: resultFiniteNumber,
      truncated: resultBoolean,
    }),
  }),
} satisfies Readonly<Record<keyof MemoryMethodMap, RuntimeResultRule>>;
