import { createHash } from "node:crypto";
import type { Message, ToolCall } from "../schema/message.js";
import type { RuntimeCheckpointRecordedEvent, RuntimeEvent } from "./session-runtime-event.js";
import { claimKindForEvent, projectRuntimeModelMessage } from "./runtime-model-message.js";
import {
  computeCheckpointSourceDigest,
  CONTENT_DIGEST_V1_PREFIX,
} from "../context/runtime-compaction-checkpoint.js";
import type { RuntimeProjectionDiagnostic } from "./runtime-projection-diagnostics.js";
import { makeDiagnostic } from "./runtime-projection-diagnostics.js";

export interface RuntimeHistoryProjectionEntry {
  /** False when cutting here would split a reordered interruption-recovery span. */
  readonly compactionBoundarySafe?: boolean;
  /** The immutable event that currently contributes this model-visible message. */
  readonly eventId: string;
  readonly message: Message;
}

/**
 * read-model 投影实际消费的事件 kind 集(票 04 数据来源窄化):
 * 折叠规则不变,消费方用 kind 切片查询替代全量 readSession——其余 kind 在
 * materializePrefix 里只产 soft 诊断(被 entries 丢弃),不影响输出。
 */
export const RUNTIME_HISTORY_EVENT_KINDS = [
  "message.committed",
  "tool.result.recorded",
  "context.checkpoint.recorded",
] as const;

/** raw model-message 投影(无 checkpoint 替换)消费的 kind 集。 */
export const RUNTIME_MODEL_MESSAGE_EVENT_KINDS = [
  "message.committed",
  "tool.result.recorded",
] as const;

/**
 * 投影结果：entries + 结构化诊断。
 * hard 诊断在 materializeRuntimeHistoryProjection 内已 throw（fail-closed），
 * 这里的 diagnostics 只含 soft 诊断（unclaimed_control_fact / partial_event_skipped）。
 */
export interface RuntimeHistoryProjection {
  readonly entries: RuntimeHistoryProjectionEntry[];
  readonly diagnostics: readonly RuntimeProjectionDiagnostic[];
}

export class RuntimeEventReadModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventReadModelIntegrityError";
  }
}

/**
 * ADR 26 §2.3(票 E2):读取侧上下文预算 gate——组装出的 provider 消息总字节上限。
 * 取值对齐入口上限门 MAX_TOOL_RESULT_BYTES 的量级(1MB):高于常规压缩水位
 * (inputBudgetTokens 的 75% ≈ 数百 KB),因此正常会话仍由 token 维度的
 * checkpoint 压缩主导,本 gate 只拦截"两条压缩之间被大全文撑爆"的病态穿透,
 * 不与压缩机制互相打架。
 */
export const MAX_MODEL_HISTORY_BYTES = 1024 * 1024;

/**
 * 预算裁剪永不触及的末尾(当前工作集)消息条数。覆盖最坏并行工具批次
 * (MAX_TOOL_CONCURRENCY=8:assistant 批次 + 8 条结果)+ 当前用户输入与余量。
 */
export const MODEL_HISTORY_PRESERVED_TAIL_MESSAGES = 12;

/** 小于此字节的消息不参与降级:裁掉节省无几,却会无谓丢失上下文针脚。 */
const MIN_DEGRADABLE_MESSAGE_BYTES = 2048;

export interface ModelHistoryByteBudgetOptions {
  readonly maxTotalBytes: number;
  /** 末尾永不裁剪的消息条数,缺省 {@link MODEL_HISTORY_PRESERVED_TAIL_MESSAGES}。 */
  readonly preservedTailMessages?: number;
}

