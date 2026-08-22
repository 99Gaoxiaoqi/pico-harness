import { createHash, randomUUID } from "node:crypto";
import {
  GraphConflictError,
  normalizeGraphWorkInput,
  recordIdFor,
  workIdFor,
  type GraphProjection,
  type GraphWork,
} from "../graph/contract.js";
import {
  computeReadyWorks,
  hasPendingWorks,
  missingInputIdsFor,
} from "../graph/graph-reconcile.js";
import { GRAPH_EVENT_KINDS, projectGraphEntries } from "../graph/graph-reducer.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../engine/session-runtime-event.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import type { EngineRuntimeWriteGuard } from "../engine/runtime-port.js";
import type { RuntimeOwnerFence } from "../storage/runtime-event-store-contracts.js";

/**
 * Stable content fingerprint for a graph operation. Mirrors
 * {@link planOperationFingerprint}: identical semantic inputs must hash to the
 * same digest so the store's CAS envelope can deduplicate replays.
 */
export function graphOperationFingerprint(kind: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ kind, input })).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Context shared by all three Graph Mode tools for one active graph. */
export interface GraphToolContext {
  readonly store: SqliteRuntimeEventStore;
  readonly sessionId: string;
  readonly graphId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly writeGuard?: EngineRuntimeWriteGuard;
}

async function appendGraphOperation(
  context: GraphToolContext,
  events: readonly RuntimeEvent[],
  operation: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly expectedSessionSequence: number;
  },
): Promise<void> {
  const ownerFence = context.writeGuard
    ? await context.writeGuard.assertRuntimeEventWriteAllowed()
    : undefined;
  await context.store.appendGraphOperation(events, {
    ...operation,
    ...(ownerFence ? { ownerFence } : {}),
  });
  if (!ownerFence || !context.writeGuard) return;
  await confirmGraphOwnerFence(context, ownerFence);
}

async function confirmGraphOwnerFence(
  context: GraphToolContext,
  expected: RuntimeOwnerFence,
): Promise<void> {
  const actual = await context.writeGuard!.assertRuntimeEventWriteAllowed();
  if (actual.sessionId !== expected.sessionId || actual.epoch !== expected.epoch) {
    throw new Error(`Graph owner fence changed during Session ${context.sessionId} write`);
  }
}

/**
 * Host-supplied dispatch callback. The orchestrator (agent-runtime) implements
 * this to spawn a delegation backing the graph work; AddWorkTool never owns the
 * runner so it cannot accidentally couple event writes to engine internals.
 *
 * Returns the delegationId minted by DelegationManager, or undefined when the
 * host declined to dispatch (e.g. capacity exhausted).
 */
export type GraphWorkDispatcher = (input: {
  readonly workId: string;
  readonly instruction: string;
  readonly mode: "explore" | "worker";
}) => Promise<string | undefined>;

/**
 * Builds the durable envelope shared by every graph event. The host supplies
 * invocation/run/turn metadata so events remain consistent with the active
 * RuntimeRun; the store asserts these are stable on append.
 */
function graphBaseEvent(
  context: GraphToolContext,
  operationId: string,
  suffix: string,
  at: string,
) {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: `graph:${operationId}:${suffix}`,
    sessionId: context.sessionId,
    invocationId: context.invocationId,
    runId: context.runId,
    turnId: context.turnId,
    at,
    partial: false as const,
    visibility: "internal" as const,
  };
}

async function readGraphProjection(context: GraphToolContext): Promise<GraphProjection> {
  // graph.* 事件切片 + 全会话水位(票 04):折叠输入只含 graph 事件。
  const slice = await context.store.readSessionEntriesOfKinds(context.sessionId, GRAPH_EVENT_KINDS);
  return projectGraphEntries(context.graphId, slice.entries, slice.headSequence);
}

/**
 * add_work: declares a new unit of graph work. If the declared inputs are
 * already satisfied by committed records the tool immediately attempts to
 * dispatch via the injected {@link GraphWorkDispatcher}; otherwise the work
 * stays "requested" and waits for its upstream producers to settle.
 *
 * The tool only writes graph.work.added and (on success) graph.work.dispatched;
 * the recorded/failed transitions are owned by the settle callback when the
 * backing delegation terminates.
 */
