import type { Message } from "../schema/message.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  createEmptyUsageSnapshot,
  SESSION_RUNTIME_STATE_VERSION,
  type SessionRuntimeStateSnapshot,
} from "./session-runtime.js";
import type { LegacySessionRecord, SessionEvent, SessionRecord } from "./session-store.js";

/**
 * Session JSONL 的唯一重放结果。读取侧只依赖该结构，
 * 避免 Session、会话列表和后续投影各自演化一套 reducer。
 */
export interface SessionReplayState {
  readonly history: Message[];
  readonly historySequences: readonly number[];
  readonly transcriptEvents: readonly TranscriptEvent[];
  readonly transcriptEventSequences: readonly number[];
  readonly runtime: SessionRuntimeStateSnapshot;
  readonly maxSeq: number;
  readonly epoch: number;
}

export function replaySessionRecords(records: readonly SessionRecord[]): SessionReplayState {
  const ordered = [...records]
    .filter((record) => record.type !== "meta")
    .sort((a, b) => a.seq - b.seq);
  let state: MutableReplayState = {
    history: [],
    historySequences: [],
    transcriptEvents: [],
    transcriptEventSequences: [],
    runtime: {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      usage: createEmptyUsageSnapshot(),
    },
    maxSeq: -1,
    epoch: 0,
  };

  for (const record of ordered) {
    const event = record.type === "event" ? record : adaptLegacySessionRecord(record, state.epoch);
    state = applySessionEvent(state, event);
  }

  return {
    history: structuredClone(state.history),
    historySequences: [...state.historySequences],
    transcriptEvents: structuredClone(state.transcriptEvents),
    transcriptEventSequences: [...state.transcriptEventSequences],
    runtime: structuredClone(state.runtime),
    maxSeq: state.maxSeq,
    epoch: state.epoch,
  };
}

/**
 * v0-v2 记录的冻结 adapter。该转换是纯函数，不依赖当前时间或
 * Session 实例，因而旧日志在未来版本中仍会得到相同结果。
 */
export function adaptLegacySessionRecord(
  record: LegacySessionRecord,
  currentEpoch: number,
): SessionEvent {
  const rewrite =
    record.type === "truncate" || record.type === "undo" || record.type === "rewind_to";
  const epoch = rewrite ? currentEpoch + 1 : currentEpoch;
  const base = {
    type: "event" as const,
    recordVersion: 1 as const,
    eventId: `legacy:${record.seq}:${record.type}`,
    seq: record.seq,
    epoch,
    at: "at" in record ? record.at : "1970-01-01T00:00:00.000Z",
  };

  switch (record.type) {
    case "message":
      return {
        ...base,
        kind: "message.appended",
        data: {
          message: structuredClone(record.message),
          ...(record.volatile === true ? { volatile: true } : {}),
        },
      };
    case "truncate":
      return { ...base, kind: "history.truncated", data: { fromIndex: record.fromIndex } };
    case "undo":
      return { ...base, kind: "legacy.undo", data: { count: record.count } };
    case "rewind_to":
      return {
        ...base,
        kind: "history.rewound",
        data: { messageIndex: record.messageIndex },
      };
    case "runtime_state":
      return {
        ...base,
        kind: "runtime.checkpoint",
        data: {
          stateVersion: record.stateVersion,
          patch: structuredClone(record.patch),
        },
      };
  }
}

/** 旧 undo 的历史语义：跳过 system，且不跨越 compaction summary。 */
export function findLegacyUndoCut(
  history: readonly Message[],
  count: number,
): { cutIndex: number; removedCount: number } {
  if (count <= 0) return { cutIndex: history.length, removedCount: 0 };
  let removedCount = 0;
  let cutIndex = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (isCompactionSummaryMessage(message)) {
      return { cutIndex: index + 1, removedCount };
    }
    if (message.role === "system") continue;
    if (message.role !== "user") continue;
    removedCount++;
    if (removedCount === count) {
      cutIndex = index;
      break;
    }
  }
  return { cutIndex, removedCount };
}

interface MutableReplayState {
  history: Message[];
  historySequences: number[];
  transcriptEvents: TranscriptEvent[];
  transcriptEventSequences: number[];
  runtime: SessionRuntimeStateSnapshot;
  maxSeq: number;
  epoch: number;
}

