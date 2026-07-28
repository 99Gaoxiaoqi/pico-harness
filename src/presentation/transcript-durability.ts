import type { Session } from "../engine/session.js";
import { isDurableTranscriptEvent, type DurableTranscriptEvent } from "./transcript-event-store.js";

/** 窄持久化边界：调用方只负责提交已经过策略筛选的语义事件。 */
export interface DurableTranscriptSink {
  append(event: DurableTranscriptEvent): Promise<void>;
}

/**
 * Transcript 的持久化策略是纯函数，避免把 UI 生命周期或 Session 细节
 * 混进 EventStore reducer。流式 delta、phase 和原始工具 stdout/stderr
 * 不落盘；最终 entry/tool/subagent 状态仍可在重启后确定性恢复。
 */
export type TranscriptDurabilityPolicy = (event: DurableTranscriptEvent) => boolean;

export const defaultTranscriptDurabilityPolicy: TranscriptDurabilityPolicy = () => true;

/** Session.recordTranscriptEvent 的适配器，复用同一 RuntimeEvent 写入队列。 */
export function createSessionTranscriptSink(
  session: Pick<Session, "recordTranscriptEvent">,
  options: { readonly eventIdPrefix?: string } = {},
): DurableTranscriptSink {
  const prefix = options.eventIdPrefix ?? "tui:transcript:";
  return {
    append: (event) =>
      session.recordTranscriptEvent(event, { eventId: `${prefix}${event.eventId}` }).then(() => {
        // recordTranscriptEvent 的返回值属于持久化层，UI sink 不向上泄漏它。
      }),
  };
}

export { isDurableTranscriptEvent };