export class AddWorkTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(
    private readonly context: GraphToolContext,
    private readonly dispatchWork: GraphWorkDispatcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  name(): string {
    return "add_work";
  }

  definition(): ToolDefinition {
    return {
      name: "add_work",
      description:
        "声明一个新的 Graph Mode 工作单元。当声明的输入记录都已就绪时立即派发子代理执行；否则保持等待直到上游产出记录。",
      inputSchema: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "该工作单元的自然语言目标，作为子代理的 goal。",
          },
          input_ids: {
            type: "array",
            items: { type: "string" },
            description: "上游工作产出记录的 recordId 列表；全部就绪后才会派发。",
          },
          mode: {
            type: "string",
            enum: ["explore", "worker"],
            description: "子代理模式；默认 explore。",
          },
          operationId: { type: "string" },
        },
        required: ["instruction"],
      },
    };
  }

  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const parsed = parseAddWorkArgs(args);
    const normalized = normalizeGraphWorkInput(parsed);
    const workId = workIdFor(this.context.graphId, normalized.instruction, normalized.inputIds);

    // CAS envelope: the operationId binds added + (optional) dispatched into
    // one exactly-once transition. Replay is safe: the reducer is idempotent.
    const operationId = parsed.operationId ?? `add-work:${workId}:${randomUUID()}`;
    const before = await readGraphProjection(this.context);
    // Reject declaration on a closed graph. Maka enforces the same invariant at
    // the schedule-store layer (AgentGraphScheduleUpdateConflictError once the
    // graph is finished). Pico enforces it at the tool layer because its event
    // store does no semantic validation; the reducer additionally ignores
    // added events on a non-active projection as defense-in-depth.
    if (before.status === "closed") {
      throw new GraphConflictError(
        "Graph 已关闭，close_graph 之后不允许再 add_work。如需继续工作请新建会话或 fork。",
      );
    }
    const existing = before.works.find((work) => work.workId === workId);
    const alreadyDispatched = existing?.status === "dispatched" || existing?.status === "recorded";

    if (!existing) {
      const fingerprint = graphOperationFingerprint("graph.work.added", {
        graphId: this.context.graphId,
        workId,
        instruction: normalized.instruction,
        inputIds: normalized.inputIds,
        mode: normalized.mode,
      });
      const at = this.now().toISOString();
      const addedEvent: RuntimeEvent = {
        ...graphBaseEvent(this.context, operationId, "added", at),
        kind: "graph.work.added",
        data: {
          operationId,
          fingerprint,
          graphId: this.context.graphId,
          workId,
          instruction: normalized.instruction,
          inputIds: [...normalized.inputIds],
          mode: normalized.mode,
        },
      };
      await appendGraphOperation(this.context, [addedEvent], {
        operationId,
        fingerprint,
        expectedSessionSequence: before.sessionSequence,
      });
    }

    context?.signal?.throwIfAborted();
    // The reducer may now see the work as ready (if inputs are already
    // committed) or still waiting. Attempt dispatch only when inputs hold.
    const after = await readGraphProjection(this.context);
    const ready = computeReadyWorks(after).find((work) => work.workId === workId);
    if (!ready || alreadyDispatched) {
      const waitingWork = after.works.find((work) => work.workId === workId);
      // If the work already progressed past "requested" (dispatched/recorded/
      // failed), report its real status. A bare "waiting" here misleads a model
      // that re-declares an in-flight or settled work into thinking nothing was
      // scheduled — it may re-declare under a different wording (new workId) and
      // duplicate the labour, or burn turns on view_graph to disambiguate.
      if (
        waitingWork &&
        (waitingWork.status === "dispatched" ||
          waitingWork.status === "recorded" ||
          waitingWork.status === "failed")
      ) {
        return JSON.stringify({
          workId,
          status: waitingWork.status,
          ...(waitingWork.delegationId ? { delegationId: waitingWork.delegationId } : {}),
          ...(waitingWork.recordId ? { recordId: waitingWork.recordId } : {}),
          graphId: this.context.graphId,
        });
      }
      const missingInputIds = waitingWork ? missingInputIdsFor(after, waitingWork) : [];
      return JSON.stringify({
        workId,
        status: ready ? "ready" : "waiting",
        ...(missingInputIds.length > 0
          ? {
              missingInputIds,
              hint: "input_ids 引用了尚未产出的 recordId。若引用的是 workId 或已失败的上游，该工作将永远不会就绪；用 view_graph 核对 recordId 后再声明。",
            }
          : {}),
        graphId: this.context.graphId,
      });
    }

    const delegationId = await this.dispatchWork({
      workId,
      instruction: ready.instruction,
      mode: ready.mode,
    });
    if (!delegationId) {
      return JSON.stringify({
        workId,
        status: "ready",
        graphId: this.context.graphId,
        dispatched: false,
      });
    }

    // Record the dispatch as its own CAS transition. Two concurrent add_work
    // calls for the same workId deduplicate at the added step; the first to
    // win the dispatched CAS owns the delegation binding.
    const dispatchOperationId = `dispatch-work:${workId}:${randomUUID()}`;
    const dispatchFingerprint = graphOperationFingerprint("graph.work.dispatched", {
      graphId: this.context.graphId,
      workId,
      delegationId,
    });
    const refreshed = await readGraphProjection(this.context);
    const dispatchedEvent: RuntimeEvent = {
      ...graphBaseEvent(this.context, dispatchOperationId, "dispatched", this.now().toISOString()),
      kind: "graph.work.dispatched",
      data: {
        operationId: dispatchOperationId,
        fingerprint: dispatchFingerprint,
        graphId: this.context.graphId,
        workId,
        delegationId,
      },
    };
    try {
      await appendGraphOperation(this.context, [dispatchedEvent], {
        operationId: dispatchOperationId,
        fingerprint: dispatchFingerprint,
        expectedSessionSequence: refreshed.sessionSequence,
      });
    } catch {
      // Best-effort: the delegation is already running; a CAS conflict means a
      // concurrent dispatch already bound this work. We do NOT cancel the
      // delegation because another caller is responsible for it.
    }
    return JSON.stringify({
      workId,
      status: "dispatched",
      delegationId,
      graphId: this.context.graphId,
    });
  }
}

