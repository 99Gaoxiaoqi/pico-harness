import { TabList, Tab } from "@astryxdesign/core/TabList";
import { SelectField, TextAreaField, TextField } from "./ui-controls.js";
import {
  Archive,
  ArchiveRestore,
  BrainCircuit,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type {
  RuntimeMemoryConsolidationReceipt,
  RuntimeMemoryItem,
  RuntimeMemoryListItem,
  RuntimeResult,
} from "@pico/protocol";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import {
  experienceIsSaved,
  experienceNeedsReview,
  isExperienceSuggestion,
} from "./TaskExperiencePanel.js";
import type { RuntimeStore } from "./runtime.js";
import { TaskExperiencePanel } from "./TaskExperiencePanel.js";
import { useTaskExperience } from "./useTaskExperience.js";
import { useExperienceLedger } from "./useExperienceLedger.js";
import { ExperienceUsagePanel } from "./ExperienceUsagePanel.js";
import { RuntimeInvocationError } from "./runtime.js";
import { readExperienceManagementTarget } from "./experience-management-route.js";
import type { ExperienceDetail, ExperienceReviewRequest } from "./useTaskExperience.js";

import "./MemoryPage.css";

const panels = ["saved", "archived"] as const;
type PanelId = "pending" | "usage" | (typeof panels)[number];
const panelLabels = { pending: "需你决定", saved: "已保存", archived: "已归档", usage: "使用记录" };
const kindLabels: Record<RuntimeMemoryItem["kind"], string> = {
  preference: "偏好",
  identity: "身份",
  context: "背景",
  knowledge: "知识",
  failure: "失败经验",
  note: "笔记",
};
const statementLabels = { fact: "事实", plan: "计划", prediction: "预测" };
const temporalLabels = {
  undated: "未注明时间",
  point: "时间点",
  interval: "时间区间",
  open_ended: "已知起点，未注明结束",
};
type MemoryListItem = RuntimeMemoryItem | RuntimeMemoryListItem;
function isLegacyExecutionMemory(item: {
  readonly sourceType?: string;
  readonly executionEvidence?: unknown;
}): boolean {
  return item.sourceType === "execution-evidence" || item.executionEvidence !== undefined;
}
type TimeChoice = "preserve" | "clear" | "point" | "interval" | "open_ended";
interface MemoryEditor {
  readonly id: string;
  readonly version: number;
  readonly workspacePath: string;
  readonly content: string;
  readonly statementType: RuntimeMemoryItem["statementType"];
  readonly timeChoice: TimeChoice;
  readonly start: string;
  readonly end: string;
}
const sourceLabels = {
  "user-evidence": "用户原始陈述",
  manual: "手动内容，无会话引用",
  "assistant-note": "用户保留的助手笔记（未经独立核实）",
  "execution-evidence": "执行结果验证的经验（低信任参考）",
  "execution-validated": "历史执行经验（仅限定目标验收，低信任参考）",
  "reviewed-reference": "任务经验（参考）",
};
const matchLabels = { key: "关键词匹配", content: "正文匹配", preference: "常驻偏好" };
const diagnosticLabels = {
  selected: "已选入",
  duplicate: "重复展示已省略",
  budget: "超过 Token 预算",
  item_limit: "超过条数限制",
};
const consolidationReasonLabels: Record<
  RuntimeMemoryConsolidationReceipt["items"][number]["reason"],
  string
> = {
  duplicate: "重复内容",
  superseded: "已被新记忆替代",
  stale: "信息已过时",
  low_value: "长期价值较低",
};

type ConsolidationNotice = {
  readonly tone: "warning" | "error" | "success";
  readonly message: string;
};

export function nextMemoryTabIndex(current: number, key: string, count = panels.length): number {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return current;
}

function useNarrowLayout(forceNarrow?: boolean): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      forceNarrow ??
      (typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches),
  );
  useEffect(() => {
    if (forceNarrow !== undefined || typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 860px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [forceNarrow]);
  return forceNarrow ?? narrow;
}

export function MemoryPage({
  runtime,
  forceNarrow,
  embedded = false,
  scopeFilter = "all",
  onDraftStateChange,
}: {
  readonly runtime: RuntimeStore;
  readonly forceNarrow?: boolean;
  readonly embedded?: boolean;
  readonly onDraftStateChange?: (editing: boolean) => void;
  readonly scopeFilter?: "all" | "global" | "workspace";
}) {
  const { data, actions, busy } = runtime;
  const memory = data.memory;
  const experience = useTaskExperience(runtime, {
    workspacePath: data.workspacePath,
    enabled: scopeFilter !== "global",
  });
  const ledger = useExperienceLedger(runtime, {
    workspacePath: data.workspacePath,
    enabled: scopeFilter !== "global",
  });
  const showExperience = experience.supported && scopeFilter !== "global";
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const routeTarget = useMemo(() => {
    const params = new URLSearchParams(location.search);
    // Older native candidate links now open shared memory/history, without inspecting internal candidates.
    if (params.get("tab") === "native") params.delete("candidate");
    return readExperienceManagementTarget(params, location.hash);
  }, [location.search, location.hash]);
  const targetKey = JSON.stringify([data.workspacePath, routeTarget]);
  const targetScope = useRef({ key: targetKey, generation: 0 });
  if (targetScope.current.key !== targetKey)
    targetScope.current = { key: targetKey, generation: targetScope.current.generation + 1 };
  const targetGeneration = targetScope.current.generation;
  const targetRequest = useRef(0);
  const [targetRetry, setTargetRetry] = useState(0);
  const [targetState, setTargetState] = useState<{
    key: string;
    generation: number;
    detail?: ExperienceDetail;
    item?: MemoryListItem;
    status: "loading" | "ready" | "unavailable" | "legacy" | "retired" | "error";
  }>();
  const resolvedTarget =
    targetState?.key === targetKey && targetState.generation === targetGeneration
      ? targetState
      : undefined;
  useEffect(() => {
    const sequence = ++targetRequest.current;
    if (!routeTarget || !data.workspacePath || !data.trusted || runtime.connection.kind !== "ready")
      return;
    const workspacePath = data.workspacePath;
    const current = () =>
      targetScope.current.key === targetKey &&
      targetScope.current.generation === targetGeneration &&
      targetRequest.current === sequence;
    setTargetState((current) =>
      current?.key === targetKey && current.generation === targetGeneration
        ? { ...current, status: "loading" }
        : { key: targetKey, generation: targetGeneration, status: "loading" },
    );
    void (async () => {
      try {
        let detail: ExperienceDetail | undefined;
        let item: RuntimeMemoryItem | undefined;
        if (routeTarget.candidateId && experience.supported) {
          detail = await experience.onDetail(routeTarget.candidateId);
          if (routeTarget.itemId && detail.candidate.itemId !== routeTarget.itemId)
            throw new RuntimeInvocationError("NOT_FOUND", "目标经验不可用", false);
        } else if (routeTarget.itemId) {
          item = await actions.getExperienceMemoryItem(workspacePath, routeTarget.itemId);
          if (!item) throw new RuntimeInvocationError("NOT_FOUND", "目标记忆不可用", false);
          if (isLegacyExecutionMemory(item)) {
            if (current())
              setTargetState({ key: targetKey, generation: targetGeneration, status: "legacy" });
            return;
          }
          if (item.taskExperience && experience.supported)
            detail = await experience.onDetail(item.taskExperience.candidateId);
        } else throw new RuntimeInvocationError("NOT_FOUND", "目标经验不可用", false);
        if (current())
          setTargetState((previous) => ({
            key: targetKey,
            generation: targetGeneration,
            detail:
              previous?.key === targetKey &&
              previous.generation === targetGeneration &&
              previous.detail &&
              detail &&
              previous.detail.candidate.recordRevision > detail.candidate.recordRevision
                ? previous.detail
                : detail,
            item:
              previous?.key === targetKey &&
              previous.generation === targetGeneration &&
              previous.item &&
              item &&
              previous.item.version > item.version
                ? previous.item
                : item,
            status: "ready",
          }));
      } catch (failure) {
        if (current()) {
          const unavailable =
            failure instanceof RuntimeInvocationError && failure.code === "NOT_FOUND";
          setTargetState((previous) =>
            !unavailable && previous?.key === targetKey && previous.generation === targetGeneration
              ? { ...previous, status: "error" }
              : {
                  key: targetKey,
                  generation: targetGeneration,
                  status: unavailable
                    ? failure.message === "NOT_FOUND: 旧版经验已移除"
                      ? "retired"
                      : "unavailable"
                    : "error",
                },
          );
        }
      }
    })();
    return () => {
      targetRequest.current += 1;
    };
  }, [
    targetKey,
    targetGeneration,
    targetRetry,
    data.trusted,
    runtime.connection.kind,
    actions,
    experience.onDetail,
    experience.supported,
  ]);
  const targetDetail = resolvedTarget?.detail;
  const currentTargetCandidate =
    targetDetail &&
    experience.items.find((item) => item.candidateId === targetDetail.candidate.candidateId);
  const targetCandidate =
    currentTargetCandidate &&
    currentTargetCandidate.recordRevision > targetDetail!.candidate.recordRevision
      ? currentTargetCandidate
      : targetDetail?.candidate;
  const listedTargetItem =
    resolvedTarget?.item &&
    memory.items.find((item) => item.itemId === resolvedTarget.item!.itemId);
  const targetItem =
    listedTargetItem && listedTargetItem.version > resolvedTarget!.item!.version
      ? listedTargetItem
      : resolvedTarget?.item;
  useEffect(() => {
    if (
      resolvedTarget?.status !== "ready" ||
      (targetCandidate === resolvedTarget.detail?.candidate && targetItem === resolvedTarget.item)
    )
      return;
    setTargetState((current) => {
      if (current?.key !== targetKey || current.generation !== targetGeneration) return current;
      const detail =
        current.detail &&
        targetCandidate &&
        current.detail.candidate.recordRevision < targetCandidate.recordRevision
          ? { ...current.detail, candidate: targetCandidate }
          : current.detail;
      const item =
        targetItem && current.item && current.item.version < targetItem.version
          ? targetItem
          : current.item;
      return detail === current.detail && item === current.item
        ? current
        : { ...current, detail, item };
    });
  }, [resolvedTarget, targetCandidate, targetItem, targetKey, targetGeneration]);
  const reviewExperience = useCallback(
    async (request: ExperienceReviewRequest) => {
      const candidate = await experience.onReview(request);
      if (
        targetScope.current.key === targetKey &&
        targetScope.current.generation === targetGeneration
      )
        setTargetState((current) =>
          current?.key === targetKey &&
          current.generation === targetGeneration &&
          current.detail?.candidate.candidateId === candidate.candidateId &&
          current.detail.candidate.recordRevision <= candidate.recordRevision
            ? { ...current, detail: { ...current.detail, candidate } }
            : current,
        );
      return candidate;
    },
    [experience.onReview, targetKey, targetGeneration],
  );
  const displayPanels: readonly PanelId[] = embedded
    ? ["saved", "pending", "archived", "usage"]
    : experience.supported
      ? ["pending", ...panels]
      : panels;
  const pendingCount = (showExperience ? experience.items : []).filter(
    (item) => isExperienceSuggestion(item) && experienceNeedsReview(item),
  ).length;
  const narrow = useNarrowLayout(forceNarrow);
  const [activePanel, setActivePanel] = useState<PanelId>(
    searchParams.get("tab") === "pending" && experience.supported ? "pending" : "saved",
  );
  const [consolidationHistory, setConsolidationHistory] = useState<{
    readonly workspacePath?: string;
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly receipts: readonly RuntimeMemoryConsolidationReceipt[];
    readonly error?: string;
  }>({ status: "idle", receipts: [] });
  const [consolidationRefresh, setConsolidationRefresh] = useState(0);
  const [consolidationNotice, setConsolidationNotice] = useState<ConsolidationNotice>();
  const [undoingBatchId, setUndoingBatchId] = useState<string>();
  const consolidationScope = JSON.stringify([data.picoHome, data.workspacePath, data.trusted]);
  const consolidationScopeRef = useRef({ key: consolidationScope, generation: 0 });
  if (consolidationScopeRef.current.key !== consolidationScope)
    consolidationScopeRef.current = {
      key: consolidationScope,
      generation: consolidationScopeRef.current.generation + 1,
    };
  const consolidationGeneration = consolidationScopeRef.current.generation;
  useEffect(() => {
    setConsolidationNotice(undefined);
    setUndoingBatchId(undefined);
  }, [consolidationScope]);
  useEffect(() => {
    const workspacePath = data.workspacePath;
    if (
      runtime.preview ||
      !actions.queryMemoryConsolidationHistory ||
      !workspacePath ||
      !data.trusted ||
      runtime.connection.kind !== "ready"
    ) {
      setConsolidationHistory({ status: "idle", receipts: [] });
      return;
    }
    let active = true;
    setConsolidationHistory({ workspacePath, status: "loading", receipts: [] });
    void actions
      .queryMemoryConsolidationHistory(workspacePath)
      .then(({ receipts }) => {
        if (active) setConsolidationHistory({ workspacePath, status: "ready", receipts });
      })
      .catch((error: unknown) => {
        if (active)
          setConsolidationHistory({
            workspacePath,
            status: "error",
            receipts: [],
            error: error instanceof Error ? error.message : "读取自动整理记录失败。",
          });
      });
    return () => {
      active = false;
    };
  }, [
    actions.queryMemoryConsolidationHistory,
    consolidationRefresh,
    data.picoHome,
    data.trusted,
    data.workspacePath,
    runtime.connection.kind,
    runtime.preview,
  ]);
  useEffect(() => {
    const requested = searchParams.get("tab");
    if (
      requested === "saved" ||
      requested === "archived" ||
      (requested === "usage" && embedded) ||
      (requested === "pending" && (embedded || experience.supported))
    )
      setActivePanel(requested);
    else if (requested === "native" || (activePanel === "pending" && !experience.supported))
      setActivePanel("saved");
  }, [searchParams, experience.supported, embedded]);
  useEffect(() => {
    if (resolvedTarget?.status !== "ready") return;
    const desired: PanelId = targetCandidate
      ? targetCandidate.lifecycleState === "archived"
        ? "archived"
        : experienceNeedsReview(targetCandidate)
          ? "pending"
          : "saved"
      : targetItem?.lifecycleState === "archived"
        ? "archived"
        : "saved";
    if (searchParams.get("tab") !== desired) {
      const next = new URLSearchParams(searchParams);
      if (next.get("tab") === "native") next.delete("candidate");
      next.set("tab", desired);
      navigate(
        { pathname: location.pathname, search: next.toString(), hash: location.hash },
        { replace: true },
      );
    }
    setActivePanel(desired);
  }, [
    resolvedTarget,
    targetCandidate,
    targetItem,
    searchParams,
    navigate,
    location.pathname,
    location.hash,
  ]);
  const [experienceEditing, setExperienceEditing] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [recordType, setRecordType] = useState("all");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  useEffect(() => {
    setSelectedMemoryId(undefined);
    setListQuery("");
  }, [data.workspacePath, scopeFilter]);
  useEffect(() => {
    if (targetItem && !targetDetail && resolvedTarget?.status === "ready")
      setSelectedMemoryId(targetItem.itemId);
  }, [targetItem, targetDetail, resolvedTarget?.status]);
  const [editor, setEditor] = useState<MemoryEditor>();
  const [editorError, setEditorError] = useState("");
  useEffect(() => {
    if (
      resolvedTarget?.status !== "ready" ||
      !resolvedTarget.item ||
      resolvedTarget.detail ||
      editor
    )
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        `memory-${encodeURIComponent(resolvedTarget.item!.itemId)}`,
      );
      target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTarget, activePanel, editor]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{
    key: string;
    query: string;
    result: RuntimeResult<"memory.context.preview">;
  }>();
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSequence = useRef(0);
  const contextKey = JSON.stringify([
    data.workspacePath,
    data.trusted,
    memory.settings?.version,
    memory.settings?.enabled,
    memory.settings?.recallEnabled,
    memory.pageInfo?.revision,
  ]);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const [announcement, setAnnouncement] = useState("");
  const [draft, setDraft] = useState<{ workspacePath: string; content: string }>();
  const [creationNotice, setCreationNotice] = useState("");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef(false);
  const creatingRef = useRef(false);
  const workspaceRef = useRef(data.workspacePath);
  workspaceRef.current = data.workspacePath;
  const adding = Boolean(draft && draft.workspacePath === data.workspacePath);
  const editing = adding || Boolean(editor) || experienceEditing;
  useEffect(() => {
    onDraftStateChange?.(editing);
    return () => onDraftStateChange?.(false);
  }, [editing, onDraftStateChange]);
  useEffect(() => {
    returnFocusRef.current = false;
    setDraft(undefined);
    setEditor(undefined);
    setEditorError("");
    setQuery("");
    setCreationNotice("");
  }, [data.workspacePath]);
  useEffect(() => {
    previewSequence.current += 1;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(false);
    return () => {
      previewSequence.current += 1;
    };
  }, [contextKey]);
  const clearPreview = () => {
    previewSequence.current += 1;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(false);
  };
  const queryPreview = async () => {
    const submitted = query.trim();
    if (!submitted || !data.workspacePath || !data.trusted) return;
    const sequence = ++previewSequence.current;
    const key = contextKey;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const result = await actions.queryMemoryContext(submitted);
      if (sequence !== previewSequence.current || key !== contextKeyRef.current) return;
      if (result) setPreview({ key, query: submitted, result });
      else setPreviewError("无法读取召回预览，请重试。");
    } catch {
      if (sequence === previewSequence.current && key === contextKeyRef.current)
        setPreviewError("无法读取召回预览，请重试。");
    } finally {
      if (sequence === previewSequence.current && key === contextKeyRef.current)
        setPreviewLoading(false);
    }
  };
  useEffect(() => {
    if (adding) {
      returnFocusRef.current = true;
      contentRef.current?.focus();
    } else if (returnFocusRef.current && !busy) {
      returnFocusRef.current = false;
      addButtonRef.current?.focus();
    }
  }, [adding, busy]);
  const openAdd = () => {
    if (!data.workspacePath || !data.trusted || busy) return;
    setCreationNotice("");
    setDraft({ workspacePath: data.workspacePath, content: "" });
  };
  const cancelAdd = () => {
    if (creatingRef.current) return;
    setDraft(undefined);
  };
  const create = async () => {
    if (!draft || !adding || !draft.content.trim() || busy || creatingRef.current) return;
    const submitted = draft;
    creatingRef.current = true;
    try {
      const item = await actions.createMemoryItem(submitted.content.trim());
      if (!item || workspaceRef.current !== submitted.workspacePath) return;
      setDraft((current) => (current === submitted ? undefined : current));
      setActivePanel("saved");
      setSelectedMemoryId(item.itemId);
      setCreationNotice("记忆已保存到当前工作区。");
      setAnnouncement("记忆已保存到当前工作区。");
      clearPreview();
    } finally {
      creatingRef.current = false;
    }
  };
  const loadedMemoryItems = memory.items.filter((item) => !isLegacyExecutionMemory(item));
  const hasLegacyItems = loadedMemoryItems.length !== memory.items.length;
  const memoryItems = (
    targetItem && !targetDetail
      ? [
          ...memory.items.filter((item) => item.itemId !== targetItem.itemId),
          memory.items.find(
            (item) => item.itemId === targetItem.itemId && item.version > targetItem.version,
          ) ?? targetItem,
        ]
      : memory.items
  ).filter(
    (item) =>
      !isLegacyExecutionMemory(item) &&
      (scopeFilter === "all" || item.scopeType === scopeFilter) &&
      (scopeFilter !== "global" || !item.taskExperience),
  );
  const refreshTargetItem = async (itemId: string) => {
    if (targetItem?.itemId !== itemId || !data.workspacePath) return;
    try {
      const item = await actions.getExperienceMemoryItem(data.workspacePath, itemId);
      if (
        targetScope.current.key === targetKey &&
        targetScope.current.generation === targetGeneration
      )
        setTargetState((current) =>
          current?.key === targetKey && current.generation === targetGeneration
            ? {
                ...current,
                item:
                  item && isLegacyExecutionMemory(item)
                    ? undefined
                    : item && current.item && current.item.version > item.version
                      ? current.item
                      : item,
                status: item ? (isLegacyExecutionMemory(item) ? "legacy" : "ready") : "unavailable",
              }
            : current,
        );
    } catch {
      if (
        targetScope.current.key === targetKey &&
        targetScope.current.generation === targetGeneration
      )
        setTargetState((current) =>
          current?.key === targetKey ? { ...current, status: "error" } : current,
        );
    }
  };
  const selectedRecordType = activePanel === "pending" ? "all" : recordType;
  const filteredExperience = experience.items
    .filter(
      (item) =>
        selectedRecordType === "all" ||
        (selectedRecordType === "method" && item.representation !== "case") ||
        (selectedRecordType === "case" && item.representation === "case"),
    )
    .sort(
      (left, right) =>
        Number(left.representation === "case") - Number(right.representation === "case"),
    );
  const matchesRecordType = (item: MemoryListItem) =>
    (selectedRecordType === "all" ||
      (selectedRecordType === "fact" && !item.taskExperience) ||
      (selectedRecordType === "method" && Boolean(item.taskExperience))) &&
    `${item.content} ${kindLabels[item.kind]}`
      .toLocaleLowerCase()
      .includes(listQuery.trim().toLocaleLowerCase());
  const groups = {
    saved: memoryItems.filter(
      (item) =>
        item.lifecycleState === "active" &&
        matchesRecordType(item) &&
        (!item.taskExperience ||
          !experience.items.some(
            (candidate) => candidate.candidateId === item.taskExperience?.candidateId,
          )),
    ),
    archived: memoryItems.filter(
      (item) =>
        item.lifecycleState === "archived" &&
        matchesRecordType(item) &&
        (!item.taskExperience ||
          !experience.items.some(
            (candidate) => candidate.candidateId === item.taskExperience?.candidateId,
          )),
    ),
  };
  useEffect(() => {
    if (
      data.trusted &&
      data.workspacePath &&
      (memory.workspacePath !== data.workspacePath || memory.status === "idle")
    )
      void actions.refreshMemory();
  }, [actions, data.trusted, data.workspacePath, memory.status, memory.workspacePath]);

  const changeState = async (item: MemoryListItem) => {
    const lifecycleState = item.lifecycleState === "active" ? "archived" : "active";
    if (await actions.updateMemoryItem(item.itemId, item.version, { lifecycleState })) {
      await refreshTargetItem(item.itemId);
      setAnnouncement(lifecycleState === "active" ? "记忆已恢复。" : "记忆已归档，不再参与召回。");
      clearPreview();
    }
  };
  const save = async (item: MemoryListItem) => {
    if (!editor || editor.id !== item.itemId || !editor.content.trim() || busy) return;
    const submitted = editor;
    if (submitted.workspacePath !== data.workspacePath) return;
    setEditorError("");
    const patch: Parameters<typeof actions.updateMemoryItem>[2] = {
      content: submitted.content.trim(),
      statementType: submitted.statementType,
    };
    if (submitted.timeChoice === "clear") {
      Object.assign(patch, { temporalType: "undated", eventStartedAt: null, eventEndedAt: null });
    } else if (submitted.timeChoice !== "preserve") {
      const start = parseEventTime(submitted.start);
      const end =
        submitted.timeChoice === "open_ended" || !submitted.end.trim()
          ? null
          : parseEventTime(submitted.end);
      if (
        start === null ||
        (submitted.timeChoice !== "open_ended" && submitted.end.trim() && end === null) ||
        (end !== null && end <= start) ||
        (submitted.timeChoice === "interval" && end === null)
      ) {
        setEditorError(
          "请填写有效的事件开始时间；结束时间必须晚于开始时间，时间区间必须有结束时间。",
        );
        return;
      }
      Object.assign(patch, {
        temporalType: submitted.timeChoice,
        eventStartedAt: start,
        eventEndedAt: submitted.timeChoice === "open_ended" ? null : end,
      });
    }
    try {
      const updated = await actions.updateMemoryItem(submitted.id, submitted.version, patch);
      if (workspaceRef.current !== submitted.workspacePath) return;
      if (!updated) {
        setEditorError("更正未保存，请检查内容或刷新后重试。输入已保留。");
        return;
      }
      setEditor((current) => (current === submitted ? undefined : current));
      await refreshTargetItem(submitted.id);
      setAnnouncement("记忆已更正。");
      clearPreview();
    } catch {
      if (workspaceRef.current === submitted.workspacePath)
        setEditorError("更正未保存，请检查内容或刷新后重试。输入已保留。");
    }
  };
  const choosePanel = (panel: PanelId) => {
    if (embedded && editing) return;
    setActivePanel(panel);
    if (embedded) {
      const params = new URLSearchParams(location.search);
      if (params.get("tab") === panel) return;
      params.set("tab", panel);
      for (const key of ["item", "candidate", "referenceItemVersion", "referenceContentVersion"])
        params.delete(key);
      navigate(
        { pathname: location.pathname, search: params.toString(), hash: "" },
        { replace: true },
      );
    }
  };
  const deleteItem = async (item: MemoryListItem) => {
    if (
      typeof window === "undefined" ||
      !window.confirm(
        "删除这条记忆？将从长期记忆中删除，无法恢复。原聊天记录仍会保留；之后重新提供或要求记住的信息仍可保存。",
      )
    )
      return;
    if (await actions.deleteMemoryItem(item.itemId, item.version)) {
      if (targetItem?.itemId === item.itemId)
        setTargetState((current) =>
          current?.key === targetKey
            ? { ...current, item: undefined, status: "unavailable" }
            : current,
        );
      setEditor(undefined);
      setAnnouncement("记忆已删除。");
      clearPreview();
    }
  };
  const undoConsolidation = async (batchId: string) => {
    const workspacePath = data.workspacePath;
    if (!workspacePath || undoingBatchId) return;
    const submittedScope = consolidationGeneration;
    setUndoingBatchId(batchId);
    setConsolidationNotice(undefined);
    try {
      const result = await actions.undoMemoryConsolidation(workspacePath, batchId);
      if (consolidationScopeRef.current.generation !== submittedScope) return;
      if (result.status === "undone") {
        setConsolidationNotice({
          tone: "success",
          message: `已撤销本批自动整理，恢复 ${result.receipt.items.length} 条记忆。`,
        });
        void actions.refreshMemory().catch(() => undefined);
      } else if (result.status === "already_undone") {
        setConsolidationNotice({ tone: "success", message: "本批自动整理此前已撤销。" });
      } else if (result.status === "expired") {
        setConsolidationNotice({ tone: "warning", message: "本批整理的 30 天撤销期限已过。" });
      } else if (result.status === "conflict") {
        setConsolidationNotice({
          tone: "error",
          message: `未能撤销：${result.conflicts.length} 条相关记忆已发生变化，当前记录均已保留，没有部分恢复。`,
        });
      } else {
        setConsolidationNotice({
          tone: "warning",
          message: "找不到这批整理记录，可能已过期清理。",
        });
      }
    } catch (error) {
      if (consolidationScopeRef.current.generation !== submittedScope) return;
      setConsolidationNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "撤销自动整理失败，请重试。",
      });
    } finally {
      if (consolidationScopeRef.current.generation === submittedScope) {
        setUndoingBatchId(undefined);
        setConsolidationRefresh((revision) => revision + 1);
      }
    }
  };
  const renderExperience = (filter: Exclude<PanelId, "usage">) => (
    <>
      {experience.loading && experience.items.length === 0 && (
        <p role="status">正在读取任务经验…</p>
      )}
      <TaskExperiencePanel
        key={scopeFilter}
        items={showExperience ? filteredExperience : []}
        learningVersion={experience.learningVersion}
        reuse={experience.reuse}
        searchQuery={listQuery}
        onDraftStateChange={embedded ? setExperienceEditing : undefined}
        selectionLocked={embedded && editing}
        onSelectExperience={embedded ? () => setSelectedMemoryId(undefined) : undefined}
        supplementalRows={embedded ? renderMemoryRows(filter) : undefined}
        supplementalDetail={
          embedded && selectedMemoryId && filter !== "pending"
            ? renderSelectedMemory(filter)
            : undefined
        }
        filter={filter}
        workspacePath={data.workspacePath}
        onDetail={experience.onDetail}
        onReview={reviewExperience}
        onFeedback={experience.onFeedback}
        target={
          showExperience && targetDetail && routeTarget
            ? { key: `${targetKey}:${location.key}`, detail: targetDetail, reference: routeTarget }
            : undefined
        }
        unavailableTarget={
          resolvedTarget?.status === "unavailable"
            ? { key: `${targetKey}:${location.key}`, candidateId: routeTarget?.candidateId }
            : undefined
        }
        targetNavigationKey={routeTarget ? `${targetKey}:${location.key}` : undefined}
      />
    </>
  );
  const panelCount = (panel: PanelId) =>
    panel === "usage"
      ? ledger.uses.length
      : panel === "pending"
        ? pendingCount
        : Math.max(
            (scopeFilter === "all" &&
              selectedRecordType === "all" &&
              !hasLegacyItems &&
              memory.pageInfo?.counts[panel === "saved" ? "active" : "archived"]) ||
              0,
            groups[panel].length +
              (showExperience ? filteredExperience : []).filter((item) =>
                panel === "archived"
                  ? item.lifecycleState === "archived"
                  : isExperienceSuggestion(item) &&
                    experienceIsSaved(item) &&
                    item.lifecycleState === "active",
              ).length,
          );
  const renderMemoryList = (panel: (typeof panels)[number], items = groups[panel]) =>
    items.length ? (
      <div className="memory-list" role="list">
        {items.map((item) => (
          <article
            className="memory-card"
            role="listitem"
            key={item.itemId}
            id={`memory-${encodeURIComponent(item.itemId)}`}
            tabIndex={item.itemId === targetItem?.itemId ? -1 : undefined}
          >
            <header className="memory-card__meta">
              <span>{kindLabels[item.kind]}</span>
              <span>{item.scopeType === "global" ? "全局 · 跨工作区" : "当前工作区"}</span>
              <span>{statementLabels[item.statementType]}</span>
            </header>
            {editor?.id === item.itemId ? (
              <div className="memory-editor">
                <p>
                  更正这条记忆。事件时间默认保留，保存后内容由你确认，旧会话引用不再作为更正内容的来源。
                </p>
                <p>如果情况已经变化，请添加新记忆，必要时单独归档旧条目。</p>
                <div className="settings-field">
                  记忆内容
                  <TextAreaField
                    label="记忆内容"
                    rows={5}
                    maxLength={2000}
                    value={editor.content}
                    onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                  />
                </div>
                <div className="settings-field">
                  陈述类型
                  <SelectField
                    label="更正后的陈述类型"
                    value={editor.statementType}
                    disabled={Boolean(busy)}
                    options={Object.entries(statementLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onValueChange={(value) =>
                      setEditor({
                        ...editor,
                        statementType: value as MemoryEditor["statementType"],
                      })
                    }
                  />
                </div>
                <div className="settings-field">
                  事件时间
                  <SelectField
                    label="更正事件时间"
                    value={editor.timeChoice}
                    disabled={Boolean(busy)}
                    options={[
                      { value: "preserve", label: "保留原事件时间" },
                      { value: "clear", label: "清除事件时间（未注明）" },
                      { value: "point", label: "指定时间点" },
                      { value: "interval", label: "指定时间区间" },
                      { value: "open_ended", label: "指定起点，未注明结束" },
                    ]}
                    onValueChange={(value) =>
                      setEditor({ ...editor, timeChoice: value as TimeChoice })
                    }
                  />
                </div>
                {editor.timeChoice !== "preserve" && editor.timeChoice !== "clear" && (
                  <>
                    <div className="settings-field">
                      事件开始时间（本地时间）
                      <TextField
                        label="更正事件开始时间"
                        type="datetime-local"
                        step="0.001"
                        value={editor.start}
                        disabled={Boolean(busy)}
                        onValueChange={(start) => setEditor({ ...editor, start })}
                      />
                    </div>
                    {editor.timeChoice !== "open_ended" && (
                      <div className="settings-field">
                        事件结束时间（本地时间）{editor.timeChoice === "point" ? "，可留空" : ""}
                        <TextField
                          label="更正事件结束时间"
                          type="datetime-local"
                          step="0.001"
                          value={editor.end}
                          disabled={Boolean(busy)}
                          onValueChange={(end) => setEditor({ ...editor, end })}
                        />
                      </div>
                    )}
                  </>
                )}
                {editorError && <InlineNotice tone="error">{editorError}</InlineNotice>}
              </div>
            ) : (
              <p>{item.content}</p>
            )}
            <SourceDetails item={item} />
            <div className="memory-card__actions">
              {editor?.id === item.itemId ? (
                <>
                  <Button
                    variant="primary"
                    disabled={Boolean(busy) || !editor.content.trim()}
                    onClick={() => void save(item)}
                  >
                    保存更正
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => setEditor(undefined)}
                  >
                    取消
                  </Button>
                </>
              ) : item.taskExperience ? (
                <Button
                  variant="quiet"
                  disabled={experience.loading}
                  onClick={() => void experience.refresh()}
                >
                  重试读取经验管理
                </Button>
              ) : (
                <>
                  <IconButton
                    label={`更正 ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy) || Boolean(editor && editor.id !== item.itemId)}
                    onClick={() => {
                      if (!data.workspacePath || (editor && editor.id !== item.itemId)) return;
                      setEditorError("");
                      setEditor({
                        id: item.itemId,
                        version: item.version,
                        workspacePath: data.workspacePath,
                        content: item.content,
                        statementType: item.statementType,
                        timeChoice: "preserve",
                        start: eventTimeInput(item.eventStartedAt),
                        end: eventTimeInput(item.eventEndedAt),
                      });
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`${item.lifecycleState === "active" ? (item.taskAcceptance || item.executionEvidence ? "归档并停止引用" : "归档") : "恢复"} ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy)}
                    onClick={() => void changeState(item)}
                  >
                    {item.lifecycleState === "active" ? (
                      <Archive aria-hidden="true" />
                    ) : (
                      <ArchiveRestore aria-hidden="true" />
                    )}
                  </IconButton>
                  <IconButton
                    label={`删除记忆 ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy)}
                    onClick={() => void deleteItem(item)}
                  >
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<BrainCircuit aria-hidden="true" />}
        title={
          memory.pageInfo?.nextCursor
            ? `已加载的条目中没有${panelLabels[panel]}记忆`
            : panel === "saved"
              ? "还没有已保存的记忆"
              : "没有已归档的记忆"
        }
        detail={
          memory.pageInfo?.nextCursor
            ? "继续加载可查看后续记忆。"
            : panel === "saved"
              ? "可以手动添加项目约定或偏好，也可以在对话中请 Pico 记住一条信息。"
              : "归档条目不会参与会话召回，可以随时恢复。"
        }
      />
    );
  const renderMemoryRows = (panel: Exclude<PanelId, "usage">) => {
    const query = listQuery.trim().toLocaleLowerCase();
    const items =
      panel === "pending"
        ? []
        : groups[panel].filter((item) =>
            `${item.content} ${kindLabels[item.kind]}`.toLocaleLowerCase().includes(query),
          );
    const matchingExperience =
      showExperience &&
      filteredExperience.some(
        (item) =>
          (panel === "pending"
            ? isExperienceSuggestion(item) && experienceNeedsReview(item)
            : panel === "saved"
              ? isExperienceSuggestion(item) &&
                experienceIsSaved(item) &&
                item.lifecycleState === "active"
              : isExperienceSuggestion(item) && item.lifecycleState === "archived") &&
          `${item.goal} ${item.content}`.toLocaleLowerCase().includes(query),
      );
    return (
      <>
        {items.map((item) => (
          <button
            type="button"
            key={item.itemId}
            className="task-experience__row memory-content__row"
            aria-pressed={selectedMemoryId === item.itemId}
            disabled={editing && selectedMemoryId !== item.itemId}
            onClick={() => {
              if (!editing) setSelectedMemoryId(item.itemId);
            }}
          >
            <span className="task-experience__meta">
              <span>{item.scopeType === "global" ? "全局" : "当前工作区"}</span>
              <span>{kindLabels[item.kind]}</span>
            </span>
            <span className="task-experience__row-title">{memoryItemLabel(item)}</span>
            <span>{item.content}</span>
          </button>
        ))}
        {!items.length && !matchingExperience && (
          <p className="task-experience__placeholder memory-content__empty">
            {query
              ? "没有匹配的记忆或经验。"
              : panel === "pending"
                ? experience.learningVersion === 3
                  ? "没有需要你决定的任务经验。"
                  : "没有待审核的任务经验。"
                : `没有${panelLabels[panel]}的记忆。`}
          </p>
        )}
      </>
    );
  };
  const renderSelectedMemory = (panel: (typeof panels)[number]) => {
    const item = groups[panel].find((item) => item.itemId === selectedMemoryId);
    return item ? renderMemoryList(panel, [item]) : undefined;
  };
  const renderUsage = () => (
    <>
      {ledger.error && (
        <InlineNotice tone="error">
          {ledger.error}{" "}
          <Button variant="quiet" onClick={() => void ledger.refresh()}>
            重试
          </Button>
        </InlineNotice>
      )}
      {embedded &&
        scopeFilter !== "global" &&
        !ledger.uses.length &&
        !ledger.diagnostics.length &&
        !ledger.error && (
          <p className="task-experience__placeholder">
            {ledger.loading ? "正在读取使用记录…" : "当前工作区还没有经验使用记录。"}
          </p>
        )}
      {scopeFilter === "global" ? (
        <p className="task-experience__placeholder">
          任务经验使用记录属于对应工作区，请选择工作区查看。
        </p>
      ) : (
        <ExperienceUsagePanel
          uses={ledger.uses}
          learningVersion={ledger.learningVersion}
          diagnostics={ledger.diagnostics}
          workspacePath={data.workspacePath}
          onDetail={ledger.onDetail}
          onFeedback={ledger.onFeedback}
        />
      )}
      {ledger.hasMore && (
        <Button variant="quiet" disabled={ledger.loading} onClick={() => void ledger.loadMore()}>
          加载更多使用记录
        </Button>
      )}
    </>
  );
  const renderList = (panel: PanelId) => {
    if (panel === "usage") return renderUsage();
    if (embedded) return renderExperience(panel);
    const hasExperience =
      showExperience &&
      ((targetCandidate &&
        (panel === "archived"
          ? targetCandidate.lifecycleState === "archived"
          : experienceIsSaved(targetCandidate) && targetCandidate.lifecycleState === "active")) ||
        experience.items.some(
          (item) =>
            isExperienceSuggestion(item) &&
            (panel === "archived"
              ? item.lifecycleState === "archived"
              : experienceIsSaved(item) && item.lifecycleState === "active"),
        ));
    return (
      <>
        {showExperience && renderExperience(panel)}
        {panel !== "pending" && (groups[panel].length > 0 || !hasExperience)
          ? renderMemoryList(panel)
          : null}
      </>
    );
  };
  const renderConsolidationHistory = () => (
    <section className="memory-maintenance" aria-labelledby="memory-maintenance-title">
      <header className="memory-maintenance__header">
        <div>
          <h3 id="memory-maintenance-title">最近自动整理</h3>
          <p>整理范围：全部工作区的自动提取记忆。每批整理可在 30 天内撤销。</p>
        </div>
        <Button
          variant="quiet"
          disabled={consolidationHistory.status === "loading"}
          onClick={() => setConsolidationRefresh((revision) => revision + 1)}
        >
          <RefreshCw aria-hidden="true" size={14} />
          刷新记录
        </Button>
      </header>
      {consolidationNotice && (
        <InlineNotice tone={consolidationNotice.tone}>{consolidationNotice.message}</InlineNotice>
      )}
      {consolidationHistory.status === "loading" && <p role="status">正在读取自动整理记录…</p>}
      {consolidationHistory.status === "error" && (
        <InlineNotice tone="error">
          {consolidationHistory.error ?? "读取自动整理记录失败。"}{" "}
          <Button
            variant="quiet"
            onClick={() => setConsolidationRefresh((revision) => revision + 1)}
          >
            重试
          </Button>
        </InlineNotice>
      )}
      {consolidationHistory.status === "ready" && consolidationHistory.receipts.length === 0 && (
        <p className="memory-maintenance__empty">暂无自动整理记录。</p>
      )}
      {consolidationHistory.status === "ready" && consolidationHistory.receipts.length > 0 && (
        <div className="memory-maintenance__list" role="list" aria-label="自动整理批次">
          {consolidationHistory.receipts.map((receipt) => {
            const expired = receipt.expiresAt <= Date.now();
            const reasonCounts = receipt.items.reduce<Partial<Record<string, number>>>(
              (counts, item) => ({ ...counts, [item.reason]: (counts[item.reason] ?? 0) + 1 }),
              {},
            );
            return (
              <article className="memory-maintenance__batch" role="listitem" key={receipt.batchId}>
                <div className="memory-maintenance__batch-main">
                  <strong>{formatTime(receipt.createdAt)}</strong>
                  <span>
                    检查 {receipt.consideredCount} 条 · 归档 {receipt.items.length} 条
                  </span>
                  {Object.entries(consolidationReasonLabels).some(
                    ([reason]) => (reasonCounts[reason] ?? 0) > 0,
                  ) && (
                    <ul className="memory-maintenance__reasons" aria-label="归档原因和数量">
                      {Object.entries(consolidationReasonLabels).map(([reason, label]) => {
                        const count = reasonCounts[reason] ?? 0;
                        return count > 0 ? (
                          <li key={reason}>
                            {label} {count} 条
                          </li>
                        ) : null;
                      })}
                    </ul>
                  )}
                  <span className="memory-maintenance__deadline">
                    {receipt.status === "undone"
                      ? `已于 ${formatTime(receipt.undoneAt ?? receipt.createdAt)} 撤销`
                      : expired
                        ? `撤销期限已于 ${formatTime(receipt.expiresAt)} 结束`
                        : `可撤销至 ${formatTime(receipt.expiresAt)}`}
                  </span>
                </div>
                {receipt.status === "undoable" && (
                  <Button
                    variant="quiet"
                    disabled={expired || Boolean(undoingBatchId) || !data.trusted}
                    onClick={() => void undoConsolidation(receipt.batchId)}
                  >
                    {undoingBatchId === receipt.batchId ? "正在撤销…" : "撤销本批整理"}
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <section
      className={`memory-page${embedded ? " memory-page--embedded" : ""}`}
      aria-label={embedded ? "记忆内容管理" : undefined}
      aria-labelledby={embedded ? undefined : "memory-page-title"}
    >
      <header className="memory-page__intro">
        {!embedded && (
          <div>
            <span className="eyebrow">Memory</span>
            <h2 id="memory-page-title">工作区记忆</h2>
            <p>管理已保存的信息。全局记忆可跨工作区使用，归档后不再参与召回。</p>
            <p>
              {hasLegacyItems
                ? `已加载 ${loadedMemoryItems.length} 条可用记忆；旧版经验已隐藏，请更新电脑端完成清理。`
                : memory.pageInfo
                  ? `已加载 ${memory.items.length} / ${memory.pageInfo.counts.total} 条`
                  : `已加载 ${memory.items.length} 条，总数未知；更新电脑端可加载更多`}
            </p>
          </div>
        )}
        <div className="memory-page__actions">
          <Button
            ref={addButtonRef}
            variant="primary"
            disabled={
              Boolean(busy) ||
              !data.trusted ||
              !data.workspacePath ||
              adding ||
              scopeFilter === "global"
            }
            aria-expanded={adding}
            aria-controls="memory-add-form"
            onClick={openAdd}
          >
            <Plus aria-hidden="true" size={14} />
            添加记忆
          </Button>
          <Button
            variant="quiet"
            disabled={Boolean(busy) || !data.trusted}
            onClick={() => void actions.refreshMemory()}
          >
            <RefreshCw aria-hidden="true" size={14} />
            刷新
          </Button>
        </div>
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {/* Action feedback is displayed by the app toast; only memory-scoped load
          errors belong here. A global message may come from another page. */}
      {memory.error && <InlineNotice tone="error">{memory.error}</InlineNotice>}
      {!data.trusted ? (
        <InlineNotice tone="warning">信任当前工作区后可管理记忆。</InlineNotice>
      ) : (
        <>
          {renderConsolidationHistory()}
          {searchParams.get("tab") === "native" && (
            <InlineNotice>
              原生学习入口已合并到工作区记忆。已保存经验与历史使用记录仍可在此管理。
            </InlineNotice>
          )}
          {resolvedTarget?.status === "loading" && <p role="status">正在打开链接目标…</p>}
          {resolvedTarget?.status === "unavailable" && (
            <InlineNotice tone="warning">该经验已删除或不可用，历史使用记录仍保留。</InlineNotice>
          )}
          {resolvedTarget?.status === "legacy" && (
            <InlineNotice tone="warning">旧版经验不可用，请更新电脑端完成清理。</InlineNotice>
          )}
          {resolvedTarget?.status === "retired" && <InlineNotice>旧版经验已移除</InlineNotice>}
          {resolvedTarget?.status === "error" && (
            <InlineNotice tone="error">
              无法读取链接目标，已打开的内容和更正草稿仍保留。{" "}
              <Button variant="quiet" onClick={() => setTargetRetry((value) => value + 1)}>
                重试打开目标
              </Button>
            </InlineNotice>
          )}
          {targetItem && !targetDetail && routeTarget?.referenceItemVersion !== undefined && (
            <InlineNotice>
              跳转来源：引用记忆 v{routeTarget.referenceItemVersion}；当前管理记忆 v
              {targetItem.version}。本页操作作用于当前管理版本，旧使用记录保持原版本。
            </InlineNotice>
          )}
          {experience.error && (
            <InlineNotice tone="error">
              {experience.error}{" "}
              <Button variant="quiet" onClick={() => void experience.refresh()}>
                重试
              </Button>
            </InlineNotice>
          )}
          {experience.supported && memory.settings && !memory.settings.autoExtract && (
            <InlineNotice>
              自动学习已关闭，只停止新提案；仍可审核和管理历史经验。历史引用与效果记录继续，召回由独立开关控制。
            </InlineNotice>
          )}
          {experience.supported &&
            memory.settings &&
            (!memory.settings.enabled || !memory.settings.recallEnabled) && (
              <InlineNotice>
                记忆召回已关闭。已保存的经验仍可管理，开启召回后才会提供给新任务。
              </InlineNotice>
            )}
          {!embedded && renderUsage()}
          {creationNotice && <InlineNotice tone="success">{creationNotice}</InlineNotice>}
          <details className="memory-content__preview" open={embedded ? undefined : true}>
            <summary>召回预览</summary>
            <section className="memory-add-form" aria-labelledby="memory-preview-title">
              <h3 id="memory-preview-title">召回预览</h3>
              <p>输入一个问题，查看当前管理预览中可选入的记忆。此操作不调用模型。</p>
              <p>
                预览不具备具体任务的工具权限、附件和执行范围；需要这些条件的经验可能省略。空结果不代表经验未保存，实际引用以任务中的使用记录为准。
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void queryPreview();
                }}
              >
                <div className="settings-field">
                  预览问题
                  <TextField
                    label="召回预览问题"
                    type="search"
                    maxLength={4096}
                    value={query}
                    onValueChange={(value) => {
                      setQuery(value);
                      clearPreview();
                    }}
                  />
                </div>
                <Button type="submit" disabled={!query.trim() || Boolean(busy)}>
                  {previewLoading ? "正在查询…" : "查询召回"}
                </Button>
              </form>
              {previewError && <InlineNotice tone="error">{previewError}</InlineNotice>}
              {previewLoading && <p role="status">正在读取召回预览…</p>}
              {preview?.key === contextKey && (
                <RecallPreview
                  query={preview.query}
                  result={preview.result}
                  legacyItemIds={memory.items
                    .filter(isLegacyExecutionMemory)
                    .map((item) => item.itemId)}
                />
              )}
            </section>
          </details>
          {adding && draft && (
            <form
              id="memory-add-form"
              className="memory-add-form"
              aria-labelledby="memory-add-title"
              aria-busy={busy === "memory-create"}
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelAdd();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void create();
                }
              }}
            >
              <h3 id="memory-add-title">添加记忆</h3>
              <p id="memory-add-help">
                保存到当前工作区：{data.workspacePath}
                。内容直接保存，不调用模型；在相关对话中按需召回。相同内容会复用已有记忆，归档内容会恢复。
              </p>
              <div className="memory-editor">
                <span className="settings-field-label">记忆内容</span>
                <TextAreaField
                  label="记忆内容"
                  id="memory-add-content"
                  ref={contentRef}
                  rows={4}
                  maxLength={2000}
                  required
                  disabled={Boolean(busy)}
                  aria-describedby="memory-add-help memory-add-length"
                  placeholder="例如：项目发布前必须运行 npm run verify。"
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
                <small id="memory-add-length">{draft.content.length} / 2000</small>
              </div>
              {(!memory.settings?.enabled || !memory.settings?.recallEnabled) &&
                memory.settings && (
                  <InlineNotice>
                    当前记忆或会话召回已关闭，仍可保存；开启后才会参与召回。
                  </InlineNotice>
                )}
              <div className="memory-page__actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={Boolean(busy) || !draft.content.trim()}
                >
                  {busy === "memory-create" ? "保存中…" : "保存记忆"}
                </Button>
                <Button variant="quiet" disabled={Boolean(busy)} onClick={cancelAdd}>
                  取消
                </Button>
              </div>
            </form>
          )}
          {embedded && editing && (
            <p className="memory-content__editing" role="status">
              请先保存或取消当前编辑，再切换条目、标签或范围。
            </p>
          )}
          {(embedded || experience.learningVersion === 3) && (
            <div className="memory-content__search">
              <TextField
                label="搜索记忆内容"
                type="search"
                placeholder="搜索记忆内容"
                value={listQuery}
                onValueChange={setListQuery}
              />
              {experience.learningVersion === 3 &&
                activePanel !== "pending" &&
                activePanel !== "usage" && (
                  <SelectField
                    label="记忆类型"
                    value={recordType}
                    disabled={editing}
                    options={[
                      { value: "all", label: "全部类型" },
                      { value: "fact", label: "事实" },
                      { value: "method", label: "方法建议" },
                      { value: "case", label: "案例" },
                    ]}
                    onValueChange={setRecordType}
                  />
                )}
              <span>搜索当前已加载的记忆与经验</span>
            </div>
          )}
          {embedded || narrow || experience.supported ? (
            <div className="memory-tabs">
              <TabList
                className="memory-tablist"
                role="tablist"
                aria-label="记忆状态"
                value={activePanel}
                onChange={(value) => {
                  choosePanel(value as PanelId);
                }}
              >
                {displayPanels.map((panel) => (
                  <Tab
                    key={panel}
                    value={panel}
                    onFocus={() => {
                      choosePanel(panel);
                    }}
                    id={`memory-tab-${panel}`}
                    panelId={`memory-panel-${panel}`}
                    label={
                      panel === "pending" && experience.learningVersion !== 3
                        ? "待审核"
                        : panelLabels[panel]
                    }
                    endContent={<span className="memory-tab__count">{panelCount(panel)}</span>}
                  />
                ))}
              </TabList>
              <section
                role="tabpanel"
                id={`memory-panel-${activePanel}`}
                aria-labelledby={`memory-tab-${activePanel}`}
                className="memory-panel"
              >
                {renderList(activePanel)}
              </section>
            </div>
          ) : (
            <div
              className="memory-board"
              style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
              aria-label="记忆状态"
            >
              {panels.map((panel) => (
                <section
                  className="memory-column"
                  key={panel}
                  aria-labelledby={`memory-column-${panel}`}
                >
                  <header>
                    <h3 id={`memory-column-${panel}`}>{panelLabels[panel]}</h3>
                    <span aria-label={`${panelCount(panel)} 项`}>{panelCount(panel)}</span>
                  </header>
                  {renderList(panel)}
                </section>
              ))}
            </div>
          )}
          {activePanel !== "usage" && memory.pageInfo?.nextCursor && (
            <Button
              variant="quiet"
              disabled={Boolean(busy) || memory.status === "loading"}
              onClick={() => void actions.loadMoreMemory()}
            >
              {memory.status === "loading" ? "正在加载…" : "加载更多记忆"}
            </Button>
          )}
        </>
      )}
      {!embedded && (
        <Link className="button" to="/settings/memory">
          用户级记忆设置
        </Link>
      )}
    </section>
  );
}

function SourceDetails({ item }: { readonly item: MemoryListItem }) {
  const source = Array.isArray(item.sources) ? item.sources[0] : item.firstSource;
  const sourceCount = Array.isArray(item.sources) ? item.sources.length : item.sourceCount;
  return (
    <details className="memory-source">
      <summary>
        {item.sourceType === "reviewed-reference"
          ? "任务经验 · 审核与验证分别记录"
          : item.sourceType === "execution-validated"
            ? item.taskAcceptance
              ? "历史执行经验 · 仅限定目标验收通过"
              : "执行来源不可用"
            : item.executionEvidence
              ? `执行验证经验（${item.executionEvidence.verificationCount} 次）`
              : item.origin === "user_requested"
                ? source
                  ? "用户保存"
                  : "手动保存"
                : item.origin === "agent_extracted"
                  ? "对话提取"
                  : "来源信息"}
      </summary>
      <dl>
        {typeof sourceCount === "number" && sourceCount > 0 && (
          <div>
            <dt>来源数量</dt>
            <dd>{sourceCount}</dd>
          </div>
        )}
        {source ? (
          <>
            <div>
              <dt>来源会话</dt>
              <dd>{source.sessionId}</dd>
            </div>
            <div>
              <dt>来源引用</dt>
              <dd>{source.eventId}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>来源</dt>
            <dd>{item.origin === "user_requested" ? "手动内容，无会话引用" : "来源详情未提供"}</dd>
          </div>
        )}
        <>
          <div>
            <dt>作用域</dt>
            <dd>{item.scopeType === "global" ? "全局" : "当前工作区"}</dd>
          </div>
          <div>
            <dt>时间类型</dt>
            <dd>{temporalLabels[item.temporalType]}</dd>
          </div>
          <div>
            <dt>{source ? "来源观察时间" : "记录时间"}</dt>
            <dd>{formatTime(item.observedAt)}</dd>
          </div>
          <div>
            <dt>最近修改时间</dt>
            <dd>{formatTime(item.updatedAt)}</dd>
          </div>
          {item.eventStartedAt !== null && (
            <div>
              <dt>开始</dt>
              <dd>{formatTime(item.eventStartedAt)}</dd>
            </div>
          )}
          {item.eventEndedAt !== null && (
            <div>
              <dt>结束</dt>
              <dd>{formatTime(item.eventEndedAt)}</dd>
            </div>
          )}
        </>
      </dl>
      {item.taskAcceptance && (
        <p>
          保存时验收范围：{item.taskAcceptance.targetLabel}。验收摘要：
          {item.taskAcceptance.claimHash}；适用范围摘要：{item.taskAcceptance.scopeHash}
          。这项验收不等于根因或全文已验证。
        </p>
      )}
      {item.executionEvidence && !item.taskAcceptance && (
        <p>旧版执行证据只保留当时记录，验证范围未知；不能视为经验全文已验证。</p>
      )}
      <p>记录和修改时间不代表事实开始生效；事件时间仅表示这条信息注明的发生时间。</p>
    </details>
  );
}
function memoryItemLabel(item: MemoryListItem): string {
  return [...item.content].slice(0, 60).join("") || "记忆";
}
function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN");
}

function eventTimeInput(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(value - date.getTimezoneOffset() * 60_000);
  return Number.isFinite(local.getTime()) ? local.toISOString().slice(0, -1) : "";
}

function parseEventTime(value: string): number | null {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function RecallPreview({
  query,
  result,
  legacyItemIds,
}: {
  query: string;
  result: RuntimeResult<"memory.context.preview">;
  legacyItemIds: readonly string[];
}) {
  const excludedIds = new Set([
    ...legacyItemIds,
    ...result.items.filter(isLegacyExecutionMemory).map((item) => item.itemId),
    ...(result.references ?? [])
      .filter((reference) => reference.source === "execution-evidence")
      .map((reference) => reference.itemId),
  ]);
  const references = result.references?.filter((reference) => !excludedIds.has(reference.itemId));
  const diagnostics = result.diagnostics?.filter(
    (diagnostic) => !excludedIds.has(diagnostic.itemId),
  );
  const hasLegacyReferences = references?.length !== result.references?.length;
  return (
    <div className="memory-preview-result" role="region" aria-label="召回预览结果">
      <p>问题：{query}</p>
      {hasLegacyReferences ? (
        <p>显示 {references?.length ?? 0} 条可用引用；旧版引用已隐藏，请更新电脑端完成清理。</p>
      ) : (
        <p>
          选入 {result.budget.usedItems} / {result.budget.maxItems} 条 · {result.budget.usedTokens}{" "}
          / {result.budget.maxTokens} Token
          {result.budget.truncated ? " · 部分候选未选入" : ""}
        </p>
      )}
      {references === undefined ? (
        <p>当前服务未提供实际引用详情，请更新电脑端后重试。</p>
      ) : references.length === 0 ? (
        <p>
          当前管理预览没有选入记忆。条目可能未匹配、召回已关闭，或需要具体任务的工具权限、附件和适用范围。
        </p>
      ) : (
        <div className="memory-list">
          {references.map((reference) => (
            <article className="memory-card" key={reference.itemId}>
              <header className="memory-card__meta">
                <span>{sourceLabels[reference.source]}</span>
                <span>{matchLabels[reference.match]}</span>
              </header>
              <p>{reference.content}</p>
              <small>
                条目：{reference.itemId} · {reference.excerpt ? "原文节选" : "完整引用"} · 字符范围
                [{reference.range.start}, {reference.range.end}) / {reference.range.total}
              </small>
            </article>
          ))}
        </div>
      )}
      {(diagnostics?.length ?? 0) > 0 && (
        <details className="memory-source">
          <summary>候选说明</summary>
          {diagnostics?.map((diagnostic) => (
            <p key={`${diagnostic.itemId}:${diagnostic.reason}`}>
              {diagnostic.itemId}：{diagnosticLabels[diagnostic.reason]} ·{" "}
              {matchLabels[diagnostic.match]}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
