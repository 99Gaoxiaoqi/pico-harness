import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  GraphWorkbarPanel,
  type WorkbarGraphDetail,
  type WorkbarGraphSummary,
  type WorkbarGraphTimelineItem,
} from "./GraphWorkbarPanel.js";
import type { WorkbarPanelHostProps, WorkbarScope } from "./workbar-panel-contract.js";
import { invokeWorkbarRuntime, QUERY_PAGE_SIZE, workbarErrorMessage } from "./workbar-runtime.js";
import { isRecord, numberField, recordField, stringField } from "./workbar-values.js";

export function GraphPanelController({ workspacePath, sessionId, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [graphs, setGraphs] = useState<readonly WorkbarGraphSummary[]>([]);
  const [selectedGraphId, setSelectedGraphId] = useState<string>();
  const [detail, setDetail] = useState<WorkbarGraphDetail>();
  const [timeline, setTimeline] = useState<readonly WorkbarGraphTimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const listed = parseGraphList(
        await invokeWorkbarRuntime(runtime, "session.graph.query", {
          ...scope,
          action: "list",
        }),
      );
      const selected =
        (selectedGraphId && listed.some(({ graphId }) => graphId === selectedGraphId)
          ? selectedGraphId
          : listed.at(-1)?.graphId) ?? undefined;
      if (!selected) {
        if (request === requestRef.current) {
          setGraphs(listed);
          setSelectedGraphId(undefined);
          setDetail(undefined);
          setTimeline([]);
        }
        return;
      }
      const [nextDetail, nextTimeline] = await Promise.all([
        invokeWorkbarRuntime(runtime, "session.graph.query", {
          ...scope,
          action: "get",
          graphId: selected,
        }).then(parseGraphDetail),
        queryAllGraphTimeline(runtime, scope, selected),
      ]);
      if (request !== requestRef.current) return;
      setGraphs(listed);
      setSelectedGraphId(selected);
      setDetail(nextDetail);
      setTimeline(nextTimeline);
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, scope, selectedGraphId]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  return (
    <GraphWorkbarPanel
      graphs={graphs}
      selectedGraphId={selectedGraphId}
      detail={detail}
      timeline={timeline}
      loading={loading}
      error={error}
      onRefresh={() => void refresh()}
      onSelectGraph={setSelectedGraphId}
      onRetryWake={(wakeId) => {
        if (!selectedGraphId) return;
        void invokeWorkbarRuntime(runtime, "session.graph.retryWake", {
          ...scope,
          graphId: selectedGraphId,
          wakeId,
        })
          .then(() => refresh())
          .catch((cause) => setError(workbarErrorMessage(cause)));
      }}
    />
  );
}

export function parseGraphList(value: unknown): readonly WorkbarGraphSummary[] {
  if (!isRecord(value) || !Array.isArray(value["graphs"])) {
    throw new Error("Graph authority 返回了无效周期列表。");
  }
  return value["graphs"].map(parseGraphSummary);
}

export function parseGraphDetail(value: unknown): WorkbarGraphDetail {
  if (
    !isRecord(value) ||
    !Array.isArray(value["operators"]) ||
    !Array.isArray(value["intents"]) ||
    !Array.isArray(value["claims"]) ||
    !Array.isArray(value["records"]) ||
    !Array.isArray(value["runtimeClaims"]) ||
    !Array.isArray(value["outputs"]) ||
    !Array.isArray(value["diagnostics"]) ||
    !Array.isArray(value["wakes"])
  ) {
    throw new Error("Graph authority 返回了无效详情。");
  }
  const runtimeByClaim = new Map(
    value["runtimeClaims"].map((candidate) => {
      const claimId = stringField(candidate, "claimId");
      const status = stringField(candidate, "status");
      if (!claimId || !status) throw new Error("Graph Runtime Claim 条目无效。");
      return [claimId, status] as const;
    }),
  );
  const outputByClaim = new Map(
    value["outputs"].map((candidate) => {
      const claimId = stringField(candidate, "claimId");
      const status = stringField(candidate, "status");
      if (!claimId || (status !== "success" && status !== "failure")) {
        throw new Error("Graph 正式产出条目无效。");
      }
      return [claimId, status] as const;
    }),
  );
  return {
    summary: parseGraphSummary(value["summary"]),
    operators: value["operators"].map((candidate) => {
      const operatorId = stringField(candidate, "operatorId");
      const role = stringField(candidate, "role");
      if (!operatorId || !role) throw new Error("Graph Operator 条目无效。");
      const profile = recordField(candidate, "profile");
      const generation = numberField(candidate, "generation") ?? 1;
      const provision = Array.isArray(value["provisions"])
        ? value["provisions"].find(
            (entry) =>
              stringField(entry, "operatorId") === operatorId &&
              numberField(entry, "generation") === generation,
          )
        : undefined;
      const childSessionId = stringField(provision, "childSessionId");
      return {
        operatorId,
        role,
        generation,
        ...(stringField(candidate, "description")
          ? { description: stringField(candidate, "description") }
          : {}),
        ...(childSessionId ? { childSessionId } : {}),
        ...(stringField(profile, "profileId")
          ? { profileId: stringField(profile, "profileId") }
          : {}),
      };
    }),
    intents: value["intents"].map((candidate) => {
      const intentId = stringField(candidate, "intentId");
      const operatorId = stringField(candidate, "operatorId");
      const instruction = stringField(candidate, "instruction");
      if (!intentId || !operatorId || !instruction) throw new Error("Graph Intent 条目无效。");
      return {
        intentId,
        operatorId,
        instruction,
        operatorGeneration: numberField(candidate, "operatorGeneration") ?? 1,
        createdAtRevision: numberField(candidate, "createdAtRevision") ?? 0,
      };
    }),
    claims: value["claims"].map((candidate) => {
      const claimId = stringField(candidate, "claimId");
      const intentId = stringField(candidate, "intentId");
      const state = stringField(candidate, "state");
      if (!claimId || !intentId || !state) throw new Error("Graph Claim 条目无效。");
      return {
        claimId,
        intentId,
        ...(stringField(candidate, "targetSessionId")
          ? { targetSessionId: stringField(candidate, "targetSessionId") }
          : {}),
        state: graphClaimDisplayState({
          controlState: state,
          runtimeStatus: runtimeByClaim.get(claimId),
          outputStatus: outputByClaim.get(claimId),
        }),
      };
    }),
    diagnostics: value["diagnostics"].map((candidate) => {
      const diagnosticId = stringField(candidate, "diagnosticId");
      const phase = stringField(candidate, "phase");
      const subjectId = stringField(candidate, "subjectId");
      const classification = stringField(candidate, "classification");
      const state = stringField(candidate, "state");
      const message = stringField(candidate, "message");
      if (!diagnosticId || !phase || !subjectId || !classification || !state || !message) {
        throw new Error("Graph 诊断条目无效。");
      }
      const nextRetryAt = numberField(candidate, "nextRetryAt");
      return {
        diagnosticId,
        phase,
        subjectId,
        classification,
        state,
        message,
        ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
      };
    }),
    wakes: value["wakes"].map((candidate) => {
      const wakeId = stringField(candidate, "wakeId");
      const status = stringField(candidate, "status");
      const attemptCount = numberField(candidate, "attemptCount");
      if (!wakeId || !status || attemptCount === undefined) {
        throw new Error("Graph 根唤醒条目无效。");
      }
      const lastError = stringField(candidate, "lastError");
      return { wakeId, status, attemptCount, ...(lastError ? { lastError } : {}) };
    }),
  };
}

