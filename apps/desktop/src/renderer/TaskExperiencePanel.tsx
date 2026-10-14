import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  ExperienceApplicability,
  ExperienceReviewAction,
  TaskExperienceCandidate,
  TaskExperienceReuse,
} from "@pico/core";
import { Button, EmptyState, InlineNotice } from "./components.js";
import { SelectField, TextAreaField, TextField } from "./ui-controls.js";
import { isMemoryConflict, RuntimeInvocationError } from "./runtime.js";
import {
  experienceManagementHref,
  type ExperienceManagementTarget,
} from "./experience-management-route.js";
import type {
  ExperienceDetail,
  ExperienceFeedbackRequest,
  ExperienceReviewRequest,
} from "./useTaskExperience.js";
import "./TaskExperiencePanel.css";

const reviewLabels = {
  unneeded: "无需审核",
  pending: "待审核",
  approved: "已确认",
  rejected: "已拒绝",
  deferred: "暂缓",
};
const validationLabels = {
  unknown: "尚未验证",
  pass: "验证通过",
  fail: "验证失败",
  stale: "需重新验证",
};
const familyLabels = { general: "通用任务", coding: "代码任务", spreadsheet: "表格任务" };
export interface TaskExperiencePanelProps {
  readonly items: readonly TaskExperienceCandidate[];
  readonly reuse: readonly TaskExperienceReuse[];
  readonly mode?: "memory" | "conversation";
  readonly filter?: "pending" | "saved" | "archived";
  /** Optional settings layout slots; review and correction state stays owned by this panel. */
  readonly supplementalRows?: ReactNode;
  readonly supplementalDetail?: ReactNode;
  readonly searchQuery?: string;
  readonly onSelectExperience?: () => void;
  readonly onDraftStateChange?: (editing: boolean) => void;
  readonly selectionLocked?: boolean;
  readonly sessionId?: string;
  readonly workspacePath?: string;
  readonly showSummary?: boolean;
  readonly summaryRunId?: string;
  readonly target?: {
    readonly key: string;
    readonly detail: ExperienceDetail;
    readonly reference: ExperienceManagementTarget;
  };
  readonly unavailableTarget?: { readonly key: string; readonly candidateId?: string };
  readonly targetNavigationKey?: string;
  readonly onDetail: (candidateId: string) => Promise<ExperienceDetail>;
  readonly onReview: (request: ExperienceReviewRequest) => Promise<TaskExperienceCandidate>;
  readonly onFeedback: (request: ExperienceFeedbackRequest) => Promise<TaskExperienceCandidate>;
}

export function isExperienceSuggestion(item: TaskExperienceCandidate): boolean {
  return (
    item.kind === "task-lesson" &&
    Boolean(item.content.trim()) &&
    item.review !== "unneeded" &&
    item.state !== "invalidated" &&
    item.state !== "discarded" &&
    item.state !== "expired"
  );
}

function memoryLink(workspacePath?: string, tab = "saved"): string {
  const params = new URLSearchParams({ tab });
  if (workspacePath) params.set("workspace", workspacePath);
  return `/settings/memory?${params}`;
}

export function TaskExperiencePanel(props: TaskExperiencePanelProps) {
  if (props.mode === "conversation") return <ConversationLearning {...props} />;
  return <ExperienceReviewBoard {...props} />;
}

