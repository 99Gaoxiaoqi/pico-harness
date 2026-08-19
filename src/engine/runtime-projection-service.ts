import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type { Message } from "../schema/message.js";
import type { RuntimeEvent } from "./session-runtime-event.js";
import type {
  RuntimeHistoryProjection,
  RuntimeHistoryProjectionEntry,
} from "./session-runtime-read-model.js";
import {
  RUNTIME_HISTORY_EVENT_KINDS,
  RUNTIME_MODEL_MESSAGE_EVENT_KINDS,
  materializeRuntimeHistory,
  materializeRuntimeHistoryEntries,
  materializeRuntimeHistoryProjection,
} from "./session-runtime-read-model.js";
import type {
  RuntimeSessionForkSeedEntry,
  RuntimeSessionSequencedMessageEntry,
  RuntimeSessionTranscriptEventEntry,
  SequencedRuntimeEvent,
} from "./session-runtime-projection.js";
import {
  RUNTIME_SESSION_FORK_SEED_EVENT_KINDS,
  RUNTIME_SESSION_STATE_EVENT_KINDS,
  RUNTIME_SESSION_TRANSCRIPT_EVENT_KINDS,
  RUNTIME_SESSION_USAGE_EVENT_KINDS,
  projectRuntimeSessionForkSeedEntries,
  projectRuntimeSessionMessages,
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionTranscriptEventEntries,
  projectRuntimeSessionUsage,
} from "./session-runtime-projection.js";
import type { SessionRuntimeStateSnapshot } from "./session-runtime.js";
import type { SessionUsageSnapshot } from "./session-runtime.js";

/**
 * 统一投影视图：直接复用 read-model 的 RuntimeHistoryProjection 类型，不新造类型。
 *
 * 含 entries + 结构化诊断（hard 诊断在 materializeRuntimeHistoryProjection 内已 throw，
 * soft 诊断收集到 diagnostics）。Service 各方法的返回类型也一律复用现有类型。
 */
export type SessionView = RuntimeHistoryProjection;

/** getMessages 的 checkpoint 行为开关。默认 true，与 Runtime 真源一致。 */
export interface GetMessagesOptions {
  /**
   * true（默认）：通过 materializeRuntimeHistory 投影，处理 context.checkpoint.recorded
   * 替换、rewound 截断与 toolCall 配对校验——与 Runtime 真源看到的视图完全一致。
   *
   * false：通过 projectRuntimeSessionMessages 投影 raw branch facts，不做 checkpoint
   * 替换——用于需要查看未压缩的 model 消息序列的诊断场景。
   */
  readonly checkpoint?: boolean;
}

/**
 * 统一投影入口：从 RuntimeEventStore 重算 session 的各种视图。
 *
 * Pico 历史上有两套分裂的投影模块：
 * - {@link session-runtime-read-model} —— 含 checkpoint 替换 + fail-closed 诊断（read-model）
 * - {@link session-runtime-projection} —— 无 checkpoint，含 sequenced / transcript / fork /
 *   toolResult / state / usage
 *
 * 本 service 封装这两套投影，消除调用方的选型困惑。新调用方应优先使用本 service，
 * 而不是直接引用底层投影函数。底层投影函数的导出保持不变，仅作为 service 的实现细节。
 *
 * 纯包装契约：本 service 不改变任何投影语义，每个方法仅做两件事：
 *   1. 按该投影实际消费的 kind 集做切片查询（票 04：替代 readSession 全量读，
 *      折叠函数不动，只换数据来源 = 按 kind+seq 排序的事件子集）
 *   2. 调用对应底层投影函数并原样返回结果
 *
 * 不在本 service 范围内的路径：
 * - streaming delta 路径（`RuntimeEventStore.readSessionProjectionDelta` +
 *   `applyRuntimeHistoryProjectionDelta`）—— 那是性能旁路，保留增量语义，仍由调用方自行使用。
 * - 实时流式 provider callback —— 不经过事件存储重算，由 Runtime 流式管线直接处理。
 */
export class RuntimeProjectionService {
  constructor(private readonly store: SqliteRuntimeEventStore) {}

  /**
   * 主投影入口：从 RuntimeEvent 重算完整 session 视图。
   * 含 checkpoint 替换 + fail-closed 诊断。
   *
   * 等价于：materializeRuntimeHistoryProjection(await store.readSession(sessionId))。
   *
   * 票 04 注:本方法保持显式全量读——它的返回值含 soft 诊断(unclaimed
   * control fact 覆盖全部控制 kind),kind 切片会改变可观测输出;诊断与
   * entries 的全量口径以 readSession 为准。
   */
  async getSessionView(sessionId: string): Promise<SessionView> {
    const events = await this.store.readSession(sessionId);
    return materializeRuntimeHistoryProjection(events);
  }