/** view_graph: read-only projection of the active graph's works and records. */
export class ViewGraphTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(private readonly context: GraphToolContext) {}

  name(): string {
    return "view_graph";
  }

  definition(): ToolDefinition {
    return {
      name: "view_graph",
      description:
        "查看当前 Graph Mode 工作图的状态投影：每个工作单元的指令、输入、状态，以及已产出的记录。",
      inputSchema: {
        type: "object",
        properties: {
          include_records: {
            type: "boolean",
            description: "是否在投影中包含完整记录摘要；默认 true。",
          },
        },
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const includeRecords = parseViewGraphArgs(args);
    const projection = await readGraphProjection(this.context);
    return JSON.stringify(renderGraphProjection(projection, includeRecords));
  }
}

/**
 * close_graph: marks the active graph as closed. The graph must still be active
 * and (when result_record_ids is supplied) every referenced record must exist
 * in the projection. Closing an already-closed graph is a no-op success.
 */
export class CloseGraphTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(
    private readonly context: GraphToolContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  name(): string {
    return "close_graph";
  }

  definition(): ToolDefinition {
    return {
      name: "close_graph",
      description:
        "关闭当前 Graph Mode 工作图。关闭后不得再声明新工作；可选提交最终结果记录列表作为收尾证据。",
      inputSchema: {
        type: "object",
        properties: {
          result_record_ids: {
            type: "array",
            items: { type: "string" },
            description: "作为最终交付的记录 recordId 列表。",
          },
          reason: { type: "string" },
          operationId: { type: "string" },
        },
      },
    };
  }

  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const parsed = parseCloseGraphArgs(args);
    const projection = await readGraphProjection(this.context);
    if (projection.status === "closed") {
      return JSON.stringify({
        graphId: this.context.graphId,
        status: "closed",
        alreadyClosed: true,
      });
    }
    if (parsed.result_record_ids) {
      const known = new Set(projection.records.map((record) => record.recordId));
      const missing = parsed.result_record_ids.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new GraphConflictError(`close_graph 引用了未知记录: ${missing.join(", ")}`);
      }
    }
    const operationId = parsed.operationId ?? `close-graph:${this.context.graphId}:${randomUUID()}`;
    const fingerprint = graphOperationFingerprint("graph.closed", {
      graphId: this.context.graphId,
      resultRecordIds: parsed.result_record_ids ?? [],
    });
    const at = this.now().toISOString();
    const event: RuntimeEvent = {
      ...graphBaseEvent(this.context, operationId, "closed", at),
      kind: "graph.closed",
      data: {
        operationId,
        fingerprint,
        graphId: this.context.graphId,
        ...(parsed.result_record_ids ? { resultRecordIds: [...parsed.result_record_ids] } : {}),
      },
    };
    await appendGraphOperation(this.context, [event], {
      operationId,
      fingerprint,
      expectedSessionSequence: projection.sessionSequence,
    });
    // Report un-converged works so a close with dangling pending work is never
    // silent (maka's `closing` vs `completed` distinction). The close itself is
    // not rejected — mirroring maka's finish, which only asserts committed
    // result ids — but the model sees exactly what it left behind, with status
    // semantics distinguished: a dispatched work's backing delegation is still
    // running and WILL still commit its record (settleGraphWork does not gate on
    // graph status), whereas a requested work will never be scheduled again.
    const pendingWorks = projection.works
      .filter((work) => work.status === "requested" || work.status === "dispatched")
      .map((work) => ({
        workId: work.workId,
        status: work.status,
        instruction: work.instruction,
        ...(work.inputIds.length > 0 ? { inputIds: [...work.inputIds] } : {}),
      }));
    const hasDispatched = pendingWorks.some((work) => work.status === "dispatched");
    const hasRequested = pendingWorks.some((work) => work.status === "requested");
    return JSON.stringify({
      graphId: this.context.graphId,
      status: "closed",
      ...(pendingWorks.length > 0
        ? {
            pendingWorks,
            warning: [
              "图已关闭，但以下工作未完成：",
              hasRequested ? "requested 的工作不会再被调度、也不会产出记录；" : "",
              hasDispatched
                ? "dispatched 的工作其子代理仍在执行，完成后仍会写入 record（但不再触发新的下游调度）。"
                : "",
            ]
              .filter((segment) => segment.length > 0)
              .join(""),
          }
        : {}),
    });
  }
}

