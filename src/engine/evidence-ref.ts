/**
 * EvidenceRef — 统一会话事件溯源契约（overlay 层）。
 *
 * 三套 provenance（RuntimeEventBase / Source / RuntimeEventRecord）各自为政、无共享接口。
 * EvidenceRef 不替代它们，只提供统一的"引用事实"词汇：把离散的 eventId 指针升级为
 * 带流身份、区间语义、内容摘要的可校验 cursor。零持久化侵入——它是 overlay 视角，
 * 现有结构保持原样，EvidenceRef 只是读取它们的统一引用契约。
 *
 * 设计参考 maka ExecutionEvidenceRef 的六条模式：引用事实而非成为事实、车道化、
 * 序号+audit 双指针、构造即校验、schemaVersion 字面量类型、至少一条身份车道。
 *
 * 本契约只覆盖会话级事件账本（session.jsonl / RuntimeEventStore）。RuntimeEventRecord
 * 是独立的 daemon 控制面通知，与账本零代码关联，刻意不纳入。
 */

export const EVIDENCE_REF_SCHEMA_VERSION = "pico.evidence_ref.v1" as const;

/**
 * Cursor：引用一条 canonical 会话事件流（session.jsonl）内的区间。
 *
 * 序号是唯一排序字段；eventId 仅作 audit/dedup，禁止用于排序。
 * 这与 pico 事件账本的物理 append 顺序对齐。
 */
export interface RuntimeEventCursor {
  /** 流种类：会话级事件账本 */
  readonly ledger: "session_runtime_event";
  /** 流身份：sessionId（sequence 是 session 级全局 append 序号） */
  readonly streamId: string;
  /** 流内 append 序号（session 级，1-based），inclusive 下界。省略表示从流起点。 */
  readonly lowSequence?: number;
  /** 流内 append 序号（session 级，1-based），inclusive 上界。必填。 */
  readonly highSequence: number;
  /** 可选 audit/dedup 指针——禁止用于排序，仅用于身份校验。 */
  readonly eventIds?: readonly string[];
  /** 实际行数（highSequence-lowSequence+1，因历史可能含不可投影事件而略少）。 */
  readonly eventCount?: number;
}

/**
 * 统一事件溯源引用。引用会话事件账本内的一段事实，而非成为新的事实权威。
 *
 * 会话身份车道：sessionId 必填，invocationId/runId/turnId 可选（按需补充粒度）。
 * coverage：把离散 eventId 升级为带流身份的区间 cursor。
 * digest：可选内容寻址摘要（Source 已有，RuntimeEventBase 无——EvidenceRef 让它可选）。
 * toolCallId/providerCallId：复用 RuntimeEventBase.refs 的现有钩子，不新造概念。
 */
export interface EvidenceRef {
  readonly schemaVersion: typeof EVIDENCE_REF_SCHEMA_VERSION;
  /** 会话身份车道（必填） */
  readonly sessionId: string;
  readonly invocationId?: string;
  readonly runId?: string;
  readonly turnId?: string;
  /** 事件流覆盖 */
  readonly coverage?: RuntimeEventCursor;
  /** 内容寻址摘要（可选，强校验用） */
  readonly digest?: string;
  /** 工具调用级 provenance（复用现有 refs 钩子） */
  readonly toolCallId?: string;
  readonly providerCallId?: string;
}

export type EvidenceRefValidationCode =
  | "missing_schema_version"
  | "wrong_schema_version"
  | "missing_session_lane"
  | "coverage_stream_id_mismatch"
  | "coverage_sequence_inverted"
  | "invalid_coverage_shape"
  | "invalid_optional_field_type"
  | "empty_event_ids"
  | "zero_event_count";

export type EvidenceRefValidation =
  | { readonly ok: true; readonly ref: EvidenceRef }
  | { readonly ok: false; readonly code: EvidenceRefValidationCode; readonly detail: string };

/**
 * 构造即校验：把非法 ref 扼杀在构造时。
 *
 * 校验项：
 * - schemaVersion 必填且严格等于 EVIDENCE_REF_SCHEMA_VERSION（字面量类型编译期防线）
 * - sessionId 必填（会话身份车道）
 * - coverage 存在时，streamId 必须绑定到 runId 或 sessionId（防张冠李戴）
 * - coverage 存在时，lowSequence 不得大于 highSequence
 */