function applySessionEvent(state: MutableReplayState, event: SessionEvent): MutableReplayState {
  let history = state.history;
  let historySequences = state.historySequences;
  let transcriptEvents = state.transcriptEvents;
  let transcriptEventSequences = state.transcriptEventSequences;
  let runtime = state.runtime;
  switch (event.kind) {
    case "message.appended":
      if (event.data.volatile !== true) {
        history = [...history, structuredClone(event.data.message)];
        historySequences = [...historySequences, event.seq];
      }
      break;
    case "history.truncated":
      history = history.slice(event.data.fromIndex);
      historySequences = historySequences.slice(event.data.fromIndex);
      break;
    case "history.rewound": {
      const cutoffSequence = historySequences[event.data.messageIndex - 1];
      history = history.slice(0, event.data.messageIndex);
      historySequences = historySequences.slice(0, event.data.messageIndex);
      ({ transcriptEvents, transcriptEventSequences } = retainTranscriptThroughSequence(
        transcriptEvents,
        transcriptEventSequences,
        cutoffSequence,
      ));
      break;
    }
    case "history.compacted": {
      const retainedSequences =
        event.data.retainedMessages.length === 0
          ? []
          : historySequences.slice(-event.data.retainedMessages.length);
      history = [
        structuredClone(event.data.summaryMessage),
        ...structuredClone(event.data.retainedMessages),
      ];
      historySequences = [
        retainedSequences.length > 0 ? retainedSequences[0]! - 0.5 : event.seq,
        ...retainedSequences,
      ];
      break;
    }
    case "legacy.undo": {
      const { cutIndex, removedCount } = findLegacyUndoCut(history, event.data.count);
      if (removedCount > 0) {
        const cutoffSequence = historySequences[cutIndex - 1];
        history = history.slice(0, cutIndex);
        historySequences = historySequences.slice(0, cutIndex);
        ({ transcriptEvents, transcriptEventSequences } = retainTranscriptThroughSequence(
          transcriptEvents,
          transcriptEventSequences,
          cutoffSequence,
        ));
      }
      break;
    }
    case "runtime.checkpoint":
      runtime = {
        ...runtime,
        ...(event.data.patch.settings
          ? { settings: structuredClone(event.data.patch.settings) }
          : {}),
        ...(event.data.patch.goal ? { goal: structuredClone(event.data.patch.goal) } : {}),
        ...(event.data.patch.usage ? { usage: structuredClone(event.data.patch.usage) } : {}),
      };
      break;
    case "session.seeded":
      history = [...structuredClone(event.data.messages)];
      historySequences = event.data.messages.map(() => event.seq);
      break;
    case "transcript.event.recorded":
      transcriptEvents = [...transcriptEvents, structuredClone(event.data.event)];
      transcriptEventSequences = [...transcriptEventSequences, event.seq];
      break;
  }
  return {
    history,
    historySequences,
    transcriptEvents,
    transcriptEventSequences,
    runtime,
    maxSeq: Math.max(state.maxSeq, event.seq),
    epoch: Math.max(state.epoch, event.epoch),
  };
}

function retainTranscriptThroughSequence(
  events: readonly TranscriptEvent[],
  sequences: readonly number[],
  cutoffSequence: number | undefined,
): { transcriptEvents: TranscriptEvent[]; transcriptEventSequences: number[] } {
  if (cutoffSequence === undefined) {
    return { transcriptEvents: [], transcriptEventSequences: [] };
  }
  const transcriptEvents: TranscriptEvent[] = [];
  const transcriptEventSequences: number[] = [];
  sequences.forEach((sequence, index) => {
    if (sequence > cutoffSequence) return;
    const event = events[index];
    if (!event) return;
    transcriptEvents.push(event);
    transcriptEventSequences.push(sequence);
  });
  return { transcriptEvents, transcriptEventSequences };
}

function isCompactionSummaryMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  const marker = message.providerData?.["picoKind"];
  return (
    marker === "compaction_summary" ||
    message.content.startsWith("[上下文压缩") ||
    message.content.includes("--- 历史摘要结束")
  );
}
