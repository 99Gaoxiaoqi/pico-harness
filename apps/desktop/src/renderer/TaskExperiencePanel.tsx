import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  ExperienceApplicability,
  ExperienceReviewAction,
  TaskExperienceCandidate,
  TaskExperienceSummary,
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

const validationLabels = {
  unknown: "尚未验证",
  pass: "验证通过",
  fail: "验证失败",
  stale: "需重新验证",
};
const maturityLabels = {
  unassessed: "待验证",
  trial: "试用中",
  active: "已启用",
  suspended: "已暂停",
};
const promotionReasonLabels = {
  none: "等待可核实的正向复用",
  two_positive_reuses: "两次独立正向复用",
  deterministic_validation: "确定性验证通过",
  human_approved: "经用户审核启用",
};
const riskLabels = { low: "低风险", high: "高风险", unclear: "原因待核实" };
const familyLabels = { general: "通用任务", coding: "代码任务", spreadsheet: "表格任务" };
export interface TaskExperiencePanelProps {
  readonly items: readonly TaskExperienceCandidate[];
  readonly learningVersion?: 2 | 3;
  readonly receipts?: readonly {
    operationId: string;
    sessionId: string;
    committedAt: number;
    createdItemCount: number;
  }[];
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
    (item.representation !== undefined ||
      item.maturity !== undefined ||
      item.review !== "unneeded") &&
    item.state !== "invalidated" &&
    item.state !== "discarded" &&
    item.state !== "expired"
  );
}

type ExperienceSummaryView = Pick<
  TaskExperienceSummary,
  | "maturity"
  | "risk"
  | "review"
  | "enabled"
  | "promotionReason"
  | "positiveReuseCount"
  | "reviewReason"
  | "representation"
  | "usagePolicy"
  | "expiresAt"
  | "scopeUnresolved"
>;

export function experienceMaturity(
  item: ExperienceSummaryView,
): NonNullable<TaskExperienceSummary["maturity"]> {
  if (item.maturity) return item.maturity;
  if (item.review === "approved") return item.enabled ? "active" : "suspended";
  return "unassessed";
}

export function experienceNeedsReview(item: ExperienceSummaryView): boolean {
  if (item.usagePolicy) return item.usagePolicy === "review_required";
  return (
    item.review === "pending" ||
    item.review === "deferred" ||
    ((item.risk === "high" || item.risk === "unclear") &&
      item.review !== "approved" &&
      item.review !== "rejected")
  );
}

export function experienceStatusLabel(
  item: ExperienceSummaryView & { readonly lifecycleState?: "active" | "archived" },
): string {
  if (item.lifecycleState === "archived") return "已归档";
  if (item.usagePolicy) {
    if (item.expiresAt && item.expiresAt <= Date.now()) return "已暂停";
    if (item.usagePolicy === "blocked") return "已暂停";
    if (item.usagePolicy === "case_only" || item.representation === "case") return "仅作案例";
    if (item.usagePolicy === "review_required") return "需你决定";
    return item.enabled ? "可用建议" : "已停用";
  }
  if (experienceNeedsReview(item)) return "待审核";
  if (experienceMaturity(item) === "suspended") return "已暂停";
  return item.enabled ? maturityLabels[experienceMaturity(item)] : "已停用";
}

export function experiencePromotionLabel(item: ExperienceSummaryView): string {
  if (item.usagePolicy)
    return item.representation === "case"
      ? "保留本次过程，尚不能推出通用方法"
      : "仅在所列范围内作为建议";
  const reason = item.promotionReason;
  if (reason && reason !== "none") return promotionReasonLabels[reason];
  if (experienceMaturity(item) === "trial") {
    return item.positiveReuseCount === undefined
      ? promotionReasonLabels.none
      : `正向复用 ${Math.min(item.positiveReuseCount, 2)}/2 次`;
  }
  return item.positiveReuseCount === undefined
    ? "尚无晋级记录"
    : `正向复用 ${item.positiveReuseCount} 次`;
}

export function experienceReviewReason(
  item: ExperienceSummaryView & { readonly reason?: string },
): string {
  return (
    item.reviewReason?.trim() ||
    item.reason?.trim() ||
    (item.risk === "high" ? "这条经验可能影响高风险操作。" : "经验来源或适用条件还需要核实。")
  );
}

