// Transcript projection, continuity cursors, and subscription parameter/result contracts.
import { MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES, isJsonObject } from "./base.js";
import type { JsonObject, RunId, RuntimeRunStatus, SessionId, WorkspaceParams } from "./base.js";
import { invalidParams, invalidResult } from "./errors.js";
import { runtimePlanControlSnapshotResult } from "./planning.js";
import type { RuntimePlanControlSnapshot } from "./planning.js";
import {
  runtimeQueuedInputResult,
  runtimeRunResult,
  runtimeRunStatusResult,
  runtimeSessionResult,
} from "./session.js";
import type { RuntimeQueuedInput, RuntimeRun, RuntimeSession } from "./session.js";
import {
  assertNestedShape,
  boundedNonEmptyStringParam,
  exactParamShape,
  exactResultShape,
  finiteNumberParam,
  nonNegativeIntegerParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultJsonObject,
  resultNonEmptyString,
  resultNonNegativeInteger,
  resultOneOf,
  resultPositiveInteger,
  resultShape,
  resultString,
  stringParam,
} from "./validation.js";
import type { RuntimeParamRule, RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export const TRANSCRIPT_PROJECTOR_VERSION = 4 as const;

export type RuntimeTranscriptWatermark = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly throughSequence: number;
};

export type RuntimeTranscriptItemRecord = JsonObject & {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly item: RuntimeConversationItem;
};

/**
 * One UTF-8-safe range of the canonical JSON encoding of `RuntimeTranscriptItemRecord.item`.
 * Stable record metadata is repeated on every fragment so clients can validate and assemble
 * without retaining Host-side state between fixed-watermark requests.
 */
export type RuntimeTranscriptItemFragment = JsonObject & {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly json: string;
};

export type RuntimeTranscriptPageCursor = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly throughSequence: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly byteOffset: number;
};

export type RuntimeTranscriptAdvanceCursor = JsonObject & {
  readonly historyEpoch: string;
  readonly projectorVersion: typeof TRANSCRIPT_PROJECTOR_VERSION;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly changeSequence: number;
  readonly ordinal: number;
  readonly byteOffset: number;
};

export type RuntimeTranscriptChange =
  | (JsonObject & { readonly op: "upsert"; readonly record: RuntimeTranscriptItemRecord })
  | (JsonObject & {
      readonly op: "remove";
      readonly itemId: string;
      readonly itemRevision: number;
    });

export type RuntimeActiveOverlayEntry = JsonObject & {
  readonly runId: RunId;
  readonly turnId: string;
  readonly itemId: string;
  readonly streamId: string;
  readonly kind: "text" | "thinking" | "toolOutput";
  readonly startOffsetBytes: number;
  readonly endOffsetBytes: number;
  readonly text: string;
  readonly anchorSequence: number;
  readonly stream?: "stdout" | "stderr";
  readonly truncatedBeforeBytes?: number;
  readonly complete?: true;
};

export type RuntimeSessionSubscriptionEnvelope = JsonObject & {
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  readonly sequence: number;
  readonly sessionId: SessionId;
};

export type RuntimeSessionSubscriptionFrame = RuntimeSessionSubscriptionEnvelope &
  (
    | (JsonObject & {
        readonly type: "subscription.session_delta";
        readonly runId: RunId;
        readonly turnId: string;
        readonly itemId: string;
        readonly streamId: string;
        readonly kind: "text" | "thinking" | "toolOutput";
        readonly startOffsetBytes: number;
        readonly text: string;
        readonly stream?: "stdout" | "stderr";
        readonly reset?: true;
        readonly complete?: true;
      })
    | (JsonObject & {
        readonly type: "subscription.tool_event" | "subscription.subagent_update";
        readonly payload: JsonObject;
      })
    | (JsonObject & {
        readonly type: "subscription.run_state";
        readonly run: RuntimeRun;
      })
    | (JsonObject & {
        readonly type: "subscription.transcript_advanced";
        readonly watermark: RuntimeTranscriptWatermark;
      })
    | (JsonObject & {
        readonly type: "subscription.resource_changed";
        readonly resource: "tasks" | "artifacts" | "trace" | "context";
        readonly revision?: number;
        readonly watermark?: number;
      })
    | (JsonObject & {
        readonly type: "subscription.continuity_degraded";
        readonly reason: "partial_persistence_failed" | "recovery_failed";
      })
    | (JsonObject & {
        readonly type: "subscription.closed";
        readonly reason: "client_closed" | "slow_consumer" | "host_shutdown";
      })
  );