function ExperienceReviewBoard({
  items,
  filter = "pending",
  ...actions
}: TaskExperiencePanelProps) {
  const visible = items.filter((item) =>
    filter === "pending"
      ? isExperienceSuggestion(item) && (item.review === "pending" || item.review === "deferred")
      : filter === "saved"
        ? isExperienceSuggestion(item) &&
          item.review === "approved" &&
          item.lifecycleState === "active"
        : item.lifecycleState === "archived",
  );
  const query = actions.searchQuery?.trim().toLocaleLowerCase();
  const matching = query
    ? visible.filter((item) => `${item.goal} ${item.content}`.toLocaleLowerCase().includes(query))
    : visible;
  const routeScope = JSON.stringify([actions.workspacePath, actions.sessionId]);
  const scopeRef = useRef({ scope: routeScope, generation: 0 });
  if (scopeRef.current.scope !== routeScope)
    scopeRef.current = { scope: routeScope, generation: scopeRef.current.generation + 1 };
  const scope = JSON.stringify([routeScope, scopeRef.current.generation]);
  const [selection, setSelection] = useState<{
    scope: string;
    candidate: TaskExperienceCandidate;
  }>();
  const snapshot = selection?.scope === scope ? selection.candidate : undefined;
  const listed = snapshot && items.find((item) => item.candidateId === snapshot.candidateId);
  const targeted =
    snapshot?.candidateId === actions.target?.detail.candidate.candidateId
      ? actions.target?.detail.candidate
      : undefined;
  const latest =
    targeted && (!listed || targeted.recordRevision > listed.recordRevision) ? targeted : listed;
  const selected = latest && latest.recordRevision >= snapshot!.recordRevision ? latest : snapshot;
  const [draftOwner, setDraftOwner] = useState<string>();
  const draftOwnerRef = useRef<string | undefined>(undefined);
  const hasDraft = Boolean(selected && draftOwner === selected.candidateId);
  useEffect(() => {
    actions.onDraftStateChange?.(hasDraft);
    return () => actions.onDraftStateChange?.(false);
  }, [hasDraft, actions.onDraftStateChange]);
  const [pendingTarget, setPendingTarget] = useState<TaskExperiencePanelProps["target"]>();
  const consumedTarget = useRef<string | undefined>(undefined);
  useEffect(() => {
    setPendingTarget(undefined);
    setDraftOwner(undefined);
    draftOwnerRef.current = undefined;
  }, [scope]);
  useEffect(() => {
    setPendingTarget(undefined);
  }, [actions.targetNavigationKey]);
  useEffect(() => {
    const target = actions.target;
    if (!target || consumedTarget.current === JSON.stringify([scope, target.key])) return;
    consumedTarget.current = JSON.stringify([scope, target.key]);
    if (
      selected &&
      draftOwnerRef.current === selected?.candidateId &&
      selected?.candidateId !== target.detail.candidate.candidateId
    ) {
      setPendingTarget(target);
      return;
    }
    setPendingTarget(undefined);
    setSelection({ scope, candidate: target.detail.candidate });
    actions.onSelectExperience?.();
  }, [actions.target, scope, hasDraft, selected?.candidateId]);
  useEffect(() => {
    if (actions.unavailableTarget) {
      setPendingTarget(undefined);
      if (!hasDraft) setSelection(undefined);
    }
  }, [actions.unavailableTarget?.key, hasDraft]);
  useEffect(() => {
    if (latest && snapshot && latest.recordRevision > snapshot.recordRevision)
      setSelection({ scope, candidate: latest });
  }, [latest, snapshot, scope]);
  const detailId = useId();
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (
      actions.target &&
      selected?.candidateId === actions.target.detail.candidate.candidateId &&
      !hasDraft
    ) {
      detailRef.current?.scrollIntoView({ block: "nearest" });
      detailRef.current?.focus({ preventScroll: true });
    }
  }, [actions.target?.key, selected?.candidateId, hasDraft]);
  if (visible.length === 0 && !selected && !actions.supplementalRows)
    return filter === "pending" ? (
      <EmptyState
        title="没有待审核的任务经验"
        detail="任务完成后，有依据的经验会出现在这里。关闭自动学习后，仍可管理历史经验。"
      />
    ) : null;
  return (
    <div className="task-experience__review-board">
      {hasDraft && !actions.supplementalRows && (
        <p style={{ gridColumn: "1 / -1" }} role="status">
          请先保存或取消当前更正，再选择其他经验。
        </p>
      )}
      {pendingTarget && (
        <div style={{ gridColumn: "1 / -1" }}>
          <InlineNotice>
            已找到链接目标“{pendingTarget.detail.candidate.goal || "任务经验"}
            ”，当前更正草稿已保留。请先保存或取消当前更正，再打开目标。{" "}
            <Button
              variant="quiet"
              disabled={hasDraft}
              onClick={() => {
                setSelection({ scope, candidate: pendingTarget.detail.candidate });
                setPendingTarget(undefined);
              }}
            >
              打开链接目标
            </Button>
          </InlineNotice>
        </div>
      )}
      <div
        className="task-experience__list"
        aria-label={
          actions.supplementalRows
            ? "记忆与经验"
            : filter === "pending"
              ? "待审核的任务经验"
              : "任务经验"
        }
      >
        {!actions.supplementalRows && matching.length === 0 && (
          <p className="task-experience__placeholder">
            {selected && actions.target?.detail.candidate.candidateId === selected.candidateId
              ? "已按链接打开目标经验，该条目不在当前已加载列表中。"
              : `${filter === "pending" ? "没有待审核的任务经验。" : "当前标签没有经验。"}已选详情和更正草稿仍保留。`}
          </p>
        )}
        {matching.map((item) => (
          <button
            key={item.candidateId}
            type="button"
            className="task-experience__row"
            aria-pressed={!actions.supplementalDetail && selected?.candidateId === item.candidateId}
            aria-controls={detailId}
            disabled={
              (hasDraft || actions.selectionLocked) &&
              (Boolean(actions.supplementalDetail) || selected?.candidateId !== item.candidateId)
            }
            onClick={() => {
              if (draftOwnerRef.current || actions.selectionLocked) return;
              setSelection({ scope, candidate: item });
              actions.onSelectExperience?.();
            }}
          >
            <span className="task-experience__row-title">{item.goal || "任务经验"}</span>
            <span>{item.content || "正在整理任务结果…"}</span>
            <span className="task-experience__meta">
              <span>{reviewLabels[item.review]}</span>
              {item.review === "approved" && <span>{item.enabled ? "可引用" : "已停用"}</span>}
              <span>
                {item.validation === "pass" ? "历史验证通过" : validationLabels[item.validation]}
              </span>
              <span>v{item.contentVersion}</span>
            </span>
          </button>
        ))}
        {actions.supplementalRows}
      </div>
      <section
        ref={detailRef}
        tabIndex={-1}
        id={detailId}
        className="task-experience__detail"
        aria-label={actions.supplementalDetail ? "记忆详情" : "任务经验详情"}
      >
        {actions.supplementalDetail}
        <div hidden={Boolean(actions.supplementalDetail)}>
          {selected ? (
            <ExperienceDetailCard
              key={JSON.stringify([scope, selected.candidateId])}
              candidate={selected}
              onDetail={actions.onDetail}
              onReview={actions.onReview}
              initialDetail={
                actions.target?.detail.candidate.candidateId === selected.candidateId
                  ? actions.target.detail
                  : undefined
              }
              reference={
                actions.target?.detail.candidate.candidateId === selected.candidateId
                  ? actions.target.reference
                  : undefined
              }
              targetUnavailable={actions.unavailableTarget?.candidateId === selected.candidateId}
              onDraftChange={(present) => {
                if (present) draftOwnerRef.current = selected.candidateId;
                else if (draftOwnerRef.current === selected.candidateId)
                  draftOwnerRef.current = undefined;
                setDraftOwner(draftOwnerRef.current);
              }}
            />
          ) : (
            <p className="task-experience__placeholder">
              {actions.supplementalRows
                ? "选择一条记忆或经验，查看内容与来源。"
                : "选择一条经验，查看内容、适用条件和来源后审核。"}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function ConversationLearning(props: TaskExperiencePanelProps) {
  const location = useLocation();
  const candidates =
    props.showSummary === false
      ? []
      : props.items.filter(
          (item) =>
            (!props.sessionId || item.sessionId === props.sessionId) &&
            (!props.summaryRunId || item.runId === props.summaryRunId),
        );
  const references = props.reuse.filter(
    (item) => !props.sessionId || item.sessionId === props.sessionId,
  );
  const runs = new Map<string, TaskExperienceCandidate[]>();
  for (const candidate of candidates) {
    const group = runs.get(candidate.runId) ?? [];
    group.push(candidate);
    runs.set(candidate.runId, group);
  }
  if (props.showSummary !== false)
    for (const reference of references)
      if (!runs.has(reference.runId)) runs.set(reference.runId, []);
  const renderReferences = (selected: readonly TaskExperienceReuse[]) =>
    selected.length > 0 ? (
      <section className="task-experience__references" aria-label="本次任务的旧使用记录">
        <h4>本次任务的旧使用记录 · {selected.length} 条</h4>
        <p>引用仅表示提供了参考；是否采用和验证结果分别记录。</p>
        {selected.map((reference) => (
          <ExperienceReference
            key={reference.reuseId}
            reference={reference}
            candidate={props.items.find((item) => item.candidateId === reference.candidateId)}
            onDetail={props.onDetail}
            onReview={props.onReview}
            onFeedback={props.onFeedback}
            workspacePath={props.workspacePath}
          />
        ))}
      </section>
    ) : null;
  if (!runs.size && !references.length) return null;
  return (
    <div className="task-experience__conversation">
      {props.showSummary === false && renderReferences(references)}
      {[...runs].map(([runId, items]) => (
        <details
          className="experience-record task-experience__summary"
          key={runId}
          data-run-id={runId}
          aria-label="本轮任务学习摘要"
        >
          <summary>
            <span>本轮任务学习</span>
            {items.some(isExperienceSuggestion) ? (
              <>
                <span>
                  {
                    items.filter(
                      (item) =>
                        isExperienceSuggestion(item) &&
                        (item.review === "pending" || item.review === "deferred"),
                    ).length
                  }{" "}
                  条待审核
                </span>
                <span>
                  {
                    items.filter(
                      (item) => isExperienceSuggestion(item) && item.review === "approved",
                    ).length
                  }{" "}
                  条已保存经验
                </span>
              </>
            ) : items.length > 0 ? (
              <span>{items.length} 条观察</span>
            ) : null}
            {references.some((reference) => reference.runId === runId) && (
              <span>
                {references.filter((reference) => reference.runId === runId).length} 条旧记录
              </span>
            )}
          </summary>
          <div className="task-experience__summary-content">
            {renderReferences(references.filter((reference) => reference.runId === runId))}
            {items.map((item) => (
              <div key={item.candidateId} className="task-experience__summary-row">
                <span>{item.goal || "任务经验"}</span>
                <ExperienceState candidate={item} />
              </div>
            ))}
            {(items.some(isExperienceSuggestion) ||
              references.some((reference) => reference.runId === runId)) && (
              <Link
                className="button"
                onClick={() => {
                  sessionStorage.setItem(
                    "pico.settings-return-to",
                    location.pathname + location.search,
                  );
                }}
                to={memoryLink(
                  props.workspacePath,
                  items.some(
                    (item) =>
                      isExperienceSuggestion(item) &&
                      (item.review === "pending" || item.review === "deferred"),
                  )
                    ? "pending"
                    : "saved",
                )}
              >
                {items.some(
                  (item) =>
                    isExperienceSuggestion(item) &&
                    (item.review === "pending" || item.review === "deferred"),
                )
                  ? "审核任务经验"
                  : "管理工作区记忆"}
              </Link>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function ExperienceState({ candidate }: { readonly candidate: TaskExperienceCandidate }) {
  if (!isExperienceSuggestion(candidate))
    return (
      <span className="task-experience__meta">
        {candidate.state === "working"
          ? "正在整理观察，尚未形成经验建议"
          : candidate.state === "ready" || candidate.state === "waiting"
            ? "观察已记录，尚未形成经验建议"
            : "整理已停止，未形成经验建议"}
      </span>
    );
  return (
    <span className="task-experience__meta">
      <span>审核：{reviewLabels[candidate.review]}</span>
      <span>历史验证：{validationLabels[candidate.validation]}（范围见使用记录）</span>
      <span>{candidate.enabled ? "已启用" : "未启用"}</span>
      <span>内容 v{candidate.contentVersion}</span>
    </span>
  );
}
interface ExperienceDraft {
  readonly content: string;
  readonly family: ExperienceApplicability["taskFamily"];
  readonly tools: string;
  readonly conditions: string;
  readonly base: TaskExperienceCandidate;
}
function draftFrom(candidate: TaskExperienceCandidate): ExperienceDraft {
  return {
    content: candidate.content,
    family: candidate.applicability.taskFamily,
    tools: candidate.applicability.toolNames.join(", "),
    conditions: candidate.applicability.conditions.join("\n"),
    base: candidate,
  };
}
function applicabilityFrom(draft: ExperienceDraft): ExperienceApplicability {
  return {
    taskFamily: draft.family,
    toolNames: draft.tools
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
    conditions: draft.conditions
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function ExperienceDetailCard({
  candidate,
  onDetail,
  onReview,
  correction = false,
  onSaved,
  initialDetail,
  reference,
  onDraftChange,
  targetUnavailable,
}: Pick<TaskExperiencePanelProps, "onDetail" | "onReview"> & {
  readonly candidate: TaskExperienceCandidate;
  readonly correction?: boolean;
  readonly onSaved?: (candidate: TaskExperienceCandidate) => void;
  readonly initialDetail?: ExperienceDetail;
  readonly reference?: ExperienceManagementTarget;
  readonly onDraftChange?: (present: boolean) => void;
  readonly targetUnavailable?: boolean;
}) {
  const [detail, setDetail] = useState<ExperienceDetail | undefined>(initialDetail);
  const [current, setCurrent] = useState(candidate);
  const [draft, setDraft] = useState<ExperienceDraft | undefined>(() =>
    correction ? draftFrom(candidate) : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [conflictReady, setConflictReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const inFlight = useRef(false);
  const currentRef = useRef(current);
  currentRef.current = current;
  const mounted = useRef(true);
  const request = useRef(0);
  const operation = useRef<{ fingerprint: string; operationId: string } | undefined>(undefined);
  const lastAction = useRef<ExperienceReviewAction | undefined>(undefined);
  useEffect(() => {
    onDraftChange?.(Boolean(draft));
  }, [Boolean(draft), onDraftChange]);
  useEffect(() => {
    if (targetUnavailable) {
      setUnavailable(true);
      setError("经验已删除或不可用。更正草稿保留供复制，不能再次保存或启用。");
    }
  }, [targetUnavailable]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);
  useEffect(() => {
    setCurrent((value) => (value.recordRevision < candidate.recordRevision ? candidate : value));
    if (draft && candidate.recordRevision > draft.base.recordRevision) {
      setConflict(true);
      setConflictReady(
        Boolean(detail && detail.candidate.recordRevision >= candidate.recordRevision),
      );
      setError("经验管理状态已变化。更正草稿已保留，请读取最新版本后继续。");
    }
  }, [candidate]);
  const load = async (asConflict = false) => {
    const sequence = ++request.current;
    setLoading(true);
    if (asConflict) setConflictReady(false);
    if (!asConflict) setError("");
    try {
      const result = await onDetail(candidate.candidateId);
      if (!mounted.current || sequence !== request.current) return;
      if (result.candidate.recordRevision < currentRef.current.recordRevision) return;
      setDetail((value) =>
        value && value.candidate.recordRevision > result.candidate.recordRevision ? value : result,
      );
      setCurrent((value) =>
        value.recordRevision > result.candidate.recordRevision ? value : result.candidate,
      );
      if (asConflict) setConflictReady(true);
    } catch (failure) {
      if (
        mounted.current &&
        sequence === request.current &&
        failure instanceof RuntimeInvocationError &&
        failure.code === "NOT_FOUND"
      ) {
        setUnavailable(true);
        setError("经验已删除或不可用。更正草稿保留供复制，不能再次保存或启用。");
        return;
      }
      if (mounted.current && sequence === request.current)
        setError(
          asConflict
            ? "经验版本已变化，但读取最新内容失败。更正草稿已保留，请重试读取。"
            : "无法读取经验详情，请重试。",
        );
    } finally {
      if (mounted.current && sequence === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (initialDetail && initialDetail.candidate.recordRevision >= candidate.recordRevision) {
      setDetail(initialDetail);
      return;
    }
    void load();
  }, [candidate.candidateId, onDetail]);
  useEffect(() => {
    if (initialDetail)
      setDetail((value) =>
        value && value.candidate.recordRevision > initialDetail.candidate.recordRevision
          ? value
          : initialDetail,
      );
  }, [initialDetail]);
  const act = async (
    action: ExperienceReviewAction,
  ): Promise<TaskExperienceCandidate | undefined> => {
    if (
      inFlight.current ||
      unavailable ||
      (action === "restore" && (current.review === "rejected" || current.state === "discarded")) ||
      (action === "edit_accept" &&
        (!draft?.content.trim() ||
          conflict ||
          current.review === "rejected" ||
          current.state === "discarded"))
    )
      return;
    inFlight.current = true;
    lastAction.current = action;
    const base = action === "edit_accept" && draft ? draft.base : current;
    const payload = {
      candidateId: base.candidateId,
      expectedRecordRevision: base.recordRevision,
      expectedContentVersion: base.contentVersion,
      action,
      ...(action === "edit_accept" && draft
        ? { content: draft.content.trim(), applicability: applicabilityFrom(draft) }
        : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = { fingerprint, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await onReview({ ...payload, operationId: operation.current.operationId });
      if (!mounted.current) return;
      setCurrent((value) =>
        value && value.recordRevision > result.recordRevision ? value : result,
      );
      if (result.recordRevision < currentRef.current.recordRevision) {
        setConflict(true);
        setConflictReady(false);
        setError("保存回包早于当前管理版本。草稿已保留，请读取最新状态。");
        return;
      }
      setDraft(undefined);
      setConflict(false);
      operation.current = undefined;
      setNotice(
        action === "edit_accept"
          ? `已保存并启用内容 v${result.contentVersion}，验证状态已重置，等待后续任务验证。`
          : "操作已保存。",
      );
      if (action === "edit_accept") onSaved?.(result);
      return result;
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof RuntimeInvocationError && failure.code === "NOT_FOUND") {
        setUnavailable(true);
        setError("经验已删除或不可用。更正草稿保留供复制，不能再次保存或启用。");
      } else if (isMemoryConflict(failure)) {
        setConflict(true);
        setError("经验已被更新。你的更正草稿已保留，请查看最新版本后继续。");
        await load(true);
      } else setError("操作未保存。更正草稿已保留，请重试。");
      return undefined;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const beginEditing = async () => {
    if (busy) return;
    const base = current.enabled ? await act("disable") : current;
    if (!base || !mounted.current) return;
    onDraftChange?.(true);
    setDraft(draftFrom(base));
    setConflict(false);
    setError("");
    setNotice("");
  };
  return (
    <article
      className="task-experience__detail-card"
      data-candidate-id={current.candidateId}
      aria-busy={busy || loading}
    >
      <header>
        <h4>{current.goal || "任务经验"}</h4>
        {unavailable ? <p>经验已删除或不可用。</p> : <ExperienceState candidate={current} />}
      </header>
      {reference &&
        (reference.referenceContentVersion !== undefined ||
          reference.referenceItemVersion !== undefined) && (
          <InlineNotice>
            跳转来源：
            {reference.referenceContentVersion !== undefined
              ? `引用内容 v${reference.referenceContentVersion}`
              : `引用记忆 v${reference.referenceItemVersion}`}
            ；当前管理内容 v{current.contentVersion}
            。本页操作作用于当前管理版本，旧使用记录保持原版本。
          </InlineNotice>
        )}
      {current.reason && <p>{current.reason}</p>}
      {notice && <InlineNotice tone="success">{notice}</InlineNotice>}
      {error && (
        <InlineNotice tone="error">
          {error}{" "}
          <Button variant="quiet" disabled={busy || loading} onClick={() => void load(conflict)}>
            重试读取
          </Button>
          {!conflict && lastAction.current && (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                if (lastAction.current) void act(lastAction.current);
              }}
            >
              重试操作
            </Button>
          )}
        </InlineNotice>
      )}
      {draft ? (
        <form
          className="task-experience__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void act("edit_accept");
          }}
        >
          <p>
            {correction
              ? "旧版本已停止用于后续引用。本次保存将确认并启用一个新内容版本，验证结果会重置。"
              : "更正期间这条经验保持停用。保存时一次性确认并启用更正版本；验证结果会重置。"}
          </p>
          <label>
            经验内容
            <TextAreaField
              label="经验内容"
              rows={6}
              maxLength={2000}
              value={draft.content}
              disabled={busy}
              onValueChange={(content) => setDraft({ ...draft, content })}
            />
          </label>
          <label>
            任务类型
            <SelectField
              label="经验适用任务类型"
              value={draft.family}
              disabled={busy}
              options={Object.entries(familyLabels).map(([value, label]) => ({ value, label }))}
              onValueChange={(family) =>
                setDraft({ ...draft, family: family as ExperienceDraft["family"] })
              }
            />
          </label>
          <label>
            适用工具
            <TextField
              label="经验适用工具"
              value={draft.tools}
              disabled={busy}
              placeholder="多个工具用逗号分隔"
              onValueChange={(tools) => setDraft({ ...draft, tools })}
            />
          </label>
          <label>
            适用条件
            <TextAreaField
              label="经验适用条件"
              rows={3}
              value={draft.conditions}
              disabled={busy}
              placeholder="每行一个条件"
              onValueChange={(conditions) => setDraft({ ...draft, conditions })}
            />
          </label>
          {conflict && (
            <div className="task-experience__latest">
              <h5>最新内容 v{current.contentVersion}</h5>
              <p>{current.content}</p>
              <Applicability candidate={current} />
              <Button
                variant="quiet"
                disabled={
                  busy ||
                  loading ||
                  !conflictReady ||
                  unavailable ||
                  current.review === "rejected" ||
                  current.state === "discarded"
                }
                onClick={() => {
                  setDraft({ ...draft, base: current });
                  setConflict(false);
                  setError("");
                  operation.current = undefined;
                }}
              >
                基于最新版本继续更正
              </Button>
            </div>
          )}
          <div className="memory-card__actions">
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                conflict ||
                unavailable ||
                current.review === "rejected" ||
                current.state === "discarded" ||
                !draft.content.trim()
              }
            >
              {busy ? "保存中…" : "保存更正并启用"}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setDraft(undefined)}>
              取消更正
            </Button>
          </div>
        </form>
      ) : (
        <>
          <h5>经验内容</h5>
          <p className="task-experience__content">
            {unavailable ? "经验已删除或不可用。" : current.content || "经验尚在整理中。"}
          </p>
          <Applicability candidate={current} />
          <p>确认表示允许作为参考使用，不代表经验正文或整个任务已通过验证。</p>
          {current.enabled && <p>开始更正会先停止使用旧版本。取消更正后，可单独重新启用。</p>}
          <div className="memory-card__actions">
            {(current.review === "pending" || current.review === "deferred") && (
              <>
                <Button
                  variant="primary"
                  disabled={busy || !current.content.trim()}
                  onClick={() => void act("accept")}
                >
                  确认并启用
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("defer")}
                >
                  暂缓
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("reject")}
                >
                  拒绝
                </Button>
              </>
            )}
            {current.state !== "discarded" && current.review !== "rejected" && !unavailable && (
              <Button
                variant="quiet"
                disabled={busy || unavailable}
                onClick={() => void beginEditing()}
              >
                {current.enabled ? "开始更正" : "编辑并确认"}
              </Button>
            )}
            {current.review === "approved" &&
              !current.enabled &&
              current.lifecycleState !== "archived" && (
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("restore")}
                >
                  重新启用
                </Button>
              )}
            {current.enabled && (
              <Button
                variant="quiet"
                disabled={busy || unavailable}
                onClick={() => void act("disable")}
              >
                停用
              </Button>
            )}
            {(current.review === "approved" || current.lifecycleState === "archived") && (
              <Button
                variant="quiet"
                disabled={
                  busy ||
                  unavailable ||
                  current.review === "rejected" ||
                  current.state === "discarded"
                }
                onClick={() =>
                  void act(current.lifecycleState === "archived" ? "restore" : "archive")
                }
              >
                {current.lifecycleState === "archived" ? "恢复" : "归档并停止引用"}
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={busy || unavailable}
              onClick={() => {
                if (window.confirm("删除这条任务经验？此操作无法恢复，原聊天记录仍保留。"))
                  void act("delete");
              }}
            >
              删除
            </Button>
          </div>
        </>
      )}
      <details className="memory-source">
        <summary>查看来源与用户纠正</summary>
        <p>
          来源任务：{current.taskId} · 任务版本 {current.taskVersion}
        </p>
        {!unavailable &&
          current.sources.map((source, index) => (
            <dl key={index}>
              <div>
                <dt>来源会话</dt>
                <dd>{source.sessionId}</dd>
              </div>
              <div>
                <dt>来源运行</dt>
                <dd>{source.runId}</dd>
              </div>
              <div>
                <dt>来源引用</dt>
                <dd>{source.eventId}</dd>
              </div>
            </dl>
          ))}
        {loading && <p role="status">正在读取来源…</p>}
        {!unavailable &&
          detail?.observations.map((observation) => (
            <p key={observation.observationId}>
              <strong>
                {observation.correction
                  ? "用户纠正"
                  : observation.kind === "user-input"
                    ? "用户输入"
                    : "执行观察"}
                ：
              </strong>
              {observation.summary}{" "}
              <span className="task-experience__source-id">{observation.source.eventId}</span>
            </p>
          ))}
        {!loading && !current.sources.length && !detail?.observations.length && (
          <p>来源详情未提供。</p>
        )}
      </details>
    </article>
  );
}

function Applicability({ candidate }: { readonly candidate: TaskExperienceCandidate }) {
  return (
    <div className="task-experience__applicability">
      <h5>适用范围</h5>
      <p>
        {familyLabels[candidate.applicability.taskFamily]}
        {candidate.applicability.toolNames.length > 0
          ? ` · ${candidate.applicability.toolNames.join("、")}`
          : ""}
      </p>
      {candidate.applicability.conditions.length > 0 ? (
        <ul>
          {candidate.applicability.conditions.map((condition, index) => (
            <li key={index}>{condition}</li>
          ))}
        </ul>
      ) : (
        <p>未提供额外适用条件。</p>
      )}
    </div>
  );
}

function ExperienceReference({
  reference,
  candidate,
  onDetail,
  onReview,
  onFeedback,
  workspacePath,
}: Pick<TaskExperiencePanelProps, "onDetail" | "onReview" | "onFeedback" | "workspacePath"> & {
  readonly reference: TaskExperienceReuse;
  readonly candidate?: TaskExperienceCandidate;
}) {
  const [current, setCurrent] = useState(candidate);
  const [correcting, setCorrecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState(reference.excluded);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [feedbackConflict, setFeedbackConflict] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const operation = useRef<
    { action: ExperienceFeedbackRequest["action"]; operationId: string } | undefined
  >(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (candidate)
      setCurrent((value) =>
        !value || value.recordRevision < candidate.recordRevision ? candidate : value,
      );
  }, [candidate]);
  const feedback = async (action: ExperienceFeedbackRequest["action"]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (operation.current?.action !== action)
      operation.current = { action, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setFeedbackConflict(false);
    try {
      const result = await onFeedback({
        candidateId: reference.candidateId,
        expectedContentVersion: reference.contentVersion,
        taskId: reference.taskId,
        taskVersion: reference.taskVersion,
        action,
        operationId: operation.current.operationId,
      });
      if (!mounted.current) return;
      setCurrent((value) =>
        value && value.recordRevision > result.recordRevision ? value : result,
      );
      setExcluded(true);
      setNotice(
        action === "not_applicable"
          ? "仅本次任务排除此条参考，其他任务仍可使用。"
          : action === "disable"
            ? "这条经验已停用。"
            : `内容 v${reference.contentVersion} 已停止使用，请保存更正版本。`,
      );
      operation.current = undefined;
      if (action === "correct") setCorrecting(true);
    } catch (failure) {
      if (!mounted.current) return;
      setFeedbackConflict(isMemoryConflict(failure));
      setError(
        isMemoryConflict(failure)
          ? "经验版本已变化，本次操作未保存。旧引用保持原始版本，请前往记忆页管理最新经验。"
          : "反馈未保存，请重试。",
      );
      if (isMemoryConflict(failure)) {
        try {
          const latest = await onDetail(reference.candidateId);
          if (mounted.current)
            setCurrent((value) =>
              value && value.recordRevision > latest.candidate.recordRevision
                ? value
                : latest.candidate,
            );
        } catch {
          /* Keep the original reference and error visible. */
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <article
      className="memory-card task-experience__reference"
      data-reference-id={reference.reuseId}
      data-content-version={reference.contentVersion}
      aria-busy={busy}
    >
      <header>
        <strong>{current?.goal || "任务经验参考"}</strong>
        <span className="task-experience__meta">
          <span>旧引用记录 v{reference.contentVersion}（时序不完整）</span>
          <span>
            采用：
            {reference.adoption === "observed"
              ? "已观察到采用"
              : reference.adoption === "not_applied"
                ? "未采用"
                : "未知"}
          </span>
          <span>验证：{validationLabels[reference.validation]}</span>
          <span>{excluded || reference.excluded ? "本次已排除参考" : "本次参考"}</span>
        </span>
      </header>
      <p>旧记录未保存完整的注入时序与验证范围，历史 pass 不代表建议全文或当前任务已验证。</p>
      {reference.referenceContent ? (
        <p>{reference.referenceContent}</p>
      ) : current?.contentVersion === reference.contentVersion ? (
        <p>{current.content}</p>
      ) : null}
      {current && current.contentVersion !== reference.contentVersion && (
        <p>
          当前管理内容已更新为 v{current.contentVersion}，本次引用的是 v{reference.contentVersion}。
        </p>
      )}
      <details className="memory-source">
        <summary>查看实际引用标识</summary>
        <p>
          记忆：{reference.itemId} · 记忆版本 {reference.itemVersion}
        </p>
        <p>引用摘要：{reference.referenceHash}</p>
        <p>
          任务：{reference.taskId} · 任务版本 {reference.taskVersion}
        </p>
      </details>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {error && (
        <InlineNotice tone="error">
          {error}{" "}
          {feedbackConflict ? (
            <Link
              className="button"
              to={experienceManagementHref(
                workspacePath,
                {
                  candidateId: reference.candidateId,
                  itemId: reference.itemId,
                  referenceContentVersion: reference.contentVersion,
                  referenceItemVersion: reference.itemVersion,
                },
                current?.lifecycleState === "archived" ? "archived" : "saved",
              )}
            >
              管理最新经验
            </Link>
          ) : (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                if (operation.current) void feedback(operation.current.action);
              }}
            >
              重试反馈
            </Button>
          )}
        </InlineNotice>
      )}
      {!correcting && (
        <div className="memory-card__actions">
          <Button
            variant="quiet"
            disabled={busy || feedbackConflict || excluded || reference.excluded}
            onClick={() => void feedback("not_applicable")}
          >
            本次不适用
          </Button>
          <Button
            variant="quiet"
            disabled={busy || feedbackConflict || correcting}
            onClick={() => void feedback("correct")}
          >
            {busy ? "正在更新…" : "纠正经验"}
          </Button>
          <Button
            variant="quiet"
            disabled={busy || feedbackConflict || current?.enabled === false}
            onClick={() => void feedback("disable")}
          >
            停用
          </Button>
        </div>
      )}
      {correcting && current && (
        <ExperienceDetailCard
          candidate={current}
          correction
          onDetail={onDetail}
          onReview={onReview}
          onSaved={(result) => {
            setCurrent((value) =>
              value && value.recordRevision > result.recordRevision ? value : result,
            );
            setCorrecting(false);
            setNotice(
              `更正已保存并启用为 v${result.contentVersion}；本次旧引用仍已排除，新版本等待验证。`,
            );
          }}
        />
      )}
    </article>
  );
}
