import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  invokeWorkbarRuntime,
  parseGraphDetail,
  parseGraphList,
} from "../workbar-panels/WorkbarPanelHost.js";
import type {
  WorkbarGraphDetail,
  WorkbarGraphSummary,
} from "../workbar-panels/GraphWorkbarPanel.js";

const terminalStates = new Set(["completed", "failed", "interrupted", "cancelled"]);
const stateLabels: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已停止",
  running: "执行中",
  executing: "执行中",
  claimed: "准备中",
  waiting_permission: "等待授权",
  planned: "等待中",
};

export function graphBoardCards(detail: WorkbarGraphDetail) {
  return detail.operators.map((operator) => {
    const intent = detail.intents
      .filter(
        (item) =>
          item.operatorId === operator.operatorId &&
          (item.operatorGeneration ?? 1) === (operator.generation ?? 1),
      )
      .sort((a, b) => (b.createdAtRevision ?? 0) - (a.createdAtRevision ?? 0))[0];
    const claim = intent
      ? detail.claims.filter((item) => item.intentId === intent.intentId).at(-1)
      : undefined;
    const state = claim?.state ?? (detail.summary.phase === "finished" ? "cancelled" : "planned");
    return {
      id: `${operator.operatorId}:${operator.generation ?? 1}`,
      title: operator.profileId ?? operator.role,
      instruction: intent?.instruction ?? operator.description ?? "等待分配任务",
      sessionId: claim?.targetSessionId ?? operator.childSessionId,
      state,
      label: stateLabels[state] ?? "等待中",
      settled: terminalStates.has(state),
    };
  });
}

interface BoardProps {
  readonly detail?: WorkbarGraphDetail | undefined;
  readonly graphs: readonly WorkbarGraphSummary[];
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly stopping: boolean;
  readonly onSelect: (graphId: string) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onStop: () => void;
  readonly onRefresh: () => void;
  readonly onDetails: () => void;
}