interface AddWorkArgs {
  readonly instruction: string;
  readonly inputIds?: readonly string[];
  readonly mode?: string;
  readonly operationId?: string;
}

function parseAddWorkArgs(args: string): AddWorkArgs {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("add_work 参数必须是合法 JSON");
  }
  if (!isRecord(value) || typeof value["instruction"] !== "string") {
    throw new Error("add_work 需要 instruction 字符串参数");
  }
  const inputIds = value["input_ids"];
  if (inputIds !== undefined && (!Array.isArray(inputIds) || !inputIds.every(isNonEmptyString))) {
    throw new Error("add_work input_ids 必须是字符串数组");
  }
  return {
    instruction: value["instruction"],
    ...(Array.isArray(inputIds) ? { inputIds: inputIds as string[] } : {}),
    ...(typeof value["mode"] === "string" ? { mode: value["mode"] } : {}),
    ...(typeof value["operationId"] === "string" ? { operationId: value["operationId"] } : {}),
  };
}

function parseViewGraphArgs(args: string): boolean {
  if (!args.trim()) return true;
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return true;
  }
  if (!isRecord(value)) return true;
  return value["include_records"] !== false;
}

interface CloseGraphArgs {
  readonly result_record_ids?: readonly string[];
  readonly operationId?: string;
}

function parseCloseGraphArgs(args: string): CloseGraphArgs {
  if (!args.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("close_graph 参数必须是合法 JSON");
  }
  if (!isRecord(value)) return {};
  const resultRecordIds = value["result_record_ids"];
  if (
    resultRecordIds !== undefined &&
    (!Array.isArray(resultRecordIds) || !resultRecordIds.every(isNonEmptyString))
  ) {
    throw new Error("close_graph result_record_ids 必须是字符串数组");
  }
  return {
    ...(Array.isArray(resultRecordIds) ? { result_record_ids: resultRecordIds as string[] } : {}),
    ...(typeof value["operationId"] === "string" ? { operationId: value["operationId"] } : {}),
  };
}

function renderGraphProjection(
  projection: GraphProjection,
  includeRecords: boolean,
): Record<string, unknown> {
  const works = projection.works.map((work) => renderGraphWork(projection, work));
  const result: Record<string, unknown> = {
    graphId: projection.graphId,
    status: projection.status,
    sessionSequence: projection.sessionSequence,
    hasPendingWorks: hasPendingWorks(projection),
    readyWorkCount: computeReadyWorks(projection).length,
    works,
  };
  if (includeRecords) {
    result.records = projection.records.map((record) => ({
      recordId: record.recordId,
      workId: record.workId,
      outputSummary: record.outputSummary,
      ...(record.evidenceRefs ? { evidenceRefs: [...record.evidenceRefs] } : {}),
    }));
  }
  return result;
}

function renderGraphWork(projection: GraphProjection, work: GraphWork): Record<string, unknown> {
  const missingInputIds = missingInputIdsFor(projection, work);
  return {
    workId: work.workId,
    instruction: work.instruction,
    inputIds: [...work.inputIds],
    mode: work.mode,
    status: work.status,
    ...(work.delegationId ? { delegationId: work.delegationId } : {}),
    ...(work.recordId ? { recordId: work.recordId } : {}),
    ...(missingInputIds.length > 0
      ? {
          missingInputIds,
          hint: "引用的 input record 尚未产出。若上游已 failed 或引用的是 workId，该工作永远不会就绪。",
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export { recordIdFor };