/**
 * 读取侧上下文预算 gate(ADR 26 §2.3,票 E2)。写入侧全文 inline 入库后,
 * provider 消息组装在此按总字节预算裁剪:超预算时从最旧的大内容开始降级为
 * 带诊断标记的截断视图(标记内嵌原始字节数与事件定位,不静默),末尾工作集
 * 永不裁剪。降级只替换 content 并保留 role/toolCallId/toolCalls,配对不变量
 * (assertToolCallPairing)在投影阶段已校验,这里不破坏它。
 *
 * 纯读取视图:不回写事件;预算内原样返回(同一数组引用)。
 */
export function applyModelHistoryByteBudget(
  entries: readonly RuntimeHistoryProjectionEntry[],
  options: ModelHistoryByteBudgetOptions,
): readonly RuntimeHistoryProjectionEntry[] {
  if (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 1) {
    throw new Error("Model history byte budget requires a positive safe integer maxTotalBytes");
  }
  const preservedTailMessages =
    options.preservedTailMessages ?? MODEL_HISTORY_PRESERVED_TAIL_MESSAGES;
  if (!Number.isSafeInteger(preservedTailMessages) || preservedTailMessages < 0) {
    throw new Error("Model history byte budget requires a non-negative preservedTailMessages");
  }
  const sizes = entries.map(({ message }) => messageBytes(message));
  let totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes <= options.maxTotalBytes) return entries;

  const budgeted = [...entries];
  const oldestDegradeIndex = Math.max(0, budgeted.length - preservedTailMessages);
  for (let index = 0; index < oldestDegradeIndex && totalBytes > options.maxTotalBytes; index++) {
    const originalBytes = sizes[index]!;
    if (originalBytes < MIN_DEGRADABLE_MESSAGE_BYTES) continue;
    const entry = budgeted[index]!;
    const marker = degradedHistoryContentMarker(entry.message, entry.eventId, originalBytes);
    budgeted[index] = { eventId: entry.eventId, message: { ...entry.message, content: marker } };
    totalBytes +=
      Buffer.byteLength(marker, "utf8") - Buffer.byteLength(entry.message.content, "utf8");
  }
  return budgeted;
}

function degradedHistoryContentMarker(
  message: Message,
  eventId: string,
  originalBytes: number,
): string {
  return (
    `[历史输出已按上下文预算裁剪:原文约 ${originalBytes} 字节,完整内容见事件 ${eventId}` +
    `${message.toolCallId ? `(工具调用 ${message.toolCallId})` : ""}]`
  );
}

function messageBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Engine-owned pure read model for Session durable facts. The Runtime adapter
 * re-exports this implementation for existing callers, but no Runtime value
 * is imported by this module.
 */
export function projectRuntimeEventsToMessages(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistory(events);
}

export function materializeRuntimeHistory(events: readonly RuntimeEvent[]): Message[] {
  return materializeRuntimeHistoryEntries(events).map(({ message }) => message);
}

export function projectRuntimeEventsToMessageEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return materializeRuntimeHistoryEntries(events);
}