export function experienceIsSaved(item: ExperienceSummaryView): boolean {
  if (item.usagePolicy) return item.usagePolicy !== "review_required";
  return !experienceNeedsReview(item) && experienceMaturity(item) !== "unassessed";
}

export function experienceCanRestore(item: TaskExperienceCandidate): boolean {
  if (
    item.review === "rejected" ||
    item.state === "discarded" ||
    item.scopeUnresolved ||
    item.reason === "user_correction" ||
    item.reason === "trusted_reuse_contradiction" ||
    item.usagePolicy === "blocked" ||
    (item.maturity === "suspended" && item.validation === "fail")
  )
    return false;
  if (item.usagePolicy)
    return (
      item.usagePolicy === "suggestion" ||
      (item.representation === "case" && item.lifecycleState === "archived")
    );
  return (
    item.review === "approved" ||
    (item.review === "unneeded" &&
      item.risk === "low" &&
      (item.maturity === "trial" || item.maturity === "active"))
  );
}

function DecisionContext({ candidate }: { readonly candidate: TaskExperienceCandidate }) {
  if (!candidate.usagePolicy) return null;
  const labels = {
    high_impact: "将高影响操作作为默认做法",
    scope_expansion: "扩大方法适用范围",
    long_term_conflict: "改变既有长期做法",
  };
  return (
    <section className="task-experience__review-context" aria-label="变化、范围与影响">
      {candidate.decisionKind && <p>拟议变化：{labels[candidate.decisionKind]}</p>}
      {experienceNeedsReview(candidate) && (
        <>
          <p>当前状态：该提案未获允许；既有做法见下方来源记录。</p>
          <p>拟议做法：{candidate.content}</p>
          <p>
            影响：{candidate.reviewReason || candidate.reason || "仅允许下面列明的做法和范围。"}
          </p>
        </>
      )}
      {candidate.scopeUnresolved && <p>条件尚未核实，需要重新限定适用范围。</p>}
      {candidate.usagePolicy === "blocked" && (
        <p>
          已暂停：
          {candidate.reason === "user_correction"
            ? "用户纠正了这个版本，需要保存新版本后重新判断。"
            : candidate.reason === "trusted_reuse_contradiction"
              ? "具体使用结果与这个版本矛盾，需要修订。"
              : candidate.reason || "当前版本不能引用。"}
        </p>
      )}
      {candidate.expiresAt && (
        <p>保留期限：{new Date(candidate.expiresAt).toLocaleString("zh-CN")}</p>
      )}
      {candidate.review === "approved" && (
        <p>人工决定：已允许在所列范围作为建议，未扩大验证结论。</p>
      )}
      {candidate.decisionKind === "long_term_conflict" && (
        <p>
          既有长期做法需在对应记忆编辑器明确保存后更新。
          <Link className="button" to="/settings/memory?tab=saved">
            打开记忆编辑器
          </Link>
        </p>
      )}
    </section>
  );
}
function EvidenceSummary({ candidate }: { readonly candidate: TaskExperienceCandidate }) {
  const evidence = candidate.evidenceSummary;
  if (!evidence) return null;
  return (
    <section aria-label="实际使用证据">
      <h5>实际使用证据 · 内容 v{candidate.contentVersion}</h5>
      <p>
        实际引用 {evidence.deliveredCount} 次 · 独立任务 {evidence.independentTaskCount} 个 ·
        观察到采用 {evidence.adoptedCount} 次 · 明确有用 {evidence.helpfulCount} 次 · 反证{" "}
        {evidence.contradictionCount} 次
      </p>
      {evidence.results.map((result) => (
        <p key={result.scope + result.validation}>
          范围 {result.scope}：{validationLabels[result.validation]} {result.count} 次
        </p>
      ))}
      <p>每项结果只支持所列范围，人工批准与验证结果分别记录。</p>
    </section>
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
      ? isExperienceSuggestion(item) && experienceNeedsReview(item)
      : filter === "saved"
        ? isExperienceSuggestion(item) &&
          experienceIsSaved(item) &&
          item.lifecycleState === "active"
        : isExperienceSuggestion(item) && item.lifecycleState === "archived",
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
        title={
          actions.learningVersion === 3 ? "没有需要你决定的任务经验" : "没有需要审核的任务经验"
        }
        detail={
          actions.learningVersion === 3
            ? "范围明确的低风险方法可以直接作为建议；原因不明的过程保留为案例。"
            : "低风险经验会先进入受限试用；只有风险较高或来源需要核实的建议才会等待审核。"
        }
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
              ? actions.learningVersion === 3
                ? "需你决定的任务经验"
                : "待审核的任务经验"
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
              <span>{experienceStatusLabel(item)}</span>
              {!item.usagePolicy && experienceMaturity(item) === "trial" && (
                <span>{experiencePromotionLabel(item)}</span>
              )}
              {!item.usagePolicy && experienceMaturity(item) === "active" && (
                <span>晋级依据：{experiencePromotionLabel(item)}</span>
              )}
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
              learningVersion={actions.learningVersion}
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
  return props.learningVersion === 3 || props.items.some((item) => item.representation) ? (
    <ConversationLearningV3 {...props} />
  ) : (
    <ConversationLearningV2 {...props} />
  );
}

function ConversationLearningV3(props: TaskExperiencePanelProps) {
  const items =
    props.showSummary === false
      ? []
      : props.items.filter(
          (item) =>
            (!props.sessionId || item.sessionId === props.sessionId) &&
            (!props.summaryRunId || item.runId === props.summaryRunId),
        );
  const committed = items.filter((item) =>
    item.representation === "case"
      ? item.state === "ready"
      : item.state === "saved" && Boolean(item.itemId),
  );
  const decisions = items.filter(
    (item) => isExperienceSuggestion(item) && experienceNeedsReview(item),
  );
  const processing = items.some((item) => item.state === "working" || item.state === "waiting");
  const receipts = [
    ...new Map(
      (props.summaryRunId ? [] : (props.receipts ?? []))
        .filter((receipt) => !props.sessionId || receipt.sessionId === props.sessionId)
        .map((receipt) => [receipt.operationId, receipt]),
    ).values(),
  ];
  const facts = receipts.reduce((count, receipt) => count + receipt.createdItemCount, 0);
  const methods = committed.filter(
    (item) => item.usagePolicy === "suggestion" && item.enabled,
  ).length;
  const cases = committed.filter((item) => item.representation === "case").length;
  if (!facts && !committed.length && !decisions.length && !processing) return null;
  return (
    <details
      className="experience-record task-experience__summary"
      aria-label={props.summaryRunId ? "本轮任务学习摘要" : "本会话最近保存"}
    >
      <summary>
        <span>{props.summaryRunId ? "本轮任务学习" : "本会话最近保存"}</span>
        {facts > 0 && <span>已保存 {facts} 条事实</span>}
        {methods > 0 && <span>{methods} 条可用建议</span>}
        {cases > 0 && <span>保留 {cases} 条任务案例</span>}
        {decisions.length > 0 && <span>{decisions.length} 条需你决定</span>}
        {processing && <span>正在整理，尚未保存</span>}
      </summary>
      <div className="task-experience__summary-content">
        {committed.map((item) => (
          <div key={item.candidateId} className="task-experience__summary-row">
            <span>{item.goal}</span>
            <ExperienceState candidate={item} />
          </div>
        ))}
        {decisions.map((item) => (
          <ConversationReviewCard
            key={item.candidateId}
            candidate={item}
            workspacePath={props.workspacePath}
            onDetail={props.onDetail}
            onReview={props.onReview}
          />
        ))}
        <Link
          className="button"
          to={memoryLink(props.workspacePath, decisions.length ? "pending" : "saved")}
        >
          查看记忆与案例
        </Link>
      </div>
    </details>
  );
}

function ConversationLearningV2(props: TaskExperiencePanelProps) {
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
                {items.some(
                  (item) => isExperienceSuggestion(item) && experienceNeedsReview(item),
                ) && (
                  <span>
                    {
                      items.filter(
                        (item) => isExperienceSuggestion(item) && experienceNeedsReview(item),
                      ).length
                    }{" "}
                    条待审核
                  </span>
                )}
                {items.some(
                  (item) =>
                    isExperienceSuggestion(item) &&
                    item.enabled &&
                    experienceMaturity(item) === "trial",
                ) && (
                  <span>
                    {
                      items.filter(
                        (item) =>
                          isExperienceSuggestion(item) &&
                          item.enabled &&
                          experienceMaturity(item) === "trial",
                      ).length
                    }{" "}
                    条试用中
                  </span>
                )}
                {items.some(
                  (item) =>
                    isExperienceSuggestion(item) &&
                    item.enabled &&
                    experienceMaturity(item) === "active",
                ) && (
                  <span>
                    {
                      items.filter(
                        (item) =>
                          isExperienceSuggestion(item) &&
                          item.enabled &&
                          experienceMaturity(item) === "active",
                      ).length
                    }{" "}
                    条已启用
                  </span>
                )}
                {items.some(
                  (item) =>
                    isExperienceSuggestion(item) && !experienceNeedsReview(item) && !item.enabled,
                ) && (
                  <span>
                    {
                      items.filter(
                        (item) =>
                          isExperienceSuggestion(item) &&
                          !experienceNeedsReview(item) &&
                          !item.enabled,
                      ).length
                    }{" "}
                    条已停用
                  </span>
                )}
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
                {isExperienceSuggestion(item) && experienceNeedsReview(item) && (
                  <ConversationReviewCard
                    candidate={item}
                    workspacePath={props.workspacePath}
                    onDetail={props.onDetail}
                    onReview={props.onReview}
                  />
                )}
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
                  items.some((item) => isExperienceSuggestion(item) && experienceNeedsReview(item))
                    ? "pending"
                    : "saved",
                )}
              >
                {items.some((item) => isExperienceSuggestion(item) && experienceNeedsReview(item))
                  ? "查看待审核经验"
                  : "查看经验进度"}
              </Link>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function ConversationReviewCard({
  candidate,
  workspacePath,
  onDetail,
  onReview,
}: Pick<TaskExperiencePanelProps, "onDetail" | "onReview"> & {
  readonly candidate: TaskExperienceCandidate;
  readonly workspacePath?: string;
}) {
  const location = useLocation();
  const [current, setCurrent] = useState(candidate);
  const [busy, setBusy] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<ExperienceDetail>();
  const operation = useRef<{ fingerprint: string; operationId: string } | undefined>(undefined);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setLoadingSources(true);
    void onDetail(candidate.candidateId)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, [candidate.candidateId, candidate.recordRevision, onDetail]);
  useEffect(() => {
    setCurrent((previous) =>
      previous.recordRevision > candidate.recordRevision ? previous : candidate,
    );
  }, [candidate]);

  const act = async (
    action: Extract<ExperienceReviewAction, "accept" | "defer" | "reject" | "keep_case">,
  ) => {
    if (inFlight.current || !experienceNeedsReview(current)) return;
    inFlight.current = true;
    const payload = {
      candidateId: current.candidateId,
      expectedRecordRevision: current.recordRevision,
      expectedContentVersion: current.contentVersion,
      action,
    };
    const fingerprint = JSON.stringify(payload);
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = { fingerprint, operationId: crypto.randomUUID() };
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await onReview({ ...payload, operationId: operation.current.operationId });
      setCurrent((previous) =>
        previous.recordRevision > result.recordRevision ? previous : result,
      );
      operation.current = undefined;
      setNotice(
        action === "accept"
          ? "已确认并启用；这不代表经验已经通过验证。"
          : action === "defer"
            ? "已暂缓，这条经验不会用于后续任务。"
            : action === "keep_case"
              ? "已保留为案例，取消本次决定请求。"
              : "已删除，这条经验不会用于后续任务。",
      );
    } catch (failure) {
      setError(
        isMemoryConflict(failure)
          ? "审核状态已变化，请到记忆页读取最新详情后再操作。"
          : "审核操作未保存，请重试或到记忆页查看当前状态。",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const detailHref = experienceManagementHref(
    workspacePath,
    { candidateId: current.candidateId },
    "pending",
  );
  const firstSource = current.sources[0];

  return (
    <section className="task-experience__summary-review" aria-label="任务经验审核卡片">
      <header>
        <strong>
          {current.risk === "high"
            ? riskLabels.high
            : current.risk === "unclear"
              ? riskLabels.unclear
              : current.usagePolicy
                ? "需你决定"
                : "待审核"}
        </strong>
        <span>{current.usagePolicy ? "决定前不会用于后续任务" : "审核前不会用于后续任务"}</span>
      </header>
      <p>{experienceReviewReason(current)}</p>
      <DecisionContext candidate={current} />
      <p className="task-experience__summary-review-content">{current.content}</p>
      <Applicability candidate={current} />
      <p>来源：{current.sources.length} 条本轮任务记录</p>
      {detail?.observations.length ? (
        <section className="task-experience__summary-review-sources" aria-label="来源摘要">
          <strong>来源摘要</strong>
          {detail.observations.slice(0, 3).map((observation) => (
            <p key={observation.observationId}>
              {observation.correction
                ? "用户纠正"
                : observation.kind === "user-input"
                  ? "用户输入"
                  : "执行观察"}
              ：{observation.summary}
            </p>
          ))}
          {detail.observations.length > 3 && (
            <p>另有 {detail.observations.length - 3} 条来源摘要。</p>
          )}
        </section>
      ) : (
        <p>
          {loadingSources
            ? "正在读取来源摘要…"
            : current.sources.length
              ? `有 ${current.sources.length} 条来源记录，摘要暂不可用。`
              : "来源事件暂不可用。"}
        </p>
      )}
      {firstSource && (
        <details className="memory-source">
          <summary>查看来源引用</summary>
          {current.sources.map((source) => (
            <dl key={`${source.sessionId}:${source.eventId}`}>
              <div>
                <dt>来源会话</dt>
                <dd>{source.sessionId}</dd>
              </div>
              <div>
                <dt>来源运行</dt>
                <dd>{source.runId}</dd>
              </div>
              <div>
                <dt>来源事件</dt>
                <dd>{source.eventId}</dd>
              </div>
            </dl>
          ))}
        </details>
      )}
      {notice && <InlineNotice tone="success">{notice}</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {experienceNeedsReview(current) && (
        <div className="task-experience__summary-review-actions">
          <Button
            variant="primary"
            disabled={
              busy || !current.content.trim() || current.decisionKind === "long_term_conflict"
            }
            onClick={() => void act("accept")}
          >
            {busy ? "处理中…" : current.usagePolicy ? "允许在所列范围使用" : "确认并启用"}
          </Button>
          <Link
            className="button button--quiet"
            onClick={() =>
              sessionStorage.setItem("pico.settings-return-to", location.pathname + location.search)
            }
            to={detailHref}
          >
            {current.usagePolicy ? "编辑后决定" : "编辑详情"}
          </Link>
          {current.usagePolicy && (
            <Button variant="quiet" disabled={busy} onClick={() => void act("keep_case")}>
              保留为案例
            </Button>
          )}
          <Button variant="quiet" disabled={busy} onClick={() => void act("defer")}>
            {current.usagePolicy ? "稍后决定" : "暂缓"}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => void act("reject")}>
            {current.usagePolicy ? "删除" : "拒绝"}
          </Button>
        </div>
      )}
    </section>
  );
}

function ExperienceState({ candidate }: { readonly candidate: TaskExperienceCandidate }) {
  if (candidate.usagePolicy)
    return (
      <span className="task-experience__meta">
        <span>{experienceStatusLabel(candidate)}</span>
        {candidate.representation === "case" && <span>保留本次过程，尚不能推出通用方法</span>}
        <span>内容 v{candidate.contentVersion}</span>
      </span>
    );
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
      <span>
        {experienceNeedsReview(candidate)
          ? "需审核"
          : !candidate.enabled || candidate.lifecycleState === "archived"
            ? experienceStatusLabel(candidate)
            : experienceMaturity(candidate) === "trial"
              ? "已记录待验证"
              : experienceMaturity(candidate) === "active"
                ? "已晋级并启用"
                : maturityLabels[experienceMaturity(candidate)]}
      </span>
      {experienceNeedsReview(candidate) && <span>{experienceReviewReason(candidate)}</span>}
      {experienceMaturity(candidate) === "trial" && (
        <span>{experiencePromotionLabel(candidate)}</span>
      )}
      {experienceMaturity(candidate) === "active" && (
        <span>晋级依据：{experiencePromotionLabel(candidate)}</span>
      )}
      <span>历史验证：{validationLabels[candidate.validation]}（范围见使用记录）</span>
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
  readonly representation?: "case" | "method";
}
function draftFrom(candidate: TaskExperienceCandidate): ExperienceDraft {
  return {
    content: candidate.content,
    family: candidate.applicability.taskFamily,
    tools: candidate.applicability.toolNames.join(", "),
    conditions: candidate.applicability.conditions.join("\n"),
    base: candidate,
    representation: candidate.representation,
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
  learningVersion,
  onSaved,
  initialDetail,
  reference,
  onDraftChange,
  targetUnavailable,
}: Pick<TaskExperiencePanelProps, "onDetail" | "onReview" | "learningVersion"> & {
  readonly candidate: TaskExperienceCandidate;
  readonly correction?: boolean;
  readonly onSaved?: (candidate: TaskExperienceCandidate) => void;
  readonly initialDetail?: ExperienceDetail;
  readonly reference?: ExperienceManagementTarget;
  readonly onDraftChange?: (present: boolean) => void;
  readonly targetUnavailable?: boolean;
}) {
  const v3 = learningVersion === 3 || Boolean(candidate.usagePolicy);
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
      (action === "restore" && !experienceCanRestore(current)) ||
      ((action === "edit_accept" || action === "revise") &&
        (!draft?.content.trim() ||
          conflict ||
          current.review === "rejected" ||
          current.state === "discarded"))
    )
      return;
    inFlight.current = true;
    lastAction.current = action;
    const base = (action === "edit_accept" || action === "revise") && draft ? draft.base : current;
    const payload = {
      candidateId: base.candidateId,
      expectedRecordRevision: base.recordRevision,
      expectedContentVersion: base.contentVersion,
      action,
      ...((action === "edit_accept" || action === "revise") && draft
        ? {
            content: draft.content.trim(),
            applicability: applicabilityFrom(draft),
            ...(v3 && draft.representation ? { representation: draft.representation } : {}),
          }
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
        action === "revise"
          ? `已保存更正为内容 v${result.contentVersion}，${experienceStatusLabel(result)}；证据按新版本重新积累。`
          : action === "edit_accept"
            ? `已保存并启用内容 v${result.contentVersion}，验证状态已重置，等待后续任务验证。`
            : "操作已保存。",
      );
      if (action === "edit_accept" || action === "revise") onSaved?.(result);
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
      {current.reason && !experienceNeedsReview(current) && <p>{current.reason}</p>}
      {v3 && <DecisionContext candidate={current} />}
      {v3 && <EvidenceSummary candidate={current} />}
      {experienceNeedsReview(current) && !unavailable && (
        <section className="task-experience__review-context" aria-label="审核原因和来源">
          <strong>
            {current.risk === "high"
              ? riskLabels.high
              : current.risk === "unclear"
                ? riskLabels.unclear
                : "需要审核"}
          </strong>
          <p>{experienceReviewReason(current)}</p>
          <p>
            来源：{current.sources.length} 条任务记录
            {current.sources[0] ? ` · 事件 ${current.sources[0].eventId}` : " · 来源事件暂不可用"}
          </p>
          <p>审核通过前，这条建议不会用于后续任务。</p>
        </section>
      )}
      {!v3 && !experienceNeedsReview(current) && experienceMaturity(current) !== "unassessed" && (
        <section className="task-experience__promotion-context" aria-label="经验状态和晋级依据">
          <strong>{experienceStatusLabel(current)}</strong>
          <span>{experiencePromotionLabel(current)}</span>
          {current.enabled && experienceMaturity(current) === "trial" && (
            <span>只在适用范围匹配时作为待验证提示，不会自动执行。</span>
          )}
          {!current.enabled && <span>这条经验当前不会用于后续任务。</span>}
        </section>
      )}
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
            void act(v3 ? "revise" : "edit_accept");
          }}
        >
          <p>
            {v3
              ? "更正期间旧版本停止引用。普通保存后由系统按内容和范围判断是否可用；保存不会批准高影响做法。"
              : correction
                ? "旧版本已停止用于后续引用。本次保存将确认并启用一个新内容版本，验证结果会重置。"
                : "更正期间这条经验保持停用。保存时一次性确认并启用更正版本；验证结果会重置。"}
          </p>
          {v3 && draft.base.representation === "case" && (
            <SelectField
              label="保存形式"
              value={draft.representation ?? "case"}
              disabled={busy}
              options={[
                { value: "case", label: "保留案例" },
                { value: "method", label: "保存为方法" },
              ]}
              onValueChange={(representation) =>
                setDraft({ ...draft, representation: representation as "case" | "method" })
              }
            />
          )}
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
              {busy
                ? "保存中…"
                : v3
                  ? draft.base.representation === "case" && draft.representation === "method"
                    ? "保存为方法"
                    : "保存更正"
                  : "保存更正并启用"}
            </Button>
            {v3 &&
              experienceNeedsReview(draft.base) &&
              draft.base.decisionKind !== "long_term_conflict" && (
                <Button
                  variant="quiet"
                  disabled={busy || conflict || unavailable || !draft.content.trim()}
                  onClick={() => void act("edit_accept")}
                >
                  保存并允许在所列范围使用
                </Button>
              )}
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
          {experienceNeedsReview(current) && (
            <p>确认表示允许作为参考使用，不代表经验正文或整个任务已通过验证。</p>
          )}
          {current.enabled && <p>开始更正会先停止使用旧版本。取消更正后，可单独重新启用。</p>}
          <div className="memory-card__actions">
            {experienceNeedsReview(current) && (
              <>
                <Button
                  variant="primary"
                  disabled={
                    busy || !current.content.trim() || current.decisionKind === "long_term_conflict"
                  }
                  onClick={() => void act("accept")}
                >
                  {v3 ? "允许在所列范围使用" : "确认并启用"}
                </Button>
                {v3 && (
                  <Button
                    variant="quiet"
                    disabled={busy || unavailable}
                    onClick={() => void act("keep_case")}
                  >
                    保留为案例
                  </Button>
                )}
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("defer")}
                >
                  {v3 ? "稍后决定" : "暂缓"}
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("reject")}
                >
                  {v3 ? "删除并拒绝" : "拒绝"}
                </Button>
              </>
            )}
            {current.state !== "discarded" && current.review !== "rejected" && !unavailable && (
              <Button
                variant="quiet"
                disabled={busy || unavailable}
                onClick={() => void beginEditing()}
              >
                {v3
                  ? experienceNeedsReview(current)
                    ? "编辑后决定"
                    : "编辑更正"
                  : current.enabled
                    ? "开始更正"
                    : "编辑并确认"}
              </Button>
            )}
            {experienceCanRestore(current) &&
              !current.enabled &&
              current.lifecycleState !== "archived" && (
                <Button
                  variant="quiet"
                  disabled={busy || unavailable}
                  onClick={() => void act("restore")}
                >
                  {v3 ? "重新启用建议" : current.maturity === "trial" ? "恢复受限试用" : "重新启用"}
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
            {(v3 ||
              current.review === "approved" ||
              current.lifecycleState === "archived" ||
              (current.review === "unneeded" && current.risk === "low")) &&
              (current.lifecycleState !== "archived" || experienceCanRestore(current)) && (
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
                  {current.lifecycleState === "archived"
                    ? v3 && current.expiresAt
                      ? `恢复并重新保留 ${current.representation === "case" ? 30 : 90} 天`
                      : "恢复"
                    : current.representation === "case"
                      ? "归档案例"
                      : "归档并停止引用"}
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
      {candidate.requiredConditions && candidate.requiredConditions.length > 0 && (
        <>
          <h5>宿主必须核实的条件</h5>
          <ul>
            {candidate.requiredConditions.map((condition, index) => (
              <li key={index}>
                {condition.kind === "spreadsheet-range"
                  ? "当前附件与目标范围：无表头、有限数值求和"
                  : "当前执行目标必须与冻结的证据范围一致"}
              </li>
            ))}
          </ul>
        </>
      )}
      {candidate.usagePolicy && <p>使用说明与例外：</p>}
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