  /**
   * 纯消息投影。默认处理 checkpoint（与 Runtime 真源一致）。
   * 传 { checkpoint: false } 可获得 raw branch facts 视图（不做 checkpoint 替换）。
   *
   * 等价于：
   * - checkpoint 默认/true: materializeRuntimeHistory(events)
   * - checkpoint === false: projectRuntimeSessionMessages(events)
   */
  async getMessages(
    sessionId: string,
    options?: GetMessagesOptions,
  ): Promise<Message[]> {
    const events = await this.readEventsOfKinds(
      sessionId,
      options?.checkpoint === false
        ? RUNTIME_MODEL_MESSAGE_EVENT_KINDS
        : RUNTIME_HISTORY_EVENT_KINDS,
    );
    if (options?.checkpoint === false) {
      return projectRuntimeSessionMessages(events);
    }
    return materializeRuntimeHistory(events);
  }

  /**
   * 带 eventId 的消息条目投影（含 checkpoint 替换）。
   *
   * 等价于：materializeRuntimeHistoryEntries(events)。
   */
  async getMessageEntries(
    sessionId: string,
  ): Promise<RuntimeHistoryProjectionEntry[]> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_HISTORY_EVENT_KINDS);
    return materializeRuntimeHistoryEntries(events);
  }

  /**
   * Session 运行时状态投影（settings / goal / promptCache + usage）。
   *
   * 等价于：projectRuntimeSessionState(events)。
   */
  async getState(sessionId: string): Promise<SessionRuntimeStateSnapshot> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_SESSION_STATE_EVENT_KINDS);
    return projectRuntimeSessionState(events);
  }

  /**
   * Session 用量快照投影（token / cost / cache 统计）。
   *
   * 等价于：projectRuntimeSessionUsage(events)。
   */
  async getUsage(sessionId: string): Promise<SessionUsageSnapshot> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_SESSION_USAGE_EVENT_KINDS);
    return projectRuntimeSessionUsage(events);
  }

  /**
   * Transcript 事件投影（DurableTranscriptEvent 序列，保留 sequence）。
   *
   * 等价于：projectRuntimeSessionTranscriptEventEntries(entries)。
   */
  async getTranscriptEntries(
    sessionId: string,
  ): Promise<RuntimeSessionTranscriptEventEntry[]> {
    const entries = await this.readSequencedEntries(
      sessionId,
      RUNTIME_SESSION_TRANSCRIPT_EVENT_KINDS,
    );
    return projectRuntimeSessionTranscriptEventEntries(entries);
  }

  /**
   * 带 sequence / runId / turnId 的 model 消息条目投影。
   *
   * 等价于：projectRuntimeSessionSequencedMessageEntries(entries)。
   */
  async getSequencedMessages(
    sessionId: string,
  ): Promise<RuntimeSessionSequencedMessageEntry[]> {
    const entries = await this.readSequencedEntries(sessionId, RUNTIME_MODEL_MESSAGE_EVENT_KINDS);
    return projectRuntimeSessionSequencedMessageEntries(entries);
  }

  /**
   * Fork seed 投影：model + transcript 事实按源 ledger 顺序混合排序。
   * 用于跨 session fork 时保留相对顺序。
   *
   * 等价于：projectRuntimeSessionForkSeedEntries(entries)。
   */
  async getForkSeed(sessionId: string): Promise<RuntimeSessionForkSeedEntry[]> {
    const entries = await this.readSequencedEntries(
      sessionId,
      RUNTIME_SESSION_FORK_SEED_EVENT_KINDS,
    );
    return projectRuntimeSessionForkSeedEntries(entries);
  }

  /**
   * 按 kind 子集读取事件（票 04 切片查询），映射为 RuntimeEvent 数组。
   */
  private async readEventsOfKinds(
    sessionId: string,
    kinds: readonly string[],
  ): Promise<RuntimeEvent[]> {
    const { entries } = await this.store.readSessionEntriesOfKinds(sessionId, kinds);
    return entries.map(({ event }) => event);
  }

  /**
   * 按 kind 子集读取并按 RuntimeEventStoreEntry → SequencedRuntimeEvent 结构映射。
   *
   * 两种类型结构同构（都只含 `{ sequence: number; event: RuntimeEvent }`），
   * 这里仅做 readonly 化转换，避免在调用方暴露结构同构这一实现细节。
   */
  private async readSequencedEntries(
    sessionId: string,
    kinds: readonly string[],
  ): Promise<readonly SequencedRuntimeEvent[]> {
    return this.store.readSessionEntriesOfKinds(sessionId, kinds).then(
      ({ entries }) => entries,
    );
  }
}