export type RuntimeToolResultEnvelope = JsonObject & {
  readonly version: 1;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: "succeeded" | "failed" | "rejected" | "cancelled" | "interrupted";
  readonly rawSizeBytes: number;
  readonly sha256: string;
  readonly deliveryTruncated: boolean;
  readonly projection: JsonObject & {
    readonly version: 1;
    readonly mode: "full" | "preview" | "synthetic";
    readonly text: string;
    readonly strategy: string;
    readonly truncated: boolean;
  };
  readonly evidence?: JsonObject & {
    readonly uri: string;
    readonly ref: JsonObject & {
      readonly schemaVersion: 2;
      readonly contentHash: string;
      readonly sessionId: string;
      readonly kind: "tool-exchange";
    };
  };
};

export type RuntimeConversationItem = (
  | (JsonObject & {
      readonly id: string;
      readonly kind: "userMessage" | "systemNotice" | "error";
      readonly content: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "assistantMessage";
      readonly content: string;
      /** Present when the durable answer can be tied to one Runtime model turn. */
      readonly runId?: RunId;
      readonly turnId?: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      /** Provider explicitly returned reasoning/thinking content. */
      readonly kind: "thinking";
      readonly content: string;
      /** Present when the durable message can be tied to one Runtime model turn. */
      readonly runId?: RunId;
      readonly turnId?: string;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "skill";
      readonly name: string;
      readonly args: string;
      readonly trigger: "user-slash" | "model-tool";
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "plan";
      readonly title: string;
      readonly detail?: string;
      readonly state?: "waiting" | "active" | "done" | "failed";
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly args: string;
      readonly status: "running" | "success" | "error";
      readonly summary?: string;
      /** Stable projector metadata used to reconcile tool start/result records. */
      readonly data?: JsonObject;
      /** Present only after a canonical tool.result.recorded fact exists. */
      readonly result?: RuntimeToolResultEnvelope;
      readonly at?: number;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "runBoundary";
      readonly runId?: RunId;
      readonly status: RuntimeRunStatus;
      readonly startedAt: number;
      readonly finishedAt?: number;
      /** Terminal Run failure reason. Running boundaries never carry this field. */
      readonly error?: string;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "approval" | "prompt" | "changes" | "goal";
      readonly title: string;
      readonly detail?: string;
      readonly state?: string;
      readonly at?: number;
      readonly data?: JsonObject;
    })
  | (JsonObject & {
      readonly id: string;
      readonly kind: "subagent";
      readonly name?: string;
      readonly title: string;
      readonly detail?: string;
      readonly state?: string;
      readonly at?: number;
      readonly data?: JsonObject;
    })
) & {
  /** 单条目超出 IPC 字节预算时的诚实降级标记。 */
  readonly truncated?: true;
  readonly originalBytes?: number;
};

const transcriptProjectorVersionParam: RuntimeParamRule = (value, path) => {
  if (value !== TRANSCRIPT_PROJECTOR_VERSION) {
    throw invalidParams(`${path} 必须是 ${TRANSCRIPT_PROJECTOR_VERSION}`);
  }
};

const transcriptWatermarkParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    throughSequence: nonNegativeIntegerParam,
  });
};

const transcriptPageCursorParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    throughSequence: nonNegativeIntegerParam,
    positionSequence: nonNegativeIntegerParam,
    positionOrdinal: nonNegativeIntegerParam,
    byteOffset: nonNegativeIntegerParam,
  });
};

const transcriptAdvanceCursorParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(value, path, {
    historyEpoch: boundedNonEmptyStringParam(512),
    projectorVersion: transcriptProjectorVersionParam,
    fromSequence: nonNegativeIntegerParam,
    throughSequence: nonNegativeIntegerParam,
    changeSequence: nonNegativeIntegerParam,
    ordinal: nonNegativeIntegerParam,
    byteOffset: nonNegativeIntegerParam,
  });
};

const transcriptWatermarkResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    throughSequence: resultNonNegativeInteger,
  })(value, path);
};

const transcriptPageCursorResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    throughSequence: resultNonNegativeInteger,
    positionSequence: resultNonNegativeInteger,
    positionOrdinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
  })(value, path);
};

const transcriptAdvanceCursorResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    historyEpoch: resultNonEmptyString,
    projectorVersion: resultOneOf([TRANSCRIPT_PROJECTOR_VERSION]),
    fromSequence: resultNonNegativeInteger,
    throughSequence: resultNonNegativeInteger,
    changeSequence: resultNonNegativeInteger,
    ordinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
  })(value, path);
};

const runtimeToolResultEnvelopeResult: RuntimeResultRule = (value, path) => {
  exactResultShape(
    {
      version: resultOneOf([1]),
      toolCallId: resultNonEmptyString,
      toolName: resultNonEmptyString,
      status: resultOneOf(["succeeded", "failed", "rejected", "cancelled", "interrupted"]),
      rawSizeBytes: resultNonNegativeInteger,
      sha256: resultString,
      deliveryTruncated: resultBoolean,
      projection: resultJsonObject,
    },
    {
      evidence: resultJsonObject,
    },
  )(value, path);
  if (!isJsonObject(value)) return;
  if (!/^[a-f0-9]{64}$/u.test(String(value["sha256"]))) {
    throw invalidResult(`${path}.sha256 必须是 SHA-256`);
  }
  const projection = value["projection"];
  exactResultShape({
    version: resultOneOf([1]),
    mode: resultOneOf(["full", "preview", "synthetic"]),
    text: resultString,
    strategy: resultNonEmptyString,
    truncated: resultBoolean,
  })(projection, `${path}.projection`);
  if (
    isJsonObject(projection) &&
    typeof projection["text"] === "string" &&
    Buffer.byteLength(projection["text"], "utf8") > MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES
  ) {
    throw invalidResult(
      `${path}.projection.text 超过 ${MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES} 字节上限`,
    );
  }
  if (
    isJsonObject(projection) &&
    projection["mode"] === "synthetic" &&
    (value["status"] === "succeeded" || value["status"] === "failed")
  ) {
    throw invalidResult(`${path}.projection.mode 与 status 不兼容`);
  }

  const evidence = value["evidence"];
  if (evidence === undefined) return;
  exactResultShape({ uri: resultString, ref: resultJsonObject })(evidence, `${path}.evidence`);
  if (!isJsonObject(evidence)) return;
  const reference = evidence["ref"];
  exactResultShape({
    schemaVersion: resultOneOf([2]),
    contentHash: resultString,
    sessionId: resultNonEmptyString,
    kind: resultOneOf(["tool-exchange"]),
  })(reference, `${path}.evidence.ref`);
  if (!isJsonObject(reference) || !/^[a-f0-9]{64}$/u.test(String(reference["contentHash"]))) {
    throw invalidResult(`${path}.evidence.ref.contentHash 必须是 SHA-256`);
  }
  const expectedUri = `pico://evidence/${encodeURIComponent(
    String(reference["sessionId"]),
  )}/${String(reference["contentHash"])}`;
  if (evidence["uri"] !== expectedUri) {
    throw invalidResult(`${path}.evidence.uri 与 ref 不一致`);
  }
};

const runtimeConversationItemResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是对象`);
  const kind = value["kind"];
  resultShape(
    {
      id: resultString,
      kind: resultOneOf([
        "userMessage",
        "assistantMessage",
        "systemNotice",
        "error",
        "thinking",
        "skill",
        "plan",
        "tool",
        "runBoundary",
        "approval",
        "prompt",
        "changes",
        "subagent",
        "goal",
      ]),
    },
    {
      at: resultFiniteNumber,
      truncated: resultOneOf([true]),
      originalBytes: resultFiniteNumber,
    },
  )(value, path);
  if (kind === "userMessage" || kind === "systemNotice" || kind === "error") {
    resultShape({ content: resultString })(value, path);
    return;
  }
  if (kind === "assistantMessage" || kind === "thinking") {
    resultShape({ content: resultString }, { runId: resultString, turnId: resultString })(
      value,
      path,
    );
    return;
  }
  if (kind === "skill") {
    resultShape({
      name: resultString,
      args: resultString,
      trigger: resultOneOf(["user-slash", "model-tool"]),
    })(value, path);
    return;
  }
  if (
    kind === "plan" ||
    ["approval", "prompt", "changes", "subagent", "goal"].includes(String(kind))
  ) {
    resultShape(
      { title: resultString },
      {
        detail: resultString,
        state: resultString,
        ...(kind === "subagent" ? { name: resultString } : {}),
      },
    )(value, path);
    return;
  }
  if (kind === "tool") {
    exactResultShape(
      {
        id: resultString,
        kind: resultOneOf(["tool"]),
        name: resultString,
        args: resultString,
        status: resultOneOf(["running", "success", "error"]),
      },
      {
        summary: resultString,
        data: resultJsonObject,
        result: runtimeToolResultEnvelopeResult,
        at: resultFiniteNumber,
        truncated: resultOneOf([true]),
        originalBytes: resultNonNegativeInteger,
      },
    )(value, path);
    return;
  }
  if (kind === "runBoundary") {
    resultShape(
      { status: runtimeRunStatusResult, startedAt: resultFiniteNumber },
      { runId: resultString, finishedAt: resultFiniteNumber, error: resultString },
    )(value, path);
    return;
  }
};

const transcriptItemRecordResult: RuntimeResultRule = exactResultShape({
  itemId: resultNonEmptyString,
  itemRevision: resultPositiveInteger,
  positionSequence: resultNonNegativeInteger,
  positionOrdinal: resultNonNegativeInteger,
  item: runtimeConversationItemResult,
});

const transcriptItemFragmentResult: RuntimeResultRule = (value, path) => {
  exactResultShape({
    itemId: resultNonEmptyString,
    itemRevision: resultPositiveInteger,
    positionSequence: resultNonNegativeInteger,
    positionOrdinal: resultNonNegativeInteger,
    byteOffset: resultNonNegativeInteger,
    byteLength: resultPositiveInteger,
    totalBytes: resultPositiveInteger,
    json: resultString,
  })(value, path);
  const fragment = value as RuntimeTranscriptItemFragment;
  if (fragment.byteOffset + fragment.byteLength > fragment.totalBytes) {
    throw invalidResult(`${path} 字节范围超过完整 item JSON`);
  }
  if (new TextEncoder().encode(fragment.json).byteLength !== fragment.byteLength) {
    throw invalidResult(`${path}.byteLength 与 UTF-8 JSON 分片不一致`);
  }
};

const transcriptChangeResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 transcript change 对象`);
  if (value["op"] === "upsert") {
    exactResultShape({ op: resultOneOf(["upsert"]), record: transcriptItemRecordResult })(
      value,
      path,
    );
    return;
  }
  exactResultShape({
    op: resultOneOf(["remove"]),
    itemId: resultNonEmptyString,
    itemRevision: resultPositiveInteger,
  })(value, path);
};

const activeOverlayEntryResult: RuntimeResultRule = exactResultShape(
  {
    runId: resultNonEmptyString,
    turnId: resultNonEmptyString,
    itemId: resultNonEmptyString,
    streamId: resultNonEmptyString,
    kind: resultOneOf(["text", "thinking", "toolOutput"]),
    startOffsetBytes: resultNonNegativeInteger,
    endOffsetBytes: resultNonNegativeInteger,
    text: resultString,
    anchorSequence: resultNonNegativeInteger,
  },
  {
    stream: resultOneOf(["stdout", "stderr"]),
    truncatedBeforeBytes: resultNonNegativeInteger,
    complete: resultOneOf([true]),
  },
);

export type TranscriptMethodMap = {
  readonly "session.subscription.open": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly tailLimit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly session: RuntimeSession;
      readonly hostEpoch: string;
      readonly subscriptionId: string;
      readonly nextSequence: number;
      readonly watermark: RuntimeTranscriptWatermark;
      readonly durableTail: readonly RuntimeTranscriptItemRecord[];
      readonly durableTailFragments?: readonly RuntimeTranscriptItemFragment[];
      readonly activeOverlay: readonly RuntimeActiveOverlayEntry[];
      readonly queuedInputs: readonly RuntimeQueuedInput[];
      readonly planControl?: RuntimePlanControlSnapshot;
      readonly activeRun?: RuntimeRun;
      readonly olderCursor?: RuntimeTranscriptPageCursor;
      readonly continuityDegradedReason?: "partial_persistence_failed" | "recovery_failed";
    };
  };
  readonly "session.subscription.close": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly subscriptionId: string;
    };
    readonly result: { readonly closed: true };
  };
  readonly "session.transcript.page": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly through: RuntimeTranscriptWatermark;
      readonly cursor?: RuntimeTranscriptPageCursor;
      readonly limit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly watermark: RuntimeTranscriptWatermark;
      readonly items: readonly RuntimeTranscriptItemRecord[];
      readonly fragments?: readonly RuntimeTranscriptItemFragment[];
      readonly nextCursor?: RuntimeTranscriptPageCursor;
    };
  };
  readonly "session.transcript.advance": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly after: RuntimeTranscriptWatermark;
      readonly through: RuntimeTranscriptWatermark;
      readonly cursor?: RuntimeTranscriptAdvanceCursor;
      readonly limit?: number;
      readonly maxBytes?: number;
    };
    readonly result: {
      readonly after: RuntimeTranscriptWatermark;
      readonly through: RuntimeTranscriptWatermark;
      readonly changes: readonly RuntimeTranscriptChange[];
      readonly fragments?: readonly RuntimeTranscriptItemFragment[];
      readonly nextCursor?: RuntimeTranscriptAdvanceCursor;
    };
  };
  readonly "session.evidence.read": {
    readonly params: WorkspaceParams & {
      readonly sessionId: SessionId;
      readonly evidenceUri: string;
      readonly offsetBytes?: number;
      readonly limitBytes?: number;
    };
    readonly result: {
      readonly evidenceUri: string;
      readonly content: string;
      readonly offsetBytes: number;
      readonly endOffsetBytes: number;
      readonly totalBytes: number;
      readonly limitBytes: number;
      readonly truncated: boolean;
      readonly nextOffsetBytes?: number;
    };
  };
};