export function GraphBoardView(props: BoardProps) {
  const { detail } = props;
  const [collapsed, setCollapsed] = useState(detail?.summary.phase === "finished");
  const [dismissed, setDismissed] = useState(false);
  const contentId = useId();
  const cards = detail ? graphBoardCards(detail) : [];
  const settled = cards.filter((card) => card.settled).length;
  const current = props.graphs.at(-1)?.graphId === detail?.summary.graphId;
  const finished = detail?.summary.phase === "finished";
  const needsAttention =
    detail?.diagnostics.some((item) => item.state !== "resolved") ||
    detail?.wakes.some((item) => item.status === "needs_attention");
  const status = finished
    ? "已结束"
    : needsAttention
      ? "需要处理"
      : cards.some((card) => ["running", "executing", "claimed"].includes(card.state))
        ? "执行中"
        : "等待中";
  if (dismissed && finished && !props.error) return null;
  if (detail && cards.length === 0 && !needsAttention && !props.error) return null;
  return (
    <section className="conversation-graph-board" aria-label="Agent Graph">
      <header className="conversation-graph-board__header">
        <button
          type="button"
          className="conversation-graph-board__heading"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          onClick={() => setCollapsed(!collapsed)}
        >
          <strong>Agent Graph</strong>
          <span role="status">
            {props.loading && !detail
              ? "正在读取…"
              : `${status} · ${settled}/${cards.length} 已结束`}
          </span>
        </button>
        <div className="conversation-graph-board__actions">
          {props.graphs.length > 1 && (
            <select
              aria-label="Graph 周期"
              value={detail?.summary.graphId ?? ""}
              onChange={(event) => props.onSelect(event.target.value)}
            >
              {props.graphs.map((graph, index) => (
                <option key={graph.graphId} value={graph.graphId}>
                  #{graph.epoch} · {index === props.graphs.length - 1 ? "当前" : "历史"}
                </option>
              ))}
            </select>
          )}
          {current && detail && !finished && (
            <button type="button" disabled={props.stopping || props.loading} onClick={props.onStop}>
              {props.stopping ? "正在停止…" : "停止 Graph"}
            </button>
          )}
          <button
            type="button"
            className="conversation-graph-board__icon"
            aria-label={collapsed ? "展开 Agent Graph" : "收起 Agent Graph"}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
          {finished && current && (
            <button
              type="button"
              className="conversation-graph-board__icon"
              aria-label="关闭 Agent Graph 看板"
              onClick={() => setDismissed(true)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>
      {props.error && (
        <div className="conversation-graph-board__error" role="alert">
          {props.error}
          <button type="button" onClick={props.onRefresh}>
            重试
          </button>
        </div>
      )}
      {!collapsed && (
        <div id={contentId} className="conversation-graph-board__body">
          {cards.length ? (
            <>
              <div className="conversation-graph-board__caption">
                <span>子任务</span>
                <button type="button" onClick={props.onDetails}>
                  查看详情
                </button>
              </div>
              <ul>
                {cards.map((card) => (
                  <li key={card.id} data-state={card.state}>
                    <span className="conversation-graph-board__dot" aria-hidden="true" />
                    <div className="conversation-graph-board__task">
                      <strong>{card.title}</strong>
                      <p title={card.instruction}>{card.instruction}</p>
                    </div>
                    <span className="conversation-graph-board__state">{card.label}</span>
                    <button
                      type="button"
                      disabled={!card.sessionId}
                      onClick={() => card.sessionId && props.onOpenSession(card.sessionId)}
                    >
                      打开子任务
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="conversation-graph-board__empty">
              {finished
                ? "本次任务已结束，没有创建子任务。"
                : "任务开始后，子任务和进度会显示在这里。"}
            </p>
          )}
          {needsAttention && (
            <p className="conversation-graph-board__error">
              调度需要处理。
              <button type="button" onClick={props.onDetails}>
                查看详情
              </button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function ConversationGraphBoard(props: {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly refreshKey: string;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onDetails: () => void;
}) {
  const [graphs, setGraphs] = useState<readonly WorkbarGraphSummary[]>([]);
  const [detail, setDetail] = useState<WorkbarGraphDetail>();
  // Undefined follows the latest epoch; an explicit selection stays on history.
  const [selection, setSelection] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [stopState, setStopState] = useState<{
    graphId: string;
    pending: boolean;
    error?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let poll = props.enabled;
      try {
        if (document.hidden) return;
        const scope = { workspacePath: props.workspacePath, sessionId: props.sessionId };
        const list = parseGraphList(
          await invokeWorkbarRuntime(window.pico.runtime, "session.graph.query", {
            ...scope,
            action: "list",
          }),
        );
        if (disposed) return;
        const selected = list.find((graph) => graph.graphId === selection) ?? list.at(-1);
        const next = selected
          ? parseGraphDetail(
              await invokeWorkbarRuntime(window.pico.runtime, "session.graph.query", {
                ...scope,
                action: "get",
                graphId: selected.graphId,
              }),
            )
          : undefined;
        if (disposed) return;
        setGraphs(list);
        setDetail(next);
        setError(undefined);
        poll = list.at(-1)?.phase === "open";
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        poll = true;
      } finally {
        if (!disposed) {
          setLoading(false);
          // Schedule after completion: no overlapping reads or background-window polling.
          if (poll) timer = setTimeout(() => void read(), 3_000);
        }
      }
    };
    void read();
    const onVisible = () => {
      if (!document.hidden) setRefresh((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [props.workspacePath, props.sessionId, props.enabled, props.refreshKey, selection, refresh]);
  if (!props.enabled && !detail?.operators.length && graphs.length < 2 && !error) return null;
  const stop = stopState?.graphId === detail?.summary.graphId ? stopState : undefined;
  return (
    <GraphBoardView
      key={detail?.summary.graphId ?? "empty"}
      detail={detail}
      graphs={graphs}
      loading={loading}
      error={stop?.error ?? error}
      stopping={stop?.pending ?? false}
      onSelect={(graphId) => {
        setSelection(graphId === graphs.at(-1)?.graphId ? undefined : graphId);
        setLoading(true);
      }}
      onOpenSession={props.onOpenSession}
      onDetails={props.onDetails}
      onRefresh={() => {
        setStopState(undefined);
        setRefresh((value) => value + 1);
      }}
      onStop={() => {
        if (!detail || stopState?.pending) return;
        const graphId = detail.summary.graphId;
        setStopState({ graphId, pending: true });
        void invokeWorkbarRuntime(window.pico.runtime, "session.graph.stop", {
          workspacePath: props.workspacePath,
          sessionId: props.sessionId,
          graphId,
        })
          .then((result) => {
            if (!result.stopped) throw new Error("Graph 尚未停止，请重试。");
            setStopState({ graphId, pending: false });
            setRefresh((value) => value + 1);
          })
          .catch((cause: unknown) =>
            setStopState({
              graphId,
              pending: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          );
      }}
    />
  );
}