export function graphClaimDisplayState(input: {
  readonly controlState: string;
  readonly runtimeStatus?: string;
  readonly outputStatus?: "success" | "failure";
}): string {
  if (input.controlState === "cancelled" || input.runtimeStatus === "cancelled") {
    return "cancelled";
  }
  if (input.outputStatus === "failure") return "failed";
  if (input.runtimeStatus === "interrupted") return "interrupted";
  if (input.runtimeStatus === "failed") return "failed";
  if (input.runtimeStatus === "completed") {
    return input.outputStatus === "success" ? "completed" : "failed";
  }
  if (input.runtimeStatus === "waiting_permission") return "waiting_permission";
  if (input.runtimeStatus === "running") return "running";
  if (input.runtimeStatus === "not_started") return "claimed";
  return input.controlState;
}

export async function queryAllGraphTimeline(
  runtime: DesktopRuntimeApi,
  scope: WorkbarScope,
  graphId: string,
): Promise<readonly WorkbarGraphTimelineItem[]> {
  let cursor: string | undefined;
  let watermark: string | undefined;
  const items: WorkbarGraphTimelineItem[] = [];
  do {
    const value = await invokeWorkbarRuntime(runtime, "session.graph.query", {
      ...scope,
      action: "timeline",
      graphId,
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(value) || !Array.isArray(value["items"])) {
      throw new Error("Graph authority 返回了无效时间线。");
    }
    const pageWatermark = stringField(value, "watermark");
    if (!pageWatermark || (watermark !== undefined && pageWatermark !== watermark)) {
      throw new Error("Graph 时间线分页水位已经变化，请重试。");
    }
    watermark = pageWatermark;
    items.push(...value["items"].map(parseGraphTimelineItem));
    cursor = stringField(value, "nextCursor");
  } while (cursor);
  return items;
}

function parseGraphSummary(value: unknown): WorkbarGraphSummary {
  const graphId = stringField(value, "graphId");
  const epoch = numberField(value, "epoch");
  const phase = isRecord(value) ? value["phase"] : undefined;
  const headRevision = numberField(value, "headRevision");
  const createdAt = numberField(value, "createdAt");
  const counts = recordField(value, "counts");
  if (
    !graphId ||
    epoch === undefined ||
    (phase !== "open" && phase !== "finished") ||
    headRevision === undefined ||
    createdAt === undefined
  ) {
    throw new Error("Graph 周期摘要无效。");
  }
  const count = (key: string) => {
    const result = numberField(counts, key);
    if (result === undefined) throw new Error("Graph 周期计数无效。");
    return result;
  };
  return {
    graphId,
    epoch,
    phase,
    headRevision,
    createdAt,
    ...(numberField(value, "finishedAt") === undefined
      ? {}
      : { finishedAt: numberField(value, "finishedAt") }),
    counts: {
      operators: count("operators"),
      intents: count("intents"),
      claims: count("claims"),
      records: count("records"),
      resources: count("resources"),
      wakes: count("wakes"),
    },
  };
}

function parseGraphTimelineItem(value: unknown): WorkbarGraphTimelineItem {
  const id = stringField(value, "id");
  const at = numberField(value, "at");
  const kind = stringField(value, "kind");
  if (!id || at === undefined || !kind) throw new Error("Graph 时间线条目无效。");
  return {
    id,
    at,
    kind,
    ...(stringField(value, "status") ? { status: stringField(value, "status") } : {}),
    ...(stringField(value, "subjectId") ? { subjectId: stringField(value, "subjectId") } : {}),
    ...(stringField(value, "detail") ? { detail: stringField(value, "detail") } : {}),
  };
}