export const transcriptParamValidators = {
  "session.subscription.open": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam },
    { tailLimit: positiveIntegerParam, maxBytes: positiveIntegerParam },
  ),
  "session.subscription.close": exactParamShape({
    workspacePath: stringParam,
    sessionId: stringParam,
    subscriptionId: boundedNonEmptyStringParam(512),
  }),
  "session.transcript.page": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam, through: transcriptWatermarkParam },
    {
      cursor: transcriptPageCursorParam,
      limit: positiveIntegerParam,
      maxBytes: positiveIntegerParam,
    },
  ),
  "session.transcript.advance": exactParamShape(
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      after: transcriptWatermarkParam,
      through: transcriptWatermarkParam,
    },
    {
      cursor: transcriptAdvanceCursorParam,
      limit: positiveIntegerParam,
      maxBytes: positiveIntegerParam,
    },
  ),
  "session.evidence.read": exactParamShape(
    { workspacePath: stringParam, sessionId: stringParam, evidenceUri: stringParam },
    { offsetBytes: finiteNumberParam, limitBytes: finiteNumberParam },
  ),
} satisfies Readonly<Record<keyof TranscriptMethodMap, RuntimeParamValidator>>;

export const transcriptResultValidators = {
  "session.subscription.open": exactResultShape(
    {
      session: runtimeSessionResult,
      hostEpoch: resultNonEmptyString,
      subscriptionId: resultNonEmptyString,
      nextSequence: resultPositiveInteger,
      watermark: transcriptWatermarkResult,
      durableTail: resultArray(transcriptItemRecordResult),
      activeOverlay: resultArray(activeOverlayEntryResult),
      queuedInputs: resultArray(runtimeQueuedInputResult),
    },
    {
      activeRun: runtimeRunResult,
      planControl: runtimePlanControlSnapshotResult,
      durableTailFragments: resultArray(transcriptItemFragmentResult),
      olderCursor: transcriptPageCursorResult,
      continuityDegradedReason: resultOneOf(["partial_persistence_failed", "recovery_failed"]),
    },
  ),
  "session.subscription.close": exactResultShape({ closed: resultOneOf([true]) }),
  "session.transcript.page": exactResultShape(
    {
      watermark: transcriptWatermarkResult,
      items: resultArray(transcriptItemRecordResult),
    },
    {
      fragments: resultArray(transcriptItemFragmentResult),
      nextCursor: transcriptPageCursorResult,
    },
  ),
  "session.transcript.advance": exactResultShape(
    {
      after: transcriptWatermarkResult,
      through: transcriptWatermarkResult,
      changes: resultArray(transcriptChangeResult),
    },
    {
      fragments: resultArray(transcriptItemFragmentResult),
      nextCursor: transcriptAdvanceCursorResult,
    },
  ),
  "session.evidence.read": resultShape(
    {
      evidenceUri: resultString,
      content: resultString,
      offsetBytes: resultNonNegativeInteger,
      endOffsetBytes: resultNonNegativeInteger,
      totalBytes: resultNonNegativeInteger,
      limitBytes: resultNonNegativeInteger,
      truncated: resultBoolean,
    },
    { nextOffsetBytes: resultNonNegativeInteger },
  ),
} satisfies Readonly<Record<keyof TranscriptMethodMap, RuntimeResultRule>>;
