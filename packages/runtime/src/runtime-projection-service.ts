import type {
  Message,
  DurableTranscriptEvent,
  RuntimeEvent,
  SessionRuntimeStateSnapshot,
  SessionUsageSnapshot,
} from "@pico/core";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
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

type DurableRuntimeEvent = RuntimeEvent<DurableTranscriptEvent>;
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

/** 统一投影视图：直接复用 read-model 的 RuntimeHistoryProjection 类型。 */
export type SessionView = RuntimeHistoryProjection;

/** getMessages 的 checkpoint 行为开关。默认 true，与 Runtime 真源一致。 */
export interface GetMessagesOptions {
  /** true 时处理 checkpoint；false 时返回未经 checkpoint 替换的 model 事实。 */
  readonly checkpoint?: boolean;
}

/**
 * 从 RuntimeEventStore 重算 Session 的各种读取视图。
 *
 * 这是纯包装服务：它只按投影实际消费的 kind 读取事件，再委托纯投影函数；
 * 不写入事实、不持有宿主状态，也不参与实时 provider callback。
 */
export class RuntimeProjectionService {
  constructor(private readonly store: SqliteRuntimeEventStore) {}

  /** 完整 Session 视图，保留全量控制事实的软诊断。 */
  async getSessionView(sessionId: string): Promise<SessionView> {
    const events = await this.store.readSession(sessionId);
    return materializeRuntimeHistoryProjection(events);
  }

  /** 默认使用 checkpoint 视图；传 false 可查看原始 model 历史事实。 */
  async getMessages(sessionId: string, options?: GetMessagesOptions): Promise<Message[]> {
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

  /** 带 eventId 的 checkpoint 消息视图。 */
  async getMessageEntries(sessionId: string): Promise<RuntimeHistoryProjectionEntry[]> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_HISTORY_EVENT_KINDS);
    return materializeRuntimeHistoryEntries(events);
  }

  /** Session 运行时状态投影（settings / goal / promptCache + usage）。 */
  async getState(sessionId: string): Promise<SessionRuntimeStateSnapshot> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_SESSION_STATE_EVENT_KINDS);
    return projectRuntimeSessionState(events);
  }

  /** Session 用量快照投影（token / cost / cache 统计）。 */
  async getUsage(sessionId: string): Promise<SessionUsageSnapshot> {
    const events = await this.readEventsOfKinds(sessionId, RUNTIME_SESSION_USAGE_EVENT_KINDS);
    return projectRuntimeSessionUsage(events);
  }

  /** Transcript 事件投影（保留源 sequence）。 */
  async getTranscriptEntries(sessionId: string): Promise<RuntimeSessionTranscriptEventEntry[]> {
    const entries = await this.readSequencedEntries(
      sessionId,
      RUNTIME_SESSION_TRANSCRIPT_EVENT_KINDS,
    );
    return projectRuntimeSessionTranscriptEventEntries(entries);
  }

  /** 带 sequence / runId / turnId 的 model 消息条目投影。 */
  async getSequencedMessages(sessionId: string): Promise<RuntimeSessionSequencedMessageEntry[]> {
    const entries = await this.readSequencedEntries(sessionId, RUNTIME_MODEL_MESSAGE_EVENT_KINDS);
    return projectRuntimeSessionSequencedMessageEntries(entries);
  }

  /** Fork seed 投影，按 Runtime ledger 的原始顺序混合 model 与 transcript 事实。 */
  async getForkSeed(sessionId: string): Promise<RuntimeSessionForkSeedEntry[]> {
    const entries = await this.readSequencedEntries(
      sessionId,
      RUNTIME_SESSION_FORK_SEED_EVENT_KINDS,
    );
    return projectRuntimeSessionForkSeedEntries(entries);
  }

  private async readEventsOfKinds(
    sessionId: string,
    kinds: readonly string[],
  ): Promise<DurableRuntimeEvent[]> {
    const { entries } = await this.store.readSessionEntriesOfKinds(sessionId, kinds);
    return entries.map(({ event }) => event);
  }

  private async readSequencedEntries(
    sessionId: string,
    kinds: readonly string[],
  ): Promise<readonly SequencedRuntimeEvent[]> {
    return this.store.readSessionEntriesOfKinds(sessionId, kinds).then(({ entries }) => entries);
  }
}
