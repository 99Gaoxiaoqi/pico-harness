import { PendingSendNotice } from "../PendingSendNotice.js";
import {
  getComposerResources,
  parseComposerDraft,
  validateComposerReferences,
} from "../conversation/composer-references.js";
import { useDesktopCommands, isDesktopCommandInput } from "../conversation/useDesktopCommands.js";
import { applyConversationSettings } from "../conversation/conversation-settings.js";
import { useConversationGoal } from "../conversation/ConversationGoalControls.js";
import { ComposerContextGauge } from "../conversation/ComposerContextGauge.js";
import { DeepResearchPanel } from "../conversation/DeepResearchPanel.js";
import { ConversationActionsMenu } from "../conversation/ConversationActionsMenu.js";
import {
  subagentMetadata,
  subagentParent,
  subagentSessionHref,
} from "../conversation/subagent-navigation.js";
import type { RuntimeResult, RuntimeUserDefaults } from "@pico/protocol";
import {
  AlertTriangle,
  Bot,
  Code2,
  FileDiff,
  Folder,
  FolderGit2,
  GitFork,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Search,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { parseModelRoutes } from "../runtime-projections/configuration.js";
import { isRecord } from "../runtime-projections/values.js";
import { SelectField, TextField } from "../ui-controls.js";
import { ComposerModelPicker } from "../ComposerModelPicker.js";
import { Button, InlineNotice, PreviewBadge, StatusPill } from "../components.js";
import { ConversationGraphBoard } from "../conversation/ConversationGraphBoard.js";
import {
  ConversationComposer,
  ConversationInteractionSlot,
  ConversationSurface,
  ConversationTranscript,
  mergeConversationItemGroups,
  omitApprovalAuditItems,
  removeSupersededActiveTools,
  usePersistentDraft,
  writePersistentDraft,
  type ComposerBehavior,
  type ConversationComposerHandle,
  type ConversationInspectorView,
  type ConversationItemView,
} from "../conversation/index.js";
import { pendingToolApprovalFromTranscript } from "../conversation/runtime-projection.js";
import { ProviderFailureCard, ProviderRetryBanner } from "../conversation/ProviderRequestStatus.js";
import {
  modelCommunicationDiagnostic,
  providerRetryKey,
  providerStatusDiagnostic,
} from "../provider-retry.js";
import type { ApprovalView, TimelineItem, ToolApprovalView } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import { ConversationQueue } from "../conversation/ConversationQueue.js";
import { formatCompact, isTerminalRun } from "../view-format.js";
import { copyText } from "../clipboard.js";
import { BrowserWorkbarPanel } from "../workbar-panels/BrowserWorkbarPanel.js";
import { SideChatPanelController } from "../workbar-panels/SideChatPanelController.js";
import {
  WorkbarPanelHost,
  stopWorkbarTerminalInstance,
  type WorkbarPanelHostKind,
} from "../workbar-panels/WorkbarPanelHost.js";
import { isBrowserPanelActive } from "../workbar-panels/browser-agent-lease-controller.js";
import {
  SessionWorkbarLayout,
  WorkbarLauncher,
  createWorkbarToolTab,
  getWorkbarTool,
  isWorkbarPanelActive,
  resolveWorkbarShortcut,
  saveWorkbarState,
  type WorkbarAction,
  type WorkbarTab,
  type WorkbarToolKind,
} from "../workbar/index.js";
import { useSessionWorkbar } from "../workbar/useSessionWorkbar.js";
import { TrustWorkspace } from "../workspace-access.js";
import {
  newSessionHref,
  sessionHref,
  workspaceDisplayName,
  workspaceName,
  workspacePathFromSearch,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "../workspace-session.js";

const CHOOSE_PROJECT_OPTION_VALUE = "__choose-project__";

const TEMPORARY_PROJECT_OPTION_VALUE = "__temporary-project__";

const PERMISSION_MODE_LABELS = {
  ask: "请求批准",
  auto: "帮我批准",
  "full-access": "完全访问权限",
} as const;

export function NewTaskPage() {
  const { data, actions } = useRuntime();
  const location = useLocation();
  const workspacePath = workspacePathFromSearch(location.search);
  const workspace = data.workspaces.find((candidate) => candidate.path === workspacePath);

  useEffect(() => {
    if (workspacePath && workspace && data.workspacePath !== workspacePath) {
      void actions.selectWorkspace(workspacePath);
    }
    return undefined;
  }, [actions, data.workspacePath, workspace, workspacePath]);

  if (workspacePath && !workspace) {
    return <Navigate replace to="/task/new" />;
  }
  if (workspacePath && workspace && data.workspacePath === workspacePath && !data.trusted) {
    return <TrustWorkspace workspacePath={workspacePath} />;
  }
  return <ConversationPage />;
}

export function ConversationPage() {
  const { sessionId } = useParams();
  const runtime = useRuntime();
  const { data, actions, busy, preview, message } = runtime;
  const location = useLocation();
  const navigate = useNavigate();
  const graphParentId = new URLSearchParams(location.search).get("graphParent");
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessionRef = useMemo<WorkspaceSessionRef | undefined>(
    () => (sessionId && workspacePath ? { workspacePath, sessionId } : undefined),
    [sessionId, workspacePath],
  );
  const conversationKey = sessionRef ? workspaceSessionKey(sessionRef) : undefined;
  const childParent = sessionRef
    ? subagentParent(location.search, sessionRef, data.conversations)
    : undefined;
  const parentRef =
    childParent ?? (graphParentId ? { workspacePath, sessionId: graphParentId } : undefined);
  const parentTitle = parentRef
    ? (data.sessions.find(
        (candidate) =>
          candidate.id === parentRef.sessionId &&
          candidate.workspacePath === parentRef.workspacePath,
      )?.title ?? "父任务")
    : undefined;
  const draftKey = conversationKey ?? `new:${workspacePath || "unbound"}`;
  const pendingSend = runtime.pendingSends?.find(
    (entry) => entry.scope.picoHome === data.picoHome && entry.scope.sourceKey === draftKey,
  );
  const researchSourceKey = `research-implement:${conversationKey ?? workspacePath}`;
  const pendingResearchSend = runtime.pendingSends?.find(
    (entry) =>
      entry.scope.picoHome === data.picoHome && entry.scope.sourceKey === researchSourceKey,
  );
  const {
    value: draft,
    update: handleDraftChange,
    clear: clearDraft,
    clearIfUnchanged,
  } = usePersistentDraft(draftKey);
  const composerInputRef = useRef<ConversationComposerHandle>(null);
  const [editingUserMessage, setEditingUserMessage] = useState<{
    readonly item: Extract<ConversationItemView, { kind: "userMessage" }>;
    readonly previousDraft: string;
  }>();
  const revisionRequestRef = useRef<{ readonly text: string; readonly key: string } | undefined>(
    undefined,
  );
  const [behavior, setBehavior] = useState<ComposerBehavior>("steer");
  const [inspector, setInspector] = useState<ConversationInspectorView>();
  const [inspectorTab, setInspectorTab] = useState<"timeline" | "overview">("timeline");
  useEffect(() => setInspectorTab("timeline"), [workspacePath, sessionId]);

  const [workbar, dispatchWorkbar] = useSessionWorkbar(draftKey);
  const [workbarError, setWorkbarError] = useState<string>();
  const closingTerminalTabsRef = useRef(new Set<string>());
  const wasWorkbarCollapsedRef = useRef(workbar.collapsed);
  useEffect(() => {
    const collapsed = workbar.collapsed && !wasWorkbarCollapsedRef.current;
    wasWorkbarCollapsedRef.current = workbar.collapsed;
    if (!collapsed) return;
    const frame = window.requestAnimationFrame(() =>
      document.getElementById("workbar-toggle-right")?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [workbar.collapsed]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [referenceError, setReferenceError] = useState<string>();
  const [promptAnchors, setPromptAnchors] = useState<
    RuntimeResult<"session.transcript.anchors">["anchors"]
  >([]);
  const [promptAnchorCursor, setPromptAnchorCursor] = useState<number>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    RuntimeResult<"session.transcript.search">["hits"]
  >([]);
  const [searchCursor, setSearchCursor] = useState<number>();
  const [searchPending, setSearchPending] = useState(false);
  const [highlightItemId, setHighlightItemId] = useState<string>();
  const [sideChatQuoteRequest, setSideChatQuoteRequest] = useState<
    { readonly panelId: string; readonly id: string; readonly text: string } | undefined
  >();
  const draftReferences = parseComposerDraft(draft);
  const composerResources = getComposerResources(data, workspacePath);
  const sendingRef = useRef(false);
  const temporaryPathRef = useRef<string | undefined>(undefined);
  const [preparingSend, setPreparingSend] = useState(false);
  const sendRouteRef = useRef(draftKey);
  sendRouteRef.current = draftKey;
  useEffect(() => {
    sendRouteRef.current = draftKey;
    return () => {
      sendRouteRef.current = "";
    };
  }, [draftKey]);
  useEffect(() => {
    temporaryPathRef.current = undefined;
  }, [draftKey]);
  const firstSendSourceRef = useRef<string | undefined>(undefined);
  const firstSendBaselineRef = useRef<ReadonlySet<string>>(new Set());
  const [awaitingFirstSession, setAwaitingFirstSession] = useState(false);

  useEffect(() => {
    if (sessionRef) void actions.loadSession(sessionRef);
  }, [actions, sessionRef]);

  useEffect(() => {
    setInspector(undefined);
    setEditingTitle(false);
    setEditingUserMessage(undefined);
    revisionRequestRef.current = undefined;
    setReferenceError(undefined);
    setWorkbarError(undefined);
    setPromptAnchors([]);
    setPromptAnchorCursor(undefined);
    setSearchQuery("");
    setSearchResults([]);
    setSearchCursor(undefined);
    setHighlightItemId(undefined);
    setSideChatQuoteRequest(undefined);
  }, [sessionId, workspacePath]);

  useEffect(() => {
    if (!sessionRef) return;
    let current = true;
    void actions.loadTranscriptAnchors(sessionRef).then((result) => {
      if (!current || !result) return;
      setPromptAnchors(result.anchors);
      setPromptAnchorCursor(result.nextBeforeSequence);
    });
    return () => {
      current = false;
    };
  }, [actions, sessionRef]);

  useEffect(() => {
    if (!sessionRef || !searchQuery.trim()) {
      setSearchResults([]);
      setSearchCursor(undefined);
      setSearchPending(false);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setSearchPending(true);
      void actions
        .searchTranscript(sessionRef, searchQuery)
        .then((result) => {
          if (!current || !result) return;
          setSearchResults(result.hits);
          setSearchCursor(result.nextBeforeSequence);
        })
        .finally(() => {
          if (current) setSearchPending(false);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [actions, searchQuery, sessionRef]);

  useEffect(() => {
    if (typeof window !== "undefined") saveWorkbarState(window.localStorage, workbar);
  }, [workbar]);

  useEffect(
    () => () => dispatchWorkbar({ type: "close", tabId: "inspector-preview" }),
    [dispatchWorkbar],
  );

  useEffect(() => {
    if (!inspector) {
      dispatchWorkbar({ type: "close", tabId: "inspector-preview" });
      return;
    }
    dispatchWorkbar({
      type: "openPreview",
      tab: { id: "inspector-preview", kind: "inspector", label: inspector.title },
    });
  }, [inspector]);

  const session =
    data.sessions.find((item) => item.workspacePath === workspacePath && item.id === sessionId) ??
    (conversationKey ? data.conversations[conversationKey]?.session : undefined);
  const workspace = data.workspaces.find((candidate) => candidate.path === workspacePath);
  const projectWorkspaceOptions = data.workspaces.filter(
    (candidate) => candidate.temporary !== true,
  );
  const workspaceLabel = workspaceDisplayName(workspacePath, workspace);
  const projectLabel = workspace?.projectName ?? session?.projectName ?? workspaceLabel;
  const conversation = conversationKey ? data.conversations[conversationKey] : undefined;
  const sessionRuns = data.runs.filter(
    (run) => run.workspacePath === workspacePath && run.sessionId === sessionId,
  );
  const activeRun = sessionRuns.find((run) => !isTerminalRun(run.status));
  const retryState = activeRun
    ? data.providerRetries[providerRetryKey(workspacePath, activeRun.id)]
    : undefined;
  const retryNotice = retryState?.notice?.sessionId === sessionId ? retryState?.notice : undefined;
  const composerStatus = activeRun
    ? activeRun.status === "paused" || activeRun.status === "pause_requested"
      ? activeRun.status
      : "running"
    : "idle";
  const [newTaskSettingOverrides, setNewTaskSettingOverrides] = useState<
    Readonly<Record<string, RuntimeUserDefaults>>
  >({});
  const newTaskModelRoutes = useMemo(() => {
    if (workspacePath && data.modelRoutes.length) return data.modelRoutes;
    const globalRoutes = parseModelRoutes({
      providers: data.providerConfig.providers.filter((provider) => provider.origin === "user"),
    });
    return globalRoutes.length ? globalRoutes : data.modelRoutes;
  }, [workspacePath, data.modelRoutes, data.providerConfig.providers]);
  const newTaskSettings = useMemo<RuntimeUserDefaults>(() => {
    const defaults = data.providerConfig.userDefaults;
    const modelRouteId =
      defaults.modelRouteId ?? data.providerConfig.defaultModelRouteId ?? newTaskModelRoutes[0]?.id;
    return {
      ...(modelRouteId ? { modelRouteId } : {}),
      collaborationMode: defaults.collaborationMode ?? "agent",
      orchestrationMode: defaults.orchestrationMode ?? "default",
      permissionMode: defaults.permissionMode ?? "ask",
      // Inherited reasoning preferences are coordinated by the Host against the selected
      // route. Sending them as an explicit override would bypass that reconciliation.
      ...newTaskSettingOverrides[workspacePath || "unbound"],
    };
  }, [
    newTaskModelRoutes,
    data.providerConfig.defaultModelRouteId,
    data.providerConfig.userDefaults,
    newTaskSettingOverrides,
    workspacePath,
  ]);
  const updateNewTaskSettings = useCallback(
    (patch: RuntimeUserDefaults) => {
      setNewTaskSettingOverrides((current) => {
        const key = workspacePath || "unbound";
        const next = { ...current[key], ...patch };
        // A model change returns reasoning to the Host's model-specific default.
        if (patch.modelRouteId !== undefined || patch.thinkingEffort === "") {
          delete next.thinkingEffort;
        }
        return { ...current, [key]: next };
      });
    },
    [workspacePath],
  );
  const researchActive =
    (sessionId ? conversation?.settings?.collaborationMode : newTaskSettings.collaborationMode) ===
    "research";
  const composerModelRouteId = conversation?.settings?.modelRouteId ?? newTaskSettings.modelRouteId;
  const composerProvider = data.providerConfig.providers.find((provider) =>
    composerModelRouteId?.startsWith(`${provider.id}/`),
  );
  const composerModel =
    composerProvider && composerModelRouteId
      ? composerModelRouteId.slice(composerProvider.id.length + 1)
      : "";
  const composerCapabilities = composerProvider?.resolvedModelCapabilities?.[composerModel];
  const newTaskReasoningLevels =
    isRecord(composerCapabilities) && Array.isArray(composerCapabilities.reasoningLevels)
      ? composerCapabilities.reasoningLevels.filter(
          (level): level is string => typeof level === "string",
        )
      : [];
  const usingOpenCodeFree =
    composerProvider?.auth === "none" &&
    composerProvider.baseURL.replace(/\/+$/u, "") === "https://opencode.ai/zen/v1";

  const runIds = useMemo(() => new Set(sessionRuns.map((run) => run.id)), [sessionRuns]);
  const persistedPendingApproval = activeRun
    ? pendingToolApprovalFromTranscript(conversation?.items ?? [], activeRun.id)
    : undefined;
  const persistedApprovalView: ToolApprovalView | undefined =
    persistedPendingApproval?.toolName && persistedPendingApproval.providerCallId && activeRun
      ? {
          id: persistedPendingApproval.id.slice("approval:".length),
          runId: activeRun.id,
          sessionId,
          title: persistedPendingApproval.title,
          detail: persistedPendingApproval.detail,
          risk: persistedPendingApproval.risk ?? "medium",
          kind: "tool",
          toolName: persistedPendingApproval.toolName,
          providerCallId: persistedPendingApproval.providerCallId,
          command: persistedPendingApproval.command,
          diff: persistedPendingApproval.diff,
          sessionScope: persistedPendingApproval.sessionScope,
        }
      : undefined;
  const pendingApproval: ApprovalView | undefined =
    data.approvals
      .filter(
        (item) => runIds.has(item.runId) && (item.kind === "plan" || item.runId === activeRun?.id),
      )
      .at(-1) ??
    persistedApprovalView ??
    data.approvals.findLast((item) => item.kind === "plan" && item.sessionId === sessionId);
  const pendingPrompt = data.prompts.filter((item) => runIds.has(item.runId)).at(-1);
  const legacyStorageBlocked = Boolean(
    workspacePath &&
    message?.startsWith("Legacy session-centric (JSONL) workspace storage exists:") &&
    message.includes(`/workspaces/${workspaceName(workspacePath)}-`),
  );
  const workspaceReady = Boolean(
    workspacePath && data.workspacePath === workspacePath && data.trusted && !legacyStorageBlocked,
  );

  const composerReady = workspaceReady || (!sessionId && !workspacePath);

  useEffect(() => {
    if (
      !awaitingFirstSession ||
      sessionId ||
      !workspacePath ||
      firstSendSourceRef.current !== draftKey
    )
      return;
    const createdSession = data.sessions
      .filter(
        (candidate) =>
          candidate.workspacePath === workspacePath &&
          !firstSendBaselineRef.current.has(candidate.id),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!createdSession) return;
    setAwaitingFirstSession(false);
    navigate(
      sessionHref({ workspacePath: createdSession.workspacePath, sessionId: createdSession.id }),
      { replace: true },
    );
  }, [awaitingFirstSession, data.sessions, draftKey, navigate, sessionId, workspacePath]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(session?.title ?? "");
  }, [editingTitle, session?.title]);

  const items = useMemo<readonly ConversationItemView[]>(() => {
    const persisted = removeSupersededActiveTools(conversation?.items ?? []).filter(
      (item) =>
        Boolean(activeRun) ||
        !((item.kind === "approval" || item.kind === "prompt") && item.state === "pending"),
    );
    const live = activeRun
      ? data.timeline
          .filter((item) => item.runId === activeRun.id)
          .map(timelineItemToConversationItem)
      : [];
    const runIds = new Set(sessionRuns.map((run) => run.id));
    const decisions: ConversationItemView[] = [
      ...data.approvals
        .filter((approval) => runIds.has(approval.runId))
        .map(
          (approval): ConversationItemView => ({
            id: `approval:${approval.id}`,
            kind: "approval",
            title: approval.title,
            detail: approval.detail,
            state: "pending",
          }),
        ),
      ...data.prompts
        .filter((prompt) => runIds.has(prompt.runId))
        .map(
          (prompt): ConversationItemView => ({
            id: `prompt:${prompt.id}`,
            kind: "prompt",
            question: prompt.question,
            state: "pending",
          }),
        ),
    ];
    const goal =
      conversation?.goalItem && !persisted.some((item) => item.id === conversation.goalItem?.id)
        ? [conversation.goalItem]
        : [];
    const discovery = conversation?.discoveryItem ? [conversation.discoveryItem] : [];
    return omitApprovalAuditItems(
      mergeConversationItemGroups(persisted, goal, discovery, live, decisions),
      pendingApproval?.providerCallId,
    );
  }, [
    activeRun,
    data.approvals,
    pendingApproval?.providerCallId,
    conversation,
    data.prompts,
    data.timeline,
    sessionId,
    sessionRuns,
  ]);

  const commands = useDesktopCommands({
    runtime,
    workspacePath,
    sessionId,
    running: Boolean(activeRun),
    initialSettings: newTaskSettings,
    draft,
    onConsumeDraft: clearDraft,
    onInitialSettings: updateNewTaskSettings,
    onOpenGoal: () => goalControls.openDialog(),
    onGoalControl: (input) => goalControls.control(input),
    onOpenModel: () => setModelOpenRequest((value) => value + 1),
    onOpenControl: (target) => composerInputRef.current?.openControl(target) ?? false,
    onOpenResource: (kind) => composerInputRef.current?.openResources(kind),
    onDraftChange: handleDraftChange,
    blocked: Boolean(pendingPrompt || pendingApproval),
  });

  const submit = async (text: string, nextBehavior: ComposerBehavior) => {
    if (sendingRef.current || commands.pending) return;
    if (editingUserMessage) {
      if (!sessionRef || !text.trim()) return;
      setReferenceError(undefined);
      sendingRef.current = true;
      setPreparingSend(true);
      if (revisionRequestRef.current?.text !== text) {
        revisionRequestRef.current = { text, key: globalThis.crypto.randomUUID() };
      }
      try {
        await reviseUserMessage(editingUserMessage.item, text, revisionRequestRef.current.key);
      } catch (error) {
        actions.showMessage?.(
          error instanceof Error ? error.message : "编辑并重发失败，请检查连接后重试。",
        );
      } finally {
        sendingRef.current = false;
        setPreparingSend(false);
      }
      return;
    }
    const parsedDraft = parseComposerDraft(text);
    const referenceFailure = validateComposerReferences(
      parsedDraft.references,
      composerResources.skills,
      composerResources.agents,
    );
    if (referenceFailure) {
      setReferenceError(referenceFailure);
      return;
    }
    if (!parsedDraft.references.length && isDesktopCommandInput(text)) {
      await commands.execute(text);
      return;
    }
    if (
      !composerReady ||
      !composerModelRouteId ||
      usingOpenCodeFree ||
      (!parsedDraft.text && !parsedDraft.references.some((ref) => ref.kind === "skill"))
    )
      return;
    if (pendingSend) {
      actions.showMessage?.("请先恢复发送结果或放弃恢复，再发送这份草稿。");
      return;
    }
    setReferenceError(undefined);
    sendingRef.current = true;
    setPreparingSend(true);
    const sourceDraftKey = draftKey;
    if (!sessionId && workspacePath) {
      firstSendSourceRef.current = sourceDraftKey;
      firstSendBaselineRef.current = new Set(
        data.sessions
          .filter((candidate) => candidate.workspacePath === workspacePath)
          .map((candidate) => candidate.id),
      );
      setAwaitingFirstSession(true);
    }
    try {
      const targetWorkspacePath =
        workspacePath || temporaryPathRef.current || (await actions.ensureTemporaryWorkspace());
      if (!targetWorkspacePath || sendRouteRef.current !== sourceDraftKey) {
        setAwaitingFirstSession(false);
        return;
      }
      if (!workspacePath) temporaryPathRef.current = targetWorkspacePath;
      const result = await actions.sendMessage({
        workspacePath: targetWorkspacePath,
        sourceKey: sourceDraftKey,
        draftSnapshot: draft,
        ...(sessionId ? { sessionId } : {}),
        ...(!sessionId ? { initialSettings: newTaskSettings } : {}),
        text: parsedDraft.text,
        behavior: nextBehavior,
        ...(activeRun ? { expectedRunId: activeRun.id } : {}),
        ...(parsedDraft.references.some((ref) => ref.kind === "skill")
          ? {
              skills: parsedDraft.references
                .filter((ref) => ref.kind === "skill")
                .map(({ name, sourceId, sourcePath }) => ({
                  name,
                  ...(sourceId ? { sourceId } : {}),
                  ...(sourcePath ? { sourcePath } : {}),
                })),
            }
          : {}),
        ...(parsedDraft.references[0]?.kind === "agent"
          ? { activation: parsedDraft.references[0] }
          : {}),
      });
      if (!result.succeeded) {
        setAwaitingFirstSession(false);
        return;
      }
      clearIfUnchanged(draft);
      if (sendRouteRef.current !== sourceDraftKey) return;
      setReferenceError(undefined);
      if (!sessionId && result.sessionId) {
        setAwaitingFirstSession(false);
        navigate(
          sessionHref({
            workspacePath: result.workspacePath ?? targetWorkspacePath,
            sessionId: result.sessionId,
          }),
          { replace: true },
        );
      }
    } finally {
      sendingRef.current = false;
      firstSendSourceRef.current = undefined;
      setAwaitingFirstSession(false);
      setPreparingSend(false);
    }
  };

  const openCatalog = () => composerInputRef.current?.openResources("skill");

  const changePlanMode = async (active: boolean) => {
    await applyConversationSettings(
      runtime,
      sessionRef,
      newTaskSettings,
      { collaborationMode: active ? "plan" : "agent" },
      updateNewTaskSettings,
    );
  };

  const changeResearchMode = async (active: boolean) => {
    const patch = {
      collaborationMode: active ? ("research" as const) : ("agent" as const),
      orchestrationMode: "default" as const,
    };
    setReferenceError(undefined);
    await applyConversationSettings(
      runtime,
      sessionRef,
      newTaskSettings,
      patch,
      updateNewTaskSettings,
    );
  };

  const implementResearch = async (prompt: string) => {
    const sourceDraftKey = draftKey;
    if (pendingResearchSend) throw new Error("实施任务的发送待确认，请先恢复发送结果或放弃恢复。");
    writePersistentDraft(researchSourceKey, prompt);
    const result = await actions.sendMessage({
      workspacePath,
      sourceKey: researchSourceKey,
      draftSnapshot: prompt,
      text: prompt,
      initialSettings: {
        ...newTaskSettings,
        collaborationMode: "agent",
        orchestrationMode: "default",
        ...(conversation?.settings?.modelRouteId
          ? { modelRouteId: conversation.settings.modelRouteId }
          : {}),
      },
    });
    if (sendRouteRef.current !== sourceDraftKey) return;
    if (!result.succeeded || !result.sessionId)
      throw new Error("实施任务发送未确认，请查看待确认发送列表；原请求可能已经执行。");
    navigate(
      sessionHref({
        workspacePath: result.workspacePath ?? workspacePath,
        sessionId: result.sessionId,
      }),
    );
  };

  const changeGraphMode = async (active: boolean, mode: "graph" | "swarm" = "graph") => {
    if (active && researchActive) {
      actions.showMessage?.("研究模式不启动 Graph/Swarm。请完成研究后新建实施任务。");
      return;
    }
    const orchestrationMode = active ? mode : "default";
    if (!sessionRef) {
      updateNewTaskSettings({ orchestrationMode });
      return;
    }
    await actions.updateSessionSettings(sessionRef, { orchestrationMode });
  };

  const chooseProjectFolder = async () => {
    const sourceDraftKey = draftKey;
    const path = await actions.chooseWorkspace();
    if (path && sendRouteRef.current === sourceDraftKey) {
      setNewTaskSettingOverrides((current) => ({ ...current, [path]: newTaskSettings }));
      if (draft) writePersistentDraft(`new:${path}`, draft);
      navigate(newSessionHref(path));
    }
  };

  const openItem = (item: ConversationItemView) => {
    if (item.kind === "approval") {
      document.querySelector(".conversation-interaction-slot")?.scrollIntoView({ block: "end" });
      return;
    }
    if (item.kind === "prompt") {
      document.querySelector(".conversation-interaction-slot")?.scrollIntoView({ block: "end" });
      return;
    }
    if (item.kind === "changes") {
      const params = new URLSearchParams({ workspace: workspacePath });
      if (sessionId) params.set("sessionId", sessionId);
      navigate(`/review?${params.toString()}`);
      return;
    }
    if (item.kind === "discovery" && sessionId) {
      setInspector({
        title: "代码探索",
        subtitle: `${item.depth} · ${item.phase} · ${item.status}`,
        content: (
          <div>
            <p>{item.objective}</p>
            <p>
              {item.inspectedFiles} 个文件 · {item.evidenceCount} 条证据 · {item.openQuestions}{" "}
              个待确认问题
            </p>
            {item.reason && <p>{item.reason}</p>}
          </div>
        ),
      });
      return;
    }
    if (item.kind === "tool") {
      const result = item.result;
      const evidenceUri = result?.evidence?.uri;
      const inspectorContent = (content: string) => (
        <div>
          {result && (
            <p>
              状态：{result.status} · 原始大小：{result.rawSizeBytes} bytes · SHA-256：
              <code>{result.sha256}</code>
              {result.deliveryTruncated ? " · Host 投影已截断" : ""}
            </p>
          )}
          {evidenceUri && <p>旧 Evidence 引用（仅保留元数据，不可回读）：{evidenceUri}</p>}
          <pre className="conversation-inspector-output">{content}</pre>
        </div>
      );
      setInspector({
        title: item.title,
        subtitle: item.toolName,
        content: inspectorContent(item.output ?? item.detail ?? "没有可显示的输出。"),
      });
      return;
    }
    if (item.kind === "subagent") {
      if (!sessionRef) return;
      const href = subagentSessionHref(item, sessionRef);
      if (href) navigate(href);
    }
  };

  const jumpToTranscriptItem = async (itemId: string) => {
    if (!sessionRef) return;
    if (!(await actions.loadTranscriptAround(sessionRef, itemId))) return;
    setHighlightItemId(undefined);
    window.requestAnimationFrame(() => setHighlightItemId(itemId));
  };

  const loadMorePromptAnchors = async () => {
    if (!sessionRef || promptAnchorCursor === undefined) return;
    const result = await actions.loadTranscriptAnchors(sessionRef, promptAnchorCursor);
    if (!result) return;
    setPromptAnchors((current) => [...current, ...result.anchors]);
    setPromptAnchorCursor(result.nextBeforeSequence);
  };

  const loadMoreSearchResults = async () => {
    if (!sessionRef || searchCursor === undefined || !searchQuery.trim()) return;
    const result = await actions.searchTranscript(sessionRef, searchQuery, searchCursor);
    if (!result) return;
    setSearchResults((current) => [...current, ...result.hits]);
    setSearchCursor(result.nextBeforeSequence);
  };

  const quoteIntoMainComposer = (text: string) => {
    const quoted = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    composerInputRef.current?.insertText(`${draft.trim() ? "\n\n" : ""}${quoted}\n\n`);
    composerInputRef.current?.focus();
  };

  const quoteIntoSideChat = (text: string) => {
    if (!sessionId) {
      actions.showMessage?.("请先打开一个会话，再使用侧聊引用。");
      quoteIntoMainComposer(text);
      return;
    }
    const panelId = `side-chat:${globalThis.crypto.randomUUID()}`;
    const tab: WorkbarTab = { id: panelId, kind: "side-chat", label: "侧聊" };
    setSideChatQuoteRequest({ panelId, id: globalThis.crypto.randomUUID(), text });
    dispatchWorkbar({ type: "open", tab });
  };

  const reviseUserMessage = async (
    item: Extract<ConversationItemView, { kind: "userMessage" }>,
    replacementText: string,
    idempotencyKey: string,
  ): Promise<boolean> => {
    if (!sessionRef) return false;
    const prefix = "message:";
    const suffix = ":user";
    if (!item.id.startsWith(prefix) || !item.id.endsWith(suffix)) {
      actions.showMessage?.("这条记录没有可用的 Runtime 事件锚点，无法编辑。");
      return false;
    }
    const targetEventId = item.id.slice(prefix.length, -suffix.length);
    const target = await actions.reviseSessionMessage(
      sessionRef,
      targetEventId,
      replacementText,
      idempotencyKey,
    );
    if (!target) return false;
    clearIfUnchanged(draft);
    revisionRequestRef.current = undefined;
    setEditingUserMessage(undefined);
    navigate(sessionHref(target), { replace: true });
    return true;
  };

  const beginEditingUserMessage = (
    item: Extract<ConversationItemView, { kind: "userMessage" }>,
  ) => {
    setEditingUserMessage({ item, previousDraft: draft });
    revisionRequestRef.current = undefined;
    handleDraftChange(item.text);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  };

  const cancelEditingUserMessage = () => {
    if (!editingUserMessage) return;
    handleDraftChange(editingUserMessage.previousDraft);
    revisionRequestRef.current = undefined;
    setEditingUserMessage(undefined);
  };

  const respondToApproval = (
    decision:
      | "allow_once"
      | "allow_session"
      | "deny"
      | "execute"
      | "continue_editing"
      | "reject_exit"
      | "resume_execution"
      | "cancel_execution"
      | "replan_execution",
    feedback?: string,
  ) => {
    if (!pendingApproval) return;
    if (
      pendingApproval.kind === "plan" &&
      (decision === "execute" ||
        decision === "continue_editing" ||
        decision === "reject_exit" ||
        decision === "resume_execution" ||
        decision === "cancel_execution" ||
        decision === "replan_execution")
    ) {
      if (!sessionId) return;
      void actions.respondPlan({
        planId: pendingApproval.planId,
        sessionId,
        action: decision,
        expectedRevision: pendingApproval.expectedRevision,
        expectedSessionSequence: pendingApproval.expectedSessionSequence,
        controlEpoch: pendingApproval.controlEpoch,
        ...(feedback || pendingApproval.planFeedback
          ? { feedback: feedback ?? pendingApproval.planFeedback }
          : {}),
      });
      return;
    }
    void actions.respondApproval(
      pendingApproval.id,
      decision as "allow_once" | "allow_session" | "deny",
    );
  };

  const workbarChangeCount = conversation?.changes?.length ?? 0;
  const renderWorkbarPanel = useCallback(
    (tab: WorkbarTab): ReactNode => {
      const active = isWorkbarPanelActive(workbar, tab.id, {
        sessionBound: Boolean(sessionRef),
      });
      if (tab.kind === "inspector") {
        const showPreview = tab.id === "inspector-preview" && inspector;
        if (showPreview) {
          return (
            <div data-panel-active={active || undefined}>
              <section className="conversation-inspector" aria-label={inspector.title}>
                <header className="conversation-inspector__header">
                  <div>
                    <h2>{inspector.title}</h2>
                    {inspector.subtitle && <p>{inspector.subtitle}</p>}
                  </div>
                </header>
                <div className="conversation-inspector__body">{inspector.content}</div>
              </section>
            </div>
          );
        }
      }
      if (!sessionId) return null;
      if (
        tab.kind === "inspector" ||
        tab.kind === "review" ||
        tab.kind === "tasks" ||
        tab.kind === "files" ||
        tab.kind === "terminal" ||
        tab.kind === "graph"
      ) {
        return (
          <WorkbarPanelHost
            kind={tab.kind as WorkbarPanelHostKind}
            workspacePath={workspacePath}
            sessionId={sessionId}
            instanceId={tab.id}
            active={active}
            readOnly={session?.status === "archived"}
            {...(tab.kind === "terminal" ? { terminalTitle: tab.label } : {})}
            inspectorTab={inspectorTab}
            onInspectorTabChange={setInspectorTab}
          />
        );
      }
      if (tab.kind === "browser" && sessionId) {
        return (
          <BrowserWorkbarPanel
            bridge={window.pico}
            sessionId={sessionId}
            active={isBrowserPanelActive(active, session?.status)}
          />
        );
      }
      if (tab.kind === "side-chat") {
        return (
          <SideChatPanelController
            key={JSON.stringify([workspacePath, sessionId, tab.id])}
            runtime={runtime}
            workspacePath={workspacePath}
            sourceSessionId={sessionId}
            panelId={tab.id}
            active={active}
            quoteRequest={
              sideChatQuoteRequest?.panelId === tab.id
                ? { id: sideChatQuoteRequest.id, text: sideChatQuoteRequest.text }
                : undefined
            }
            onQuoteFallback={quoteIntoMainComposer}
            onRequestClose={() => dispatchWorkbar({ type: "close", tabId: tab.id })}
          />
        );
      }
      return null;
    },
    [
      dispatchWorkbar,
      inspector,
      inspectorTab,
      runtime,
      session?.status,
      sessionId,
      sessionRef,
      sideChatQuoteRequest,
      workbar,
      workspacePath,
    ],
  );

  const handleWorkbarAction = useCallback(
    (action: WorkbarAction) => {
      if (
        !sessionId ||
        (action.type !== "close" && action.type !== "closeOthers" && action.type !== "closeRight")
      ) {
        dispatchWorkbar(action);
        return;
      }
      const tabs = workbar.tabs;
      if (!tabs.some((tab) => tab.id === action.tabId)) {
        dispatchWorkbar(action);
        return;
      }
      const targetIndex = tabs.findIndex((tab) => tab.id === action.tabId);
      const closingTabs =
        action.type === "close"
          ? tabs.filter((tab) => tab.id === action.tabId)
          : action.type === "closeOthers"
            ? tabs.filter((tab) => tab.id !== action.tabId)
            : tabs.slice(targetIndex + 1);
      const routeKey = draftKey;
      setWorkbarError(undefined);
      for (const tab of closingTabs) {
        if (tab.kind !== "terminal") {
          dispatchWorkbar({ type: "close", tabId: tab.id });
          continue;
        }
        const closingKey = JSON.stringify([workspacePath, sessionId, tab.id]);
        if (closingTerminalTabsRef.current.has(closingKey)) continue;
        closingTerminalTabsRef.current.add(closingKey);
        void stopWorkbarTerminalInstance(window.pico.runtime, {
          workspacePath,
          sessionId,
          instanceId: tab.id,
        })
          .then(() => {
            dispatchWorkbar({ type: "close", tabId: tab.id });
          })
          .catch((cause: unknown) => {
            if (sendRouteRef.current !== routeKey) return;
            const reason = cause instanceof Error ? cause.message : "请稍后重试。";
            setWorkbarError(`未能关闭“${tab.label}”：${reason}`);
          })
          .finally(() => closingTerminalTabsRef.current.delete(closingKey));
      }
    },
    [dispatchWorkbar, draftKey, sessionId, workbar.tabs, workspacePath],
  );

  const openWorkbarTab = useCallback(
    (kind: WorkbarToolKind, terminalMode: "open" | "toggle" | "new" = "open") => {
      setWorkbarError(undefined);
      if (kind === "terminal") {
        dispatchWorkbar({
          type: "openTerminal",
          mode: terminalMode,
          tab: {
            id: `terminal:${globalThis.crypto.randomUUID()}`,
            kind,
            label: workspaceName(workspacePath) || "终端",
          },
        });
        return;
      }
      const tool = getWorkbarTool(kind);
      const tab = tool.multiple
        ? {
            id: `${kind}:${globalThis.crypto.randomUUID()}`,
            kind,
            label: tool.label,
          }
        : createWorkbarToolTab(kind);
      dispatchWorkbar({ type: "open", tab });
    },
    [dispatchWorkbar, workspacePath],
  );

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const kind = resolveWorkbarShortcut(event);
      if (!kind || !sessionRef) return;
      event.preventDefault();
      if (event.repeat) return;
      if (
        kind === "browser" &&
        event.target instanceof Element &&
        event.target.closest(".tool-panel__terminal-screen")
      ) {
        openWorkbarTab("terminal", "new");
        return;
      }
      openWorkbarTab(kind, kind === "terminal" ? "toggle" : "open");
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openWorkbarTab, sessionRef]);

  const workbarLauncher = workbar.launcherOpen ? (
    <WorkbarLauncher
      renderIcon={(kind) =>
        kind === "review" ? (
          <FileDiff size={15} />
        ) : kind === "terminal" ? (
          <TerminalSquare size={15} />
        ) : kind === "side-chat" ? (
          <Bot size={15} />
        ) : kind === "files" ? (
          <Folder size={15} />
        ) : (
          <Code2 size={15} />
        )
      }
      onOpen={(kind) => openWorkbarTab(kind, "new")}
      onClose={() => dispatchWorkbar({ type: "setLauncherOpen", open: false })}
    />
  ) : undefined;

  const goalControls = useConversationGoal({
    snapshot: conversation?.goal,
    disabled:
      Boolean(conversation?.loadError) ||
      session?.status === "archived" ||
      Boolean(sessionRef && conversation?.goal === undefined),
    busy: busy === `goal-control:${conversationKey}` || busy === "create-goal-session",
    costCNY: conversation?.usage?.costCNY,
    costStatus: conversation?.usage?.costStatus,
    onArm: async (goalDraft) => {
      let target = sessionRef;
      if (!target) {
        const path =
          workspacePath || temporaryPathRef.current || (await actions.ensureTemporaryWorkspace());
        if (!path) return false;
        target = await actions.createGoalSession(path, newTaskSettings);
        if (!target) return false;
      }
      const succeeded = await actions.controlGoal(target, {
        action: "arm",
        expectedRevision: sessionRef ? (conversation?.goal?.currentGoal?.revision ?? 0) : 0,
        ...goalDraft,
      });
      if (!sessionRef) {
        writePersistentDraft(workspaceSessionKey(target), draft);
        clearDraft();
        navigate(sessionHref(target), { replace: true });
      }
      return succeeded;
    },
    onAction: async (action, goal) =>
      sessionRef
        ? actions.controlGoal(sessionRef, {
            action,
            goalId: goal.id,
            expectedRevision: goal.revision,
          })
        : false,
  });

  return (
    <SessionWorkbarLayout
      state={workbar}
      enabled={Boolean(sessionRef)}
      showRestoreButton={false}
      launcher={workbarLauncher}
      notice={
        workbarError ? (
          <p className="session-workbar__notice" role="alert">
            {workbarError}
          </p>
        ) : undefined
      }
      presentTab={(tab) => ({
        closable: true,
        ...(tab.kind === "review" && workbarChangeCount > 0 ? { badge: workbarChangeCount } : {}),
      })}
      renderPanel={renderWorkbarPanel}
      onAction={handleWorkbarAction}
    >
      <ConversationSurface
        className="session-conversation"
        header={
          sessionRef ? (
            <div className="conversation-session-header">
              <div className="conversation-session-header__identity">
                {workspacePath && (
                  <div className="conversation-session-project-tools">
                    <span className="conversation-session-project" title={workspacePath}>
                      <Folder aria-hidden="true" /> {projectLabel}
                    </span>
                    <span className="conversation-session-worktree" title={workspacePath}>
                      {workspacePath}
                      {data.workspaceBranch ? ` · ${data.workspaceBranch}` : ""}
                    </span>
                  </div>
                )}
                {parentRef && (
                  <Link
                    className="conversation-graph-parent"
                    aria-label={`返回父任务：${parentTitle}`}
                    title={parentTitle}
                    to={sessionHref(parentRef)}
                  >
                    ‹ {parentTitle}
                  </Link>
                )}
                {editingTitle && sessionRef ? (
                  <form
                    className="conversation-title-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void actions
                        .renameSession(sessionRef, titleDraft)
                        .then(() => setEditingTitle(false));
                    }}
                  >
                    <label className="conversation-sr-only" htmlFor="conversation-title">
                      会话标题
                    </label>
                    <TextField
                      label="会话标题"
                      id="conversation-title"
                      name="conversation-title"
                      autoComplete="off"
                      value={titleDraft}
                      autoFocus
                      onChange={(event) => setTitleDraft(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="quiet"
                      disabled={!titleDraft.trim() || Boolean(busy)}
                    >
                      保存
                    </Button>
                    <Button type="button" variant="quiet" onClick={() => setEditingTitle(false)}>
                      取消
                    </Button>
                  </form>
                ) : (
                  <h1>
                    {childParent?.name ??
                      session?.title ??
                      (graphParentId ? "Graph 子任务" : sessionId ? "正在载入会话…" : "新任务")}
                  </h1>
                )}
                <span className="conversation-agent-role" data-child={Boolean(parentRef)}>
                  {parentRef ? "子智能体" : session ? "主智能体" : "智能体"}
                </span>
              </div>
              <div className="conversation-session-header__meta">
                {preview && <PreviewBadge />}
                {conversation?.usage && (
                  <Button
                    type="button"
                    variant="quiet"
                    aria-label="查看 Token 用量总览"
                    title={`会话累计 Token：${conversation.usage.totalTokens?.toLocaleString("zh-CN") ?? "未知"}`}
                    onClick={() => {
                      setInspectorTab("overview");
                      dispatchWorkbar({ type: "open", tab: createWorkbarToolTab("inspector") });
                    }}
                  >
                    会话累计 Token{" "}
                    {conversation.usage.totalTokens === undefined
                      ? "未知"
                      : formatCompact(conversation.usage.totalTokens)}
                  </Button>
                )}
                {activeRun && <StatusPill status={activeRun.status} />}
                {conversation?.settings?.orchestrationMode === "graph" && (
                  <Button
                    variant="quiet"
                    type="button"
                    className="conversation-graph-status"
                    aria-label="打开 Graph 面板"
                    onClick={() => openWorkbarTab("graph")}
                  >
                    <GitFork aria-hidden="true" /> Graph
                  </Button>
                )}
                {sessionRef && (
                  <div className="conversation-session-actions" aria-label="会话操作">
                    <ConversationActionsMenu
                      key={conversationKey}
                      disabledReason={
                        activeRun
                          ? "等待当前运行结束后操作"
                          : busy
                            ? "正在处理，请稍后操作"
                            : undefined
                      }
                      onReview={() =>
                        navigate(
                          `/review?${new URLSearchParams({ workspace: workspacePath, sessionId: sessionRef.sessionId })}`,
                        )
                      }
                      onRename={() => setEditingTitle(true)}
                      onFork={async () => {
                        const source = draftKey;
                        const forked = await actions.forkSession(sessionRef);
                        if (!forked || sendRouteRef.current !== source) return false;
                        navigate(sessionHref(forked));
                        return true;
                      }}
                      onCompact={commands.requestCompact}
                      onOpenWorkspace={() => void actions.openWorkspace(workspacePath)}
                      onCopyWorkspacePath={() =>
                        void copyText(workspacePath)
                          .then(() => actions.showMessage?.("已复制当前会话的项目路径。"))
                          .catch(() =>
                            actions.showMessage?.("复制路径失败，请检查系统剪贴板权限。"),
                          )
                      }
                    />
                  </div>
                )}
                {sessionRef && (
                  <Button
                    variant="quiet"
                    type="button"
                    className="conversation-panel-toggle"
                    id="workbar-toggle-right"
                    aria-label={workbar.collapsed ? "打开任务工作栏" : "收起任务工作栏"}
                    aria-expanded={!workbar.collapsed}
                    onClick={() =>
                      dispatchWorkbar({
                        type: "setCollapsed",
                        collapsed: !workbar.collapsed,
                      })
                    }
                  >
                    {workbar.collapsed ? (
                      <PanelRightOpen aria-hidden="true" />
                    ) : (
                      <PanelRightClose aria-hidden="true" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : undefined
        }
        composer={
          <>
            {researchActive && !preview && (
              <DeepResearchPanel
                key={conversationKey ?? workspacePath}
                workspacePath={workspacePath}
                {...(sessionId ? { sessionId } : {})}
                refreshKey={`${activeRun?.id ?? "idle"}:${activeRun?.status ?? "idle"}:${conversation?.items.length ?? 0}`}
                busy={Boolean(activeRun) || Boolean(busy) || Boolean(pendingResearchSend)}
                onOpenArtifacts={() => openWorkbarTab("files")}
                onImplement={implementResearch}
                onStarter={handleDraftChange}
              />
            )}
            {pendingResearchSend && (
              <PendingSendNotice runtime={runtime} entry={pendingResearchSend} />
            )}
            {sessionRef && !graphParentId && !preview && (
              <ConversationGraphBoard
                key={conversationKey}
                workspacePath={workspacePath}
                sessionId={sessionRef.sessionId}
                enabled={
                  conversation?.settings?.orchestrationMode === "graph" ||
                  conversation?.settings?.orchestrationMode === "swarm"
                }
                refreshKey={`${activeRun?.id ?? "idle"}:${activeRun?.status ?? "idle"}:${conversation?.items.length ?? 0}`}
                onDetails={() => openWorkbarTab("graph")}
                onOpenSession={(childSessionId) =>
                  navigate(
                    `${sessionHref({ workspacePath, sessionId: childSessionId })}&graphParent=${encodeURIComponent(sessionRef.sessionId)}`,
                  )
                }
              />
            )}
            {goalControls.statusBar && (
              <div className="conversation-composer-region conversation-goal-region">
                {goalControls.statusBar}
              </div>
            )}
            {pendingPrompt || pendingApproval ? (
              <ConversationInteractionSlot
                prompt={pendingPrompt}
                approval={pendingPrompt ? undefined : pendingApproval}
                busy={busy === "approval" || busy === "prompt"}
                onApprovalDecision={respondToApproval}
                onPromptAnswer={(answer) => {
                  if (pendingPrompt) void actions.respondPrompt(pendingPrompt.id, answer);
                }}
                onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
              />
            ) : graphParentId ? (
              <div className="conversation-composer-region conversation-graph-child-notice">
                子任务由主任务调度。
                <Link to={sessionHref({ workspacePath, sessionId: graphParentId })}>
                  返回主任务继续对话
                </Link>
              </div>
            ) : (
              <div className="conversation-composer-region">
                {sessionRef && conversation?.queuedInputs?.length ? (
                  <ConversationQueue
                    actions={actions}
                    disabled={Boolean(busy) || session?.status === "archived"}
                    items={conversation.queuedInputs}
                    sessionRef={sessionRef}
                    runId={activeRun?.status === "cancelling" ? undefined : activeRun?.id}
                    steerSupported={Boolean(runtime.queueSteerSupported)}
                  />
                ) : null}
                {!composerModelRouteId && (
                  <p className="conversation-model-notice">
                    请先配置模型连接。<Link to="/settings/models">添加连接</Link>
                  </p>
                )}
                {usingOpenCodeFree && (
                  <p className="conversation-model-notice">
                    此 OpenCode 免费模型仅限 OpenCode 客户端使用，Pico 无法发送请求。
                    <Link to="/settings/models">先添加连接，再返回会话切换模型</Link>
                  </p>
                )}
                {commands.feedback}
                {pendingSend && <PendingSendNotice runtime={runtime} entry={pendingSend} />}
                {referenceError && (
                  <p role="alert" className="conversation-model-notice">
                    {referenceError}
                  </p>
                )}
                {editingUserMessage && (
                  <div className="conversation-editing-banner" role="status">
                    <span className="conversation-editing-banner__label">
                      <Pencil aria-hidden="true" />
                      正在修改已发送消息 · 发送后创建新版本
                    </span>
                    <button
                      type="button"
                      disabled={preparingSend}
                      onClick={cancelEditingUserMessage}
                    >
                      取消
                    </button>
                  </div>
                )}
                <ConversationComposer
                  commands={commands.suggestions}
                  resources={composerResources}
                  inputRef={composerInputRef}
                  value={draft}
                  onValueChange={handleDraftChange}
                  onSubmit={(value) => void submit(value.text, value.behavior)}
                  status={composerStatus}
                  startedAt={activeRun?.startedAt}
                  behavior={behavior}
                  onBehaviorChange={setBehavior}
                  busy={preparingSend || commands.pending || busy === "send-message"}
                  disabled={Boolean(conversation?.loadError)}
                  submitDisabled={
                    editingUserMessage
                      ? Boolean(pendingSend) || !sessionRef
                      : !draftReferences.references.length && isDesktopCommandInput(draft)
                        ? false
                        : Boolean(pendingSend) ||
                          !composerReady ||
                          !composerModelRouteId ||
                          usingOpenCodeFree
                  }
                  placeholder={
                    sessionId
                      ? "继续对话，或在运行中调整方向…"
                      : !workspacePath
                        ? "向 Pico 发送消息…"
                        : legacyStorageBlocked
                          ? "这个项目需要先迁移旧版会话数据…"
                          : !workspaceReady
                            ? "正在准备项目…"
                            : "向 Pico 发送消息…"
                  }
                  statusText={
                    conversation?.queuedCount
                      ? `${conversation.queuedCount} 条消息正在排队`
                      : undefined
                  }
                  onPause={activeRun ? () => void actions.pauseRun(activeRun.id) : undefined}
                  onResume={activeRun ? () => void actions.resumeRun(activeRun.id) : undefined}
                  onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
                  onSetGoal={goalControls.openDialog}
                  goalDisabled={!goalControls.canSetGoal}
                  onAttach={!researchActive && composerStatus === "idle" ? openCatalog : undefined}
                  modes={
                    composerReady && (!sessionRef || conversation?.settings)
                      ? {
                          researchActive,
                          onResearchChange: changeResearchMode,
                          planActive:
                            (sessionRef
                              ? conversation?.settings?.collaborationMode
                              : newTaskSettings.collaborationMode) === "plan",
                          graphActive:
                            (sessionRef
                              ? conversation?.settings?.orchestrationMode
                              : newTaskSettings.orchestrationMode) === "graph",
                          disabled: Boolean(activeRun) || Boolean(busy),
                          onPlanChange: changePlanMode,
                          onGraphChange: changeGraphMode,
                          swarmActive:
                            (sessionRef
                              ? conversation?.settings?.orchestrationMode
                              : newTaskSettings.orchestrationMode) === "swarm",
                          onSwarmChange: (active) => changeGraphMode(active, "swarm"),
                        }
                      : undefined
                  }
                  leadingAccessory={
                    <>
                      {!sessionRef ? (
                        <>
                          <div className="conversation-context-option conversation-project-option">
                            <span className="conversation-sr-only">项目</span>
                            <Folder aria-hidden="true" />
                            <SelectField
                              name="workspace"
                              label="项目"
                              value={
                                workspace?.temporary
                                  ? TEMPORARY_PROJECT_OPTION_VALUE
                                  : workspacePath || ""
                              }
                              onValueChange={(nextWorkspacePath) => {
                                if (nextWorkspacePath === CHOOSE_PROJECT_OPTION_VALUE) {
                                  void chooseProjectFolder();
                                  return;
                                }
                                if (nextWorkspacePath === TEMPORARY_PROJECT_OPTION_VALUE) return;
                                setNewTaskSettingOverrides((current) => ({
                                  ...current,
                                  [nextWorkspacePath || "unbound"]: newTaskSettings,
                                }));
                                if (draft)
                                  writePersistentDraft(
                                    `new:${nextWorkspacePath || "unbound"}`,
                                    draft,
                                  );
                                navigate(newSessionHref(nextWorkspacePath));
                              }}
                              options={[
                                { value: "", label: "无项目" },
                                { value: CHOOSE_PROJECT_OPTION_VALUE, label: "打开项目文件夹…" },
                                ...(workspace?.temporary
                                  ? [
                                      {
                                        value: TEMPORARY_PROJECT_OPTION_VALUE,
                                        label: workspaceLabel,
                                      },
                                    ]
                                  : []),
                                ...projectWorkspaceOptions.map((workspace) => ({
                                  value: workspace.path,
                                  label: workspaceDisplayName(workspace.path, workspace),
                                })),
                              ]}
                            />
                          </div>
                          {composerReady && (
                            <>
                              <ComposerModelPicker
                                openRequest={modelOpenRequest}
                                routes={newTaskModelRoutes}
                                providers={data.providerConfig.providers}
                                value={newTaskSettings.modelRouteId}
                                onChange={(modelRouteId) => updateNewTaskSettings({ modelRouteId })}
                                onConfigure={() => navigate("/settings/models")}
                              />

                              <div className="conversation-context-option">
                                <span className="conversation-sr-only">权限模式</span>
                                <SelectField
                                  name="initial-permission-mode"
                                  label="权限模式"
                                  title={`权限：${PERMISSION_MODE_LABELS[newTaskSettings.permissionMode ?? "ask"]}`}
                                  value={newTaskSettings.permissionMode ?? "ask"}
                                  onValueChange={(value) =>
                                    updateNewTaskSettings({
                                      permissionMode: value as "ask" | "auto" | "full-access",
                                    })
                                  }
                                  options={[
                                    { value: "ask", label: "权限：请求批准" },
                                    { value: "auto", label: "权限：帮我批准" },
                                    { value: "full-access", label: "权限：完全访问权限" },
                                  ]}
                                />
                              </div>
                              {newTaskReasoningLevels.length > 0 && (
                                <div className="conversation-context-option">
                                  <SelectField
                                    name="initial-thinking-effort"
                                    label="思考强度"
                                    value={newTaskSettings.thinkingEffort ?? ""}
                                    disabled={Boolean(busy) || preparingSend}
                                    onValueChange={(thinkingEffort) =>
                                      updateNewTaskSettings({ thinkingEffort })
                                    }
                                    options={[
                                      { value: "", label: "思考：默认" },
                                      ...newTaskReasoningLevels.map((level) => ({
                                        value: level,
                                        label: level,
                                      })),
                                    ]}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </>
                      ) : (
                        <span className="conversation-context-label">
                          {data.workspaceMode === "git" ? (
                            <FolderGit2 aria-hidden="true" />
                          ) : (
                            <Folder aria-hidden="true" />
                          )}
                          <span title={workspacePath}>{workspaceLabel}</span>
                        </span>
                      )}
                      {sessionRef && conversation?.settings && (
                        <>
                          <ComposerModelPicker
                            openRequest={modelOpenRequest}
                            routes={data.modelRoutes}
                            providers={data.providerConfig.providers}
                            value={conversation.settings.modelRouteId}
                            currentLabel={conversation.settings.model}
                            disabled={busy === "send-message" || busy === "session-settings"}
                            readOnly={Boolean(activeRun)}
                            disabledReason={
                              activeRun ? "任务执行中，结束后可切换模型" : "正在更新会话…"
                            }
                            hasHistory={conversation.items.length > 0}
                            onChange={(modelRouteId) =>
                              actions.updateSessionSettings(sessionRef, { modelRouteId })
                            }
                            onConfigure={() => navigate("/settings/models")}
                          />

                          {composerProvider && (
                            <ComposerContextGauge
                              target={{
                                workspacePath,
                                sessionId: sessionRef.sessionId,
                                routeId: conversation.settings.modelRouteId,
                                providerId:
                                  composerProvider.modelProtocols?.[conversation.settings.model] ??
                                  composerProvider.protocol,
                                modelId: conversation.settings.model,
                                connectionId: composerProvider.id,
                                configurationRevision: composerProvider.fingerprint,
                              }}
                            />
                          )}

                          <div className="conversation-context-option">
                            <span className="conversation-sr-only">权限模式</span>
                            <SelectField
                              name="permission-mode"
                              label="权限模式"
                              title={`权限：${PERMISSION_MODE_LABELS[conversation.settings.permissionMode]}`}
                              value={conversation.settings.permissionMode}
                              disabled={Boolean(activeRun) || Boolean(busy)}
                              onValueChange={(value) =>
                                void actions.updateSessionSettings(sessionRef, {
                                  permissionMode: value as "ask" | "auto" | "full-access",
                                })
                              }
                              options={[
                                { value: "ask", label: "权限：请求批准" },
                                { value: "auto", label: "权限：帮我批准" },
                                { value: "full-access", label: "权限：完全访问权限" },
                              ]}
                            />
                          </div>

                          {conversation.settings.reasoningLevels.length > 0 && (
                            <div className="conversation-context-option">
                              <span className="conversation-sr-only">Thinking</span>
                              <SelectField
                                name="thinking-effort"
                                label="Thinking"
                                value={conversation.settings.thinkingEffort}
                                disabled={Boolean(activeRun) || Boolean(busy)}
                                onValueChange={(value) =>
                                  void actions.updateSessionSettings(sessionRef, {
                                    thinkingEffort: value,
                                  })
                                }
                                options={conversation.settings.reasoningLevels.map((level) => ({
                                  value: level,
                                  label: level,
                                }))}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </>
                  }
                />
              </div>
            )}
          </>
        }
      >
        {conversation?.loadError ? (
          <div className="conversation-empty-state" role="alert">
            <AlertTriangle aria-hidden="true" />
            <h3>无法恢复这个会话</h3>
            <p>{conversation.loadError}</p>
            <Button
              disabled={Boolean(busy)}
              onClick={() => sessionRef && actions.loadSession(sessionRef)}
            >
              重新载入
            </Button>
          </div>
        ) : (
          <>
            {sessionRef && (
              <section className="conversation-history-tools" aria-label="会话历史导航">
                <label className="conversation-history-search">
                  <Search aria-hidden="true" size={15} />
                  <span className="conversation-sr-only">搜索当前会话</span>
                  <input
                    type="search"
                    value={searchQuery}
                    placeholder="搜索当前会话的全部历史…"
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                  {searchPending && <span role="status">搜索中…</span>}
                </label>
                {searchQuery.trim() && (
                  <div className="conversation-search-results" aria-live="polite">
                    {searchResults.length === 0 && !searchPending ? (
                      <span className="conversation-history-empty">没有找到匹配内容。</span>
                    ) : (
                      searchResults.map((hit) => (
                        <button
                          type="button"
                          key={`${hit.eventId}:${hit.itemId}`}
                          onClick={() => void jumpToTranscriptItem(hit.itemId)}
                        >
                          <span>{hit.role === "user" ? "你" : "Pico"}</span>
                          <span>
                            {hit.summary.slice(0, hit.matchStart)}
                            <mark>
                              {hit.summary.slice(hit.matchStart, hit.matchStart + hit.matchLength)}
                            </mark>
                            {hit.summary.slice(hit.matchStart + hit.matchLength)}
                          </span>
                        </button>
                      ))
                    )}
                    {searchCursor !== undefined && (
                      <Button
                        variant="quiet"
                        type="button"
                        onClick={() => void loadMoreSearchResults()}
                      >
                        更多搜索结果
                      </Button>
                    )}
                  </div>
                )}
                {promptAnchors.length > 0 && (
                  <nav className="conversation-prompt-rail" aria-label="按用户提问跳转">
                    <span>提问</span>
                    <div>
                      {promptAnchors.map((anchor) => (
                        <button
                          type="button"
                          key={anchor.eventId}
                          title={anchor.prompt}
                          onClick={() => void jumpToTranscriptItem(anchor.itemId)}
                        >
                          {anchor.prompt}
                        </button>
                      ))}
                    </div>
                    {promptAnchorCursor !== undefined && (
                      <Button
                        variant="quiet"
                        type="button"
                        onClick={() => void loadMorePromptAnchors()}
                      >
                        更早提问
                      </Button>
                    )}
                  </nav>
                )}
              </section>
            )}
            {sessionRef && conversation?.hasEarlier && (
              <div className="conversation-history-pagination">
                <Button
                  variant="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => void actions.loadEarlierSession(sessionRef)}
                >
                  {busy === "load-earlier-session" ? "正在加载…" : "加载更早记录"}
                </Button>
              </div>
            )}
            <ConversationTranscript
              mediaScope={
                sessionRef
                  ? { workspacePath: sessionRef.workspacePath, sessionId: sessionRef.sessionId }
                  : undefined
              }
              activeRun={activeRun}
              items={
                retryNotice
                  ? [
                      ...items,
                      {
                        id: `provider-retry:${retryNotice.runId}`,
                        kind: "status" as const,
                        title: "模型请求重试中",
                        at: retryNotice.at,
                      },
                    ]
                  : items
              }
              assistantLabel={
                parentRef
                  ? `子智能体 · ${childParent?.name ?? session?.title ?? "执行记录"}`
                  : undefined
              }
              onEditUserMessage={
                !activeRun && session?.status !== "archived" ? beginEditingUserMessage : undefined
              }
              onQuoteSelection={quoteIntoMainComposer}
              onAskInSideChat={
                sessionRef && session?.status !== "archived" ? quoteIntoSideChat : undefined
              }
              highlightItemId={highlightItemId}
              onOpenItem={openItem}
              renderItem={(item, fallback) => {
                if (item.id === `provider-retry:${retryNotice?.runId}` && retryNotice) {
                  return <ProviderRetryBanner notice={retryNotice} />;
                }
                if (item.kind !== "runBoundary" || item.status !== "failed") return fallback;
                const failureState = item.runId
                  ? data.providerRetries[providerRetryKey(workspacePath, item.runId)]
                  : undefined;
                const failureNotice =
                  failureState?.lastFailure?.sessionId === sessionId
                    ? failureState?.lastFailure
                    : undefined;
                const diagnostic = modelCommunicationDiagnostic(item.detail ?? "");
                const status = providerStatusDiagnostic(item.detail ?? "");
                if (!failureNotice && !diagnostic && !status) return fallback;
                const latestBoundary = items.findLast(
                  (candidate) => candidate.kind === "runBoundary" && candidate.status !== "started",
                );
                const boundaryIndex = items.findIndex((candidate) => candidate.id === item.id);
                const originalRequest = items
                  .slice(0, boundaryIndex)
                  .findLast((candidate) => candidate.kind === "userMessage");
                const canRetry =
                  latestBoundary?.id === item.id &&
                  !activeRun &&
                  session?.status !== "archived" &&
                  !draft.trim() &&
                  originalRequest?.kind === "userMessage" &&
                  Boolean(originalRequest.text.trim());
                return (
                  <ProviderFailureCard
                    providerDetail={diagnostic?.providerDetail ?? status?.providerDetail}
                    diagnosticText={item.detail}
                    notice={failureNotice}
                    httpStatus={status?.httpStatus}
                    title={diagnostic?.title ?? status?.title ?? "暂时无法连接模型"}
                    canRetry={Boolean(canRetry)}
                    onRetry={() => {
                      if (originalRequest?.kind !== "userMessage" || draft.trim()) return;
                      handleDraftChange(originalRequest.text);
                      window.requestAnimationFrame(() => composerInputRef.current?.focus());
                    }}
                    onDiagnostics={() => openWorkbarTab("inspector")}
                  />
                );
              }}
              emptyState={
                busy === "load-session" ? (
                  <div className="conversation-empty-state">
                    <h3>正在载入对话记录…</h3>
                  </div>
                ) : sessionId ? (
                  <div className="conversation-empty-state">
                    <Sparkles aria-hidden="true" />
                    <h3>这个会话还没有可见消息</h3>
                    <p>继续输入后，消息和执行记录会显示在这里。</p>
                  </div>
                ) : (
                  <div className="conversation-empty-state conversation-empty-state--new">
                    <span className="brand-mark brand-mark--large" role="img" aria-label="Pico" />
                    <h2>{newTaskGreeting()}</h2>
                    {legacyStorageBlocked && (
                      <InlineNotice tone="warning">
                        这个项目仍包含旧版 JSONL 会话数据。Pico
                        不会自动删除或混写这些历史；请先完成迁移，再开始新任务。
                      </InlineNotice>
                    )}
                  </div>
                )
              }
            />
          </>
        )}
      </ConversationSurface>
      {goalControls.dialog}
    </SessionWorkbarLayout>
  );
}

function timelineItemToConversationItem(item: TimelineItem): ConversationItemView {
  if (item.kind === "plan") {
    return {
      id: item.id,
      kind: "plan",
      title: item.title,
      steps: [
        { id: `${item.id}:step`, title: item.detail ?? item.title, state: item.state ?? "active" },
      ],
      at: item.at,
    };
  }
  if (item.kind === "tool") {
    return {
      id: item.id,
      kind: "tool",
      toolName: typeof item.data?.toolName === "string" ? item.data.toolName : item.title,
      toolCallId:
        typeof item.data?.providerCallId === "string" ? item.data.providerCallId : undefined,
      title: item.title,
      detail: item.detail,
      state: item.state ?? "active",
      at: item.at,
    };
  }
  if (item.kind === "agent") {
    return {
      id: item.id,
      kind: "subagent",
      name: typeof item.data?.agentName === "string" ? item.data.agentName : item.title,
      title: item.title,
      ...subagentMetadata(item.data ?? {}),
      detail: item.detail,
      state: item.state ?? "active",
      at: item.at,
    };
  }
  if (item.eventType === "assistant.message") {
    return { id: item.id, kind: "assistantMessage", text: item.detail ?? item.title, at: item.at };
  }
  const modelDiagnostic = modelCommunicationDiagnostic(item.detail ?? item.title);
  const statusDiagnostic = providerStatusDiagnostic(item.detail ?? item.title);
  return {
    id: item.id,
    kind: "status",
    title:
      item.state === "failed" && (modelDiagnostic || statusDiagnostic)
        ? (modelDiagnostic?.title ?? statusDiagnostic?.title ?? item.title)
        : item.title,
    detail:
      item.state === "failed" && (modelDiagnostic || statusDiagnostic) ? undefined : item.detail,
    tone: item.state === "failed" ? "error" : item.state === "done" ? "success" : "neutral",
    at: item.at,
  };
}

function newTaskGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return "夜深了，先从一件小事开始。";
  if (hour < 11) return "早上好，今天想推进什么？";
  if (hour < 14) return "中午好，今天想推进什么？";
  if (hour < 18) return "下午好，适合慢慢推进。";
  return "晚上好，想先解决什么？";
}
