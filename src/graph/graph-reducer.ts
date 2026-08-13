import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import {
  GraphConflictError,
  type GraphProjection,
  type GraphRecord,
  type GraphStatus,
  type GraphWork,
  type GraphWorkStatus,
} from "./contract.js";

/**
 * Graph Mode 事件流的 kind 注册表（单源）。graph.* 事件已正式注册进
 * {@link RuntimeEvent} 判别联合与 RUNTIME_EVENT_KINDS（storage 通过
 * `...GRAPH_EVENT_KINDS` spread 引用本表，勿在两处手写同步）。
 */
export const GRAPH_EVENT_KINDS = [
  "graph.work.added",
  "graph.work.dispatched",
  "graph.work.recorded",
  "graph.work.failed",
  "graph.closed",
] as const;

export type GraphEventKind = (typeof GRAPH_EVENT_KINDS)[number];

interface GraphEventBase {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly graphId: string;
}

interface GraphWorkAddedEventData extends GraphEventBase {
  readonly workId: string;
  readonly instruction: string;
  readonly inputIds: readonly string[];
  readonly mode: "explore" | "worker";
}

interface GraphWorkDispatchedEventData extends GraphEventBase {
  readonly workId: string;
  readonly delegationId: string;
}

interface GraphWorkRecordedEventData extends GraphEventBase {
  readonly workId: string;
  readonly recordId: string;
  readonly outputSummary: string;
  readonly evidenceRefs?: readonly string[];
}

interface GraphWorkFailedEventData extends GraphEventBase {
  readonly workId: string;
  readonly error: string;
}

interface GraphClosedEventData extends GraphEventBase {
  readonly resultRecordIds?: readonly string[];
}

export interface GraphWorkAddedEvent {
  readonly kind: "graph.work.added";
  readonly data: GraphWorkAddedEventData;
}
export interface GraphWorkDispatchedEvent {
  readonly kind: "graph.work.dispatched";
  readonly data: GraphWorkDispatchedEventData;
}
export interface GraphWorkRecordedEvent {
  readonly kind: "graph.work.recorded";
  readonly data: GraphWorkRecordedEventData;
}
export interface GraphWorkFailedEvent {
  readonly kind: "graph.work.failed";
  readonly data: GraphWorkFailedEventData;
}
export interface GraphClosedEvent {
  readonly kind: "graph.closed";
  readonly data: GraphClosedEventData;
}

export type GraphEvent =
  | GraphWorkAddedEvent
  | GraphWorkDispatchedEvent
  | GraphWorkRecordedEvent
  | GraphWorkFailedEvent
  | GraphClosedEvent;

export function isGraphEventKind(kind: string): kind is GraphEventKind {
  return (GRAPH_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * 将 kind 已确认为 graph.* 的 RuntimeEvent 窄化为 GraphEvent 视图。
 * RuntimeEvent 的 graph 分支（RuntimeGraphEvent）与 GraphEvent 结构兼容
 * （data 字段一致，仅多出事件基类字段），按判别联合 kind 窄化后可直接
 * 返回，无需强转。调用方必须先通过 isGraphEventKind 过滤。
 */
function asGraphEvent(event: RuntimeEvent): GraphEvent {
  switch (event.kind) {
    case "graph.work.added":
    case "graph.work.dispatched":
    case "graph.work.recorded":
    case "graph.work.failed":
    case "graph.closed":
      return event;
    default:
      // 不可达：isGraphEventKind 已过滤；此分支仅为满足 TS 穷尽性。
      throw new Error(`Unexpected graph event kind: ${String(event.kind)}`);
  }
}

function findWork(state: GraphProjection, workId: string): GraphWork | undefined {
  return state.works.find((work) => work.workId === workId);
}

function replaceWork(state: GraphProjection, workId: string, next: GraphWork): GraphProjection {
  return {
    ...state,
    works: state.works.map((work) => (work.workId === workId ? next : work)),
  };
}

export function reduceGraphEvent(state: GraphProjection, event: RuntimeEvent): GraphProjection {
  if (!isGraphEventKind(event.kind)) return state;
  const graphEvent = asGraphEvent(event);
  if (graphEvent.data.graphId !== state.graphId) return state;

  switch (graphEvent.kind) {
    case "graph.work.added": {
      const { workId, instruction, inputIds, mode } = graphEvent.data;
      // Defense-in-depth: AddWorkTool rejects declarations on a closed graph,
      // but the event store does no semantic validation. Ignore any added
      // event that lands on a non-active projection (e.g. a recover/replay
      // ordering quirk) rather than corrupting the projection — the work would
      // never be dispatched on a closed graph anyway. Compare graph.closed,
      // which guards the same way.
      if (state.status !== "active") return state;
      if (findWork(state, workId)) return state; // idempotent replay
      const work: GraphWork = {
        workId,
        instruction,
        inputIds: [...inputIds],
        mode,
        status: "requested",
      };
      return { ...state, works: [...state.works, work] };
    }
    case "graph.work.dispatched": {
      const { workId, delegationId } = graphEvent.data;
      const work = findWork(state, workId);
      if (!work) conflict(`Cannot dispatch unknown work: ${workId}`);
      if (work.status !== "requested" && work.status !== "dispatched") {
        conflict(`Cannot dispatch work in status ${work.status}: ${workId}`);
      }
      return replaceWork(state, workId, {
        ...work,
        status: "dispatched",
        delegationId,
      });
    }
    case "graph.work.recorded": {
      const { workId, recordId, outputSummary, evidenceRefs } = graphEvent.data;
      const work = findWork(state, workId);
      if (!work) conflict(`Cannot record unknown work: ${workId}`);
      const record: GraphRecord = {
        recordId,
        workId,
        outputSummary,
        ...(evidenceRefs ? { evidenceRefs: [...evidenceRefs] } : {}),
      };
      const existingRecord = state.records.find((entry) => entry.recordId === recordId);
      const records = existingRecord
        ? state.records.map((entry) => (entry.recordId === recordId ? record : entry))
        : [...state.records, record];
      const nextStatus: GraphWorkStatus = "recorded";
      return {
        ...replaceWork(state, workId, {
          ...work,
          status: nextStatus,
          recordId,
        }),
        records,
      };
    }
    case "graph.work.failed": {
      const { workId } = graphEvent.data;
      const work = findWork(state, workId);
      if (!work) conflict(`Cannot fail unknown work: ${workId}`);
      return replaceWork(state, workId, { ...work, status: "failed" });
    }
    case "graph.closed": {
      if (state.status !== "active") return state;
      return { ...state, status: "closed" satisfies GraphStatus };
    }
    default: {
      return state;
    }
  }
}

function conflict(message: string): never {
  throw new GraphConflictError(message);
}

/**
 * Folds the graph.* event slice of one session into a {@link GraphProjection}.
 * The graphId is supplied by the caller (it is the active graph handle for the
 * session). Entries belonging to other graphs are ignored.
 */
export function projectGraphEntries(
  graphId: string,
  entries: readonly RuntimeEventStoreEntry[],
): GraphProjection {
  let state: GraphProjection = {
    graphId,
    sessionSequence: entries.at(-1)?.sequence ?? 0,
    works: [],
    records: [],
    status: "active",
  };
  for (const entry of entries) {
    if (!isGraphEventKind(entry.event.kind)) continue;
    state = reduceGraphEvent(state, entry.event);
  }
  return state;
}