export function materializeRuntimeHistoryEntries(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjectionEntry[] {
  return materializeRuntimeHistoryProjection(events).entries;
}

/**
 * 带诊断的投影入口。hard 诊断仍 throw（fail-closed 不变）；soft 诊断收集到结果里。
 * 这是新增的主投影函数，其余三个旧函数委托它、签名不变——现有消费者零改动。
 */
export function materializeRuntimeHistoryProjection(
  events: readonly RuntimeEvent[],
): RuntimeHistoryProjection {
  const diagnostics: RuntimeProjectionDiagnostic[] = [];
  const eventIndexes = new Map<string, number>();
  for (const [eventIndex, event] of events.entries()) {
    if (eventIndexes.has(event.eventId)) {
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime history contains duplicate event ID ${event.eventId}`,
      );
    }
    eventIndexes.set(event.eventId, eventIndex);
  }

  const { projected, prefixDiagnostics } = materializePrefix(events, events.length, eventIndexes);
  diagnostics.push(...prefixDiagnostics);
  // assertToolCallPairing 检测的都是 hard 违规（配对错位/悬空/重复），仍直接 throw
  assertToolCallPairing(projected.map(({ message }) => message));
  markUnsafeCompactionBoundaries(projected, events, eventIndexes);
  return { entries: projected, diagnostics };
}

function materializePrefix(
  events: readonly RuntimeEvent[],
  endExclusive: number,
  eventIndexes: ReadonlyMap<string, number>,
): {
  projected: RuntimeHistoryProjectionEntry[];
  prefixDiagnostics: RuntimeProjectionDiagnostic[];
} {
  const prefixDiagnostics: RuntimeProjectionDiagnostic[] = [];
  const projected: RuntimeHistoryProjectionEntry[] = [];
  let recoveryFloor = 0;
  for (let eventIndex = 0; eventIndex < endExclusive; eventIndex++) {
    const event = events[eventIndex]!;
    if (event.kind === "context.checkpoint.recorded") {
      restoreInterruptedResults(projected, recoveryFloor, events, eventIndexes);
      replaceProjectedPrefixWithCheckpoint(projected, event, eventIndexes, eventIndex);
      // Never borrow a result from after a checkpoint to repair its prior history.
      recoveryFloor = projected.length;
      continue;
    }
    // claim coverage 契约：每个 kind 必须显式 claim，未知 kind 不再静默丢失
    const claim = claimKindForEvent(event);
    if (claim === undefined) {
      // 纵深防御：解码层已拦截 unknown_kind，投影层再防一道
      throw new RuntimeEventReadModelIntegrityError(
        `Runtime event ${event.eventId} has unsupported kind ${event.kind}`,
      );
    }
    if (claim === "message") {
      if (event.partial) {
        prefixDiagnostics.push(
          makeDiagnostic("partial_event_skipped", event.eventId, `partial ${event.kind}`),
        );
        continue;
      }
      if (event.visibility !== "model") {
        // transcript/internal 可见度的 message 事件不进 model 投影（control 语义）
        prefixDiagnostics.push(
          makeDiagnostic(
            "unclaimed_control_fact",
            event.eventId,
            `${event.kind} visibility=${event.visibility}`,
          ),
        );
        continue;
      }
      const message = projectRuntimeModelMessage(event);
      if (!message) {
        throw new RuntimeEventReadModelIntegrityError(
          `Runtime event ${event.eventId} has no model projection`,
        );
      }
      projected.push({ eventId: event.eventId, message: cloneMessage(message) });
    } else {
      // claim === "control"：控制事实无 chat 行是正常的，产 soft 诊断
      prefixDiagnostics.push(makeDiagnostic("unclaimed_control_fact", event.eventId, event.kind));
    }
  }
  restoreInterruptedResults(projected, recoveryFloor, events, eventIndexes);
  return { projected, prefixDiagnostics };
}

/** Only host-generated interruption receipts may cross ordinary user inputs.
 * Work on the read projection, never rewrite durable facts or replay a tool.
 */
function restoreInterruptedResults(
  projected: RuntimeHistoryProjectionEntry[],
  floor: number,
  events: readonly RuntimeEvent[],
  indexes: ReadonlyMap<string, number>,
): void {
  for (let i = floor; i < projected.length; i++) {
    const source = events[indexes.get(projected[i]!.eventId)!]!;
    const calls = projected[i]!.message.toolCalls;
    if (source.kind !== "message.committed" || !calls?.length) continue;
    const pending = new Map(calls.map((call) => [call.id, call]));
    if (pending.size !== calls.length) continue;
    const results: RuntimeHistoryProjectionEntry[] = [];
    const users: RuntimeHistoryProjectionEntry[] = [];
    let end = i + 1;
    for (; end < projected.length && pending.size > 0; end++) {
      const entry = projected[end]!;
      const message = entry.message;
      if (message.role !== "user" || message.toolCalls?.length) break;
      if (message.toolCallId === undefined) {
        users.push(entry);
        continue;
      }
      const result = events[indexes.get(entry.eventId)!]!;
      const call = pending.get(message.toolCallId);
      if (
        !call ||
        result.kind !== "tool.result.recorded" ||
        result.sessionId !== source.sessionId ||
        result.runId !== source.runId ||
        result.turnId !== source.turnId ||
        result.invocationId !== source.invocationId ||
        result.data.toolName !== call.name
      )
        break;
      if (
        users.length > 0 &&
        (result.data.status !== "interrupted" ||
          result.data.projection.mode !== "synthetic" ||
          result.data.projection.strategy !== "runtime-interruption-recovery" ||
          !result.data.recovery ||
          !["not_dispatched", "indeterminate"].includes(result.data.recovery.classification))
      )
        break;
      // Reused provider IDs in different turns are fine; ambiguous batches in
      // the same turn are not evidence for automatic repair.
      if (
        projected.some((candidate, index) => {
          if (index === i || !candidate.message.toolCalls?.some((c) => c.id === call.id))
            return false;
          const other = events[indexes.get(candidate.eventId)!]!;
          return (
            other.sessionId === source.sessionId &&
            other.runId === source.runId &&
            other.turnId === source.turnId
          );
        })
      )
        break;
      pending.delete(call.id);
      results.push(entry);
    }
    if (pending.size === 0 && users.length > 0) {
      projected.splice(i + 1, end - i - 1, ...results, ...users);
      i += results.length;
    }
  }
}

function markUnsafeCompactionBoundaries(
  projected: RuntimeHistoryProjectionEntry[],
  events: readonly RuntimeEvent[],
  indexes: ReadonlyMap<string, number>,
): void {
  // A summary represents its validated covered boundary, not the later sequence
  // at which its wrapper was appended. This also supports rolling checkpoints.
  const boundaries = new Map<string, number>();
  for (const event of events) {
    boundaries.set(
      event.eventId,
      event.kind === "context.checkpoint.recorded"
        ? (boundaries.get(event.data.throughEventId) ?? indexes.get(event.eventId)!)
        : indexes.get(event.eventId)!,
    );
  }
  const positions = projected.map((entry) => boundaries.get(entry.eventId)!);
  const suffixMin = new Array<number>(positions.length + 1).fill(Infinity);
  for (let i = positions.length - 1; i >= 0; i--) {
    suffixMin[i] = Math.min(positions[i]!, suffixMin[i + 1]!);
  }
  let prefixMax = -1;
  for (let i = 0; i < projected.length; i++) {
    prefixMax = Math.max(prefixMax, positions[i]!);
    if (positions[i] !== prefixMax || prefixMax >= suffixMin[i + 1]!) {
      projected[i] = { ...projected[i]!, compactionBoundarySafe: false };
    }
  }
}

function replaceProjectedPrefixWithCheckpoint(
  projected: RuntimeHistoryProjectionEntry[],
  checkpoint: RuntimeCheckpointRecordedEvent,
  eventIndexes: ReadonlyMap<string, number>,
  checkpointEventIndex: number,
): void {
  const throughProjectedIndex = findProjectedEventIndex(
    projected,
    checkpoint.data.throughEventId,
    eventIndexes,
    checkpointEventIndex,
    `Runtime checkpoint ${checkpoint.eventId}`,
  );
  const covered = projected.slice(0, throughProjectedIndex + 1);
  // 内容哈希校验(新格式 v1)或旧格式(eventId 序列哈希)兼容。
  const storedDigest = checkpoint.data.sourceDigest;
  const recomputedDigest = storedDigest.startsWith(CONTENT_DIGEST_V1_PREFIX)
    ? computeCheckpointSourceDigest(covered)
    : createHash("sha256")
        .update(covered.map(({ eventId }) => eventId).join("\n"))
        .digest("hex");
  if (checkpoint.data.coveredEventCount !== covered.length || storedDigest !== recomputedDigest) {
    throw new RuntimeEventReadModelIntegrityError(
      `Runtime checkpoint ${checkpoint.eventId} does not match its covered model prefix`,
    );
  }
  projected.splice(0, throughProjectedIndex + 1, {
    eventId: checkpoint.eventId,
    message: cloneMessage(checkpoint.data.summary),
  });
}

function findProjectedEventIndex(
  projected: readonly RuntimeHistoryProjectionEntry[],
  eventId: string,
  eventIndexes: ReadonlyMap<string, number>,
  currentEventIndex: number,
  referenceKind: string,
): number {
  const projectedIndex = projected.findIndex((entry) => entry.eventId === eventId);
  if (projectedIndex !== -1) return projectedIndex;
  if (eventIndexes.has(eventId) && eventIndexes.get(eventId)! < currentEventIndex) {
    throw new RuntimeEventReadModelIntegrityError(
      `${referenceKind} references event ${eventId}, but it is not in the current model projection`,
    );
  }
  throw new RuntimeEventReadModelIntegrityError(
    `${referenceKind} references an unknown prior event ${eventId}`,
  );
}

function assertToolCallPairing(messages: readonly Message[]): void {
  let pending: Map<string, ToolCall> | undefined;

  for (const [historyIndex, message] of messages.entries()) {
    assertMessageToolFields(message, historyIndex);

    if (pending) {
      if (message.role !== "user" || message.toolCallId === undefined) {
        throw new RuntimeEventReadModelIntegrityError(
          "Assistant tool-call batch is missing one or more consecutive observations",
        );
      }
      if (!pending.delete(message.toolCallId)) {
        throw new RuntimeEventReadModelIntegrityError(
          `Tool result ${message.toolCallId} does not match its preceding tool-call batch`,
        );
      }
      if (pending.size === 0) pending = undefined;
      continue;
    }

    if (message.toolCallId !== undefined) {
      throw new RuntimeEventReadModelIntegrityError(
        `Tool result ${message.toolCallId} has no preceding tool-call batch`,
      );
    }
    if (!message.toolCalls || message.toolCalls.length === 0) continue;

    pending = new Map(message.toolCalls.map((call) => [call.id, call]));
    if (pending.size !== message.toolCalls.length) {
      throw new RuntimeEventReadModelIntegrityError(
        "Assistant tool-call batch contains duplicate call IDs",
      );
    }
  }

  if (pending && pending.size > 0) {
    throw new RuntimeEventReadModelIntegrityError(
      `Assistant tool-call batch is missing results for ${[...pending.keys()].join(", ")}`,
    );
  }
}

function assertMessageToolFields(message: Message, historyIndex: number): void {
  if (message.toolCalls !== undefined) {
    if (message.role !== "assistant") {
      throw new RuntimeEventReadModelIntegrityError(
        `History message ${historyIndex} has tool calls outside an assistant batch`,
      );
    }
    if (!Array.isArray(message.toolCalls) || !message.toolCalls.every(isToolCall)) {
      throw new RuntimeEventReadModelIntegrityError(
        `History message ${historyIndex} has invalid tool calls`,
      );
    }
  }
  if (message.toolCallId !== undefined && !isNonEmptyString(message.toolCallId)) {
    throw new RuntimeEventReadModelIntegrityError(
      `History message ${historyIndex} has an invalid tool result ID`,
    );
  }
  if (message.toolCalls !== undefined && message.toolCallId !== undefined) {
    throw new RuntimeEventReadModelIntegrityError(
      `History message ${historyIndex} cannot contain both tool calls and a tool result`,
    );
  }
}

function cloneMessage(message: Message): Message {
  try {
    return structuredClone(message);
  } catch {
    throw new RuntimeEventReadModelIntegrityError("Runtime message cannot be deep-cloned");
  }
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["name"]) &&
    typeof value["arguments"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