export function validateEvidenceRef(value: unknown): EvidenceRefValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, code: "missing_schema_version", detail: "value is not an object" };
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== EVIDENCE_REF_SCHEMA_VERSION) {
    return v.schemaVersion === undefined
      ? { ok: false, code: "missing_schema_version", detail: "schemaVersion is required" }
      : {
          ok: false,
          code: "wrong_schema_version",
          detail: `schemaVersion ${String(v.schemaVersion)} !== ${EVIDENCE_REF_SCHEMA_VERSION}`,
        };
  }
  if (typeof v.sessionId !== "string" || v.sessionId.length === 0) {
    return { ok: false, code: "missing_session_lane", detail: "sessionId is required" };
  }
  // 可选身份车道字段类型校验（防运行时类型混淆）
  const optionalStringFields: Array<[string, string]> = [
    ["invocationId", "invocationId"],
    ["runId", "runId"],
    ["turnId", "turnId"],
    ["digest", "digest"],
    ["toolCallId", "toolCallId"],
    ["providerCallId", "providerCallId"],
  ];
  for (const [key, name] of optionalStringFields) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      return {
        ok: false,
        code: "invalid_optional_field_type",
        detail: `${name} must be a string if present, got ${typeof v[key]}`,
      };
    }
  }
  const coverage = v.coverage;
  if (coverage !== undefined) {
    if (typeof coverage !== "object" || coverage === null) {
      return { ok: false, code: "invalid_coverage_shape", detail: "coverage is not an object" };
    }
    const c = coverage as Record<string, unknown>;
    // ledger 必须是合法字面量
    if (c.ledger !== "session_runtime_event") {
      return {
        ok: false,
        code: "invalid_coverage_shape",
        detail: `coverage.ledger must be "session_runtime_event"`,
      };
    }
    const streamId = c.streamId;
    const runId = v.runId;
    const sessionId = v.sessionId;
    // streamId 必须绑定到 runId 或 sessionId（防张冠李戴）
    if (typeof streamId !== "string" || (streamId !== runId && streamId !== sessionId)) {
      return {
        ok: false,
        code: "coverage_stream_id_mismatch",
        detail: `coverage.streamId ${String(streamId)} must equal runId or sessionId`,
      };
    }
    const low = typeof c.lowSequence === "number" ? c.lowSequence : undefined;
    const high = c.highSequence;
    if (typeof high !== "number" || !Number.isSafeInteger(high) || high < 0) {
      return {
        ok: false,
        code: "coverage_sequence_inverted",
        detail: "coverage.highSequence is required and must be a non-negative safe integer",
      };
    }
    if (low !== undefined && (!Number.isSafeInteger(low) || low < 0)) {
      return {
        ok: false,
        code: "coverage_sequence_inverted",
        detail: `coverage.lowSequence must be a non-negative safe integer, got ${low}`,
      };
    }
    if (low !== undefined && low > high) {
      return {
        ok: false,
        code: "coverage_sequence_inverted",
        detail: `lowSequence ${low} > highSequence ${high}`,
      };
    }
    // eventIds 若存在必须是非空字符串数组
    if (c.eventIds !== undefined) {
      if (!Array.isArray(c.eventIds) || !c.eventIds.every((e) => typeof e === "string")) {
        return {
          ok: false,
          code: "invalid_coverage_shape",
          detail: "coverage.eventIds must be an array of strings",
        };
      }
      if (c.eventIds.length === 0) {
        return {
          ok: false,
          code: "empty_event_ids",
          detail: "coverage.eventIds must not be empty (use undefined instead)",
        };
      }
    }
    // eventCount 若存在必须是正整数（0 无意义——highSequence 必填意味着至少覆盖一条）
    if (c.eventCount !== undefined) {
      if (
        typeof c.eventCount !== "number" ||
        !Number.isSafeInteger(c.eventCount) ||
        c.eventCount <= 0
      ) {
        return {
          ok: false,
          code: "zero_event_count",
          detail: "coverage.eventCount must be a positive safe integer",
        };
      }
    }
  }
  return { ok: true, ref: v as unknown as EvidenceRef };
}

/**
 * 比较两个 cursor 的序号顺序。
 *
 * 拒绝跨流比较——不同 ledger 或 streamId 的 sequence 没有可比性。
 * `incomparable` 是一等返回值，逼调用方显式处理跨流情形。
 * `conflict` 检测"序号相等但 audit eventId 冲突"，用于发现账本损坏。
 */
export type CursorComparison = "before" | "equal" | "after" | "incomparable" | "conflict";

export function compareCursors(
  left: RuntimeEventCursor,
  right: RuntimeEventCursor,
): CursorComparison {
  if (left.ledger !== right.ledger || left.streamId !== right.streamId) {
    return "incomparable";
  }
  if (left.highSequence < right.highSequence) return "before";
  if (left.highSequence > right.highSequence) return "after";
  // highSequence 相等——检查 audit eventIds 一致性
  const leftIds = left.eventIds;
  const rightIds = right.eventIds;
  if (
    leftIds !== undefined &&
    rightIds !== undefined &&
    leftIds.length > 0 &&
    rightIds.length > 0
  ) {
    // 完整比较：长度或任一元素不同 → conflict
    if (leftIds.length !== rightIds.length || leftIds.some((id, i) => id !== rightIds[i])) {
      return "conflict";
    }
  }
  return "equal";
}
