import {
  subagentMetadata,
  subagentParent,
  subagentSessionHref,
} from "../conversation/subagent-navigation.js";
import type { RuntimeUserDefaults } from "@pico/protocol";
import {
  AlertTriangle,
  Bot,
  Code2,
  FileDiff,
  Folder,
  FolderGit2,
  GitFork,
  Minimize2,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ComposerModelPicker } from "../ComposerModelPicker.js";
import { Button, InlineNotice, PreviewBadge, StatusPill } from "../components.js";
import { ConversationGraphBoard } from "../conversation/ConversationGraphBoard.js";
import {
  ConversationComposer,
  ConversationContextMenu,
  ConversationInteractionSlot,
  ConversationSurface,
  ConversationTranscript,
  mergeConversationItemGroups,
  omitApprovalAuditItems,
  removePersistentDraft,
  removeSupersededActiveTools,
  usePersistentDraft,
  writePersistentDraft,
  type ComposerBehavior,
  type ConversationInspectorView,
  type ConversationItemView,
} from "../conversation/index.js";
import { pendingToolApprovalFromTranscript } from "../conversation/runtime-projection.js";
import type { TimelineItem } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import { parseSwarmCommand } from "../swarm-command.js";
import { formatCompact, isTerminalRun } from "../view-format.js";
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
  createWorkbarState,
  createWorkbarToolTab,
  getWorkbarTool,
  isWorkbarPanelActive,
  loadWorkbarState,
  reduceWorkbarState,
  resolveWorkbarShortcut,
  saveWorkbarState,
  type WorkbarAction,
  type WorkbarDock,
  type WorkbarTab,
  type WorkbarToolKind,
} from "../workbar/index.js";
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
  const {
    value: draft,
    update: handleDraftChange,
    clear: clearDraft,
  } = usePersistentDraft(draftKey);
  const [behavior, setBehavior] = useState<ComposerBehavior>("steer");
  const [inspector, setInspector] = useState<ConversationInspectorView>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [workbar, dispatchWorkbar] = useReducer(reduceWorkbarState, undefined, () => {
    const fallback = createWorkbarState();
    return typeof window === "undefined"
      ? fallback
      : loadWorkbarState(window.localStorage, fallback);
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [activation, setActivation] = useState<
    | { readonly kind: "skill"; readonly name: string }
    | { readonly kind: "agent"; readonly name: string; readonly subagentId?: string }
  >();
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
    setCatalogOpen(false);
    setEditingTitle(false);
    setConfirmCompact(false);
    setActivation(undefined);
  }, [sessionId, workspacePath]);

  useEffect(() => {
    if (typeof window !== "undefined") saveWorkbarState(window.localStorage, workbar);
  }, [workbar]);

  useEffect(() => {
    if (!inspector) {
      dispatchWorkbar({ type: "close", tabId: "inspector-preview" });
      return;
    }
    dispatchWorkbar({
      type: "openPreview",
      dock: "right",
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
  const conversation = conversationKey ? data.conversations[conversationKey] : undefined;
  const sessionRuns = data.runs.filter(
    (run) => run.workspacePath === workspacePath && run.sessionId === sessionId,
  );
  const activeRun = sessionRuns.find((run) => !isTerminalRun(run.status));
  const composerStatus = activeRun
    ? ["paused", "pause_requested"].includes(activeRun.status)
      ? "paused"
      : "running"
    : "idle";
  const [newTaskSettingOverrides, setNewTaskSettingOverrides] = useState<
    Readonly<Record<string, RuntimeUserDefaults>>
  >({});
  const newTaskModelRoutes = useMemo(() => {
    if (workspacePath && data.modelRoutes.length) return data.modelRoutes;
    const globalRoutes = data.providerConfig.providers
      .filter((provider) => provider.origin === "user")
      .flatMap((provider) =>
        provider.models.map((model) => ({
          id: `${provider.id}/${model}`,
          label: `${model} · ${provider.id}`,
        })),
      );
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
      ...(defaults.thinkingEffort ? { thinkingEffort: defaults.thinkingEffort } : {}),
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
      setNewTaskSettingOverrides((current) => ({
        ...current,
        [workspacePath || "unbound"]: { ...current[workspacePath || "unbound"], ...patch },
      }));
    },
    [workspacePath],
  );
  const composerModelRouteId = conversation?.settings?.modelRouteId ?? newTaskSettings.modelRouteId;
  const composerProvider = data.providerConfig.providers.find((provider) =>
    composerModelRouteId?.startsWith(`${provider.id}/`),
  );
  const usingOpenCodeFree =
    composerProvider?.auth === "none" &&
    composerProvider.baseURL.replace(/\/+$/u, "") === "https://opencode.ai/zen/v1";

  const runIds = useMemo(() => new Set(sessionRuns.map((run) => run.id)), [sessionRuns]);
  const persistedPendingApproval = activeRun
    ? pendingToolApprovalFromTranscript(conversation?.items ?? [], activeRun.id)
    : undefined;
  const pendingApproval =
    data.approvals
      .filter(
        (item) => runIds.has(item.runId) && (item.kind === "plan" || item.runId === activeRun?.id),
      )
      .at(-1) ??
    (persistedPendingApproval && activeRun
      ? {
          id: persistedPendingApproval.id.slice("approval:".length),
          runId: activeRun.id,
          sessionId,
          title: persistedPendingApproval.title,
          detail: persistedPendingApproval.detail,
          risk: persistedPendingApproval.risk ?? ("medium" as const),
          kind: "tool" as const,
          toolName: persistedPendingApproval.toolName,
          providerCallId: persistedPendingApproval.providerCallId,
          command: persistedPendingApproval.command,
          diff: persistedPendingApproval.diff,
          sessionScope: persistedPendingApproval.sessionScope,
        }
      : undefined) ??
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
    const persisted = removeSupersededActiveTools(
      conversation?.items ?? [],
      Boolean(activeRun),
    ).filter(
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
      conversation?.goalItem && !persisted.some((item) => item.kind === "goal")
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

  const submit = async (text: string, nextBehavior: ComposerBehavior) => {
    if (sendingRef.current || !composerReady) return;
    const swarmCommand = !activation ? parseSwarmCommand(text) : undefined;
    if (swarmCommand) {
      if (swarmCommand.kind !== "status" && activeRun) {
        actions.showMessage?.("任务运行中不能切换或启动 Swarm；可以使用 /swarm status 查看状态。");
        return;
      }
      const currentMode = sessionRef
        ? conversation?.settings?.orchestrationMode
        : newTaskSettings.orchestrationMode;
      if (swarmCommand.kind === "status") {
        actions.showMessage?.(
          `Swarm：${currentMode === "swarm" ? "开启" : "关闭"}；当前编排：${currentMode ?? "default"}`,
        );
        clearDraft();
        return;
      }
      if (swarmCommand.kind === "set_mode") {
        if (swarmCommand.mode === "swarm" || currentMode === "swarm")
          await changeGraphMode(swarmCommand.mode === "swarm", "swarm");
        clearDraft();
        return;
      }
    }
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
        ...(sessionId ? { sessionId } : {}),
        ...(!sessionId ? { initialSettings: newTaskSettings } : {}),
        text,
        behavior: nextBehavior,
        ...(activeRun ? { expectedRunId: activeRun.id } : {}),
        ...(activation ? { activation } : {}),
      });
      if (!result.succeeded) {
        setAwaitingFirstSession(false);
        return;
      }
      if (sendRouteRef.current !== sourceDraftKey) {
        removePersistentDraft(sourceDraftKey);
        return;
      }
      clearDraft();
      setActivation(undefined);
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

  const openCatalog = () => setCatalogOpen((open) => !open);

  const changePlanMode = async (active: boolean) => {
    const collaborationMode = active ? "plan" : "agent";
    if (!sessionRef) {
      updateNewTaskSettings({ collaborationMode });
      return;
    }
    const pendingPlan = data.approvals.find(
      (approval) => approval.kind === "plan" && approval.sessionId === sessionRef.sessionId,
    );
    if (!active && conversation?.settings?.collaborationMode === "plan" && pendingPlan) {
      if (!window.confirm("当前计划仍待审批。退出 Plan 将拒绝并放弃这份计划，是否继续？")) return;
      await actions.respondPlan({
        sessionId: sessionRef.sessionId,
        planId: pendingPlan.planId ?? pendingPlan.id,
        action: "reject_exit",
        expectedRevision: pendingPlan.expectedRevision ?? 0,
        expectedSessionSequence: pendingPlan.expectedSessionSequence ?? 0,
        controlEpoch: pendingPlan.controlEpoch ?? "",
        feedback: "用户从协作模式开关退出 Plan。",
      });
      return;
    }
    await actions.updateSessionSettings(sessionRef, { collaborationMode });
  };

  const changeGraphMode = async (active: boolean, mode: "graph" | "swarm" = "graph") => {
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
      const inspectorContent = (content: string, pageLabel?: string) => (
        <div>
          {result && (
            <p>
              状态：{result.status} · 原始大小：{result.rawSizeBytes} bytes · SHA-256：
              <code>{result.sha256}</code>
              {result.deliveryTruncated ? " · Host 投影已截断" : ""}
            </p>
          )}
          {evidenceUri && <p>Evidence：{evidenceUri}</p>}
          {pageLabel && <p>{pageLabel}</p>}
          <pre className="conversation-inspector-output">{content}</pre>
        </div>
      );
      setInspector({
        title: item.title,
        subtitle: item.toolName,
        content: inspectorContent(item.output ?? item.detail ?? "没有可显示的输出。"),
      });
      if (evidenceUri && sessionId) {
        void actions
          .readToolEvidence({
            workspacePath,
            sessionId,
            evidenceUri,
            limitBytes: 64 * 1024,
          })
          .then((page) => {
            if (!page) return;
            setInspector({
              title: item.title,
              subtitle: item.toolName,
              content: inspectorContent(
                page.content,
                `Evidence bytes ${page.offsetBytes}-${page.endOffsetBytes} / ${page.totalBytes}${
                  page.truncated ? " · 尚有后续分页" : ""
                }`,
              ),
            });
          });
      }
      return;
    }
    if (item.kind === "subagent") {
      if (!sessionRef) return;
      const href = subagentSessionHref(item, sessionRef);
      if (href) navigate(href);
    }
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
    const operation =
      pendingApproval.kind === "plan" &&
      (decision === "execute" ||
        decision === "continue_editing" ||
        decision === "reject_exit" ||
        decision === "resume_execution" ||
        decision === "cancel_execution" ||
        decision === "replan_execution")
        ? actions.respondPlan({
            planId: pendingApproval.planId ?? "",
            sessionId: sessionId ?? "",
            action: decision,
            expectedRevision: pendingApproval.expectedRevision ?? 0,
            expectedSessionSequence: pendingApproval.expectedSessionSequence ?? 0,
            controlEpoch: pendingApproval.controlEpoch ?? "",
            ...(feedback || pendingApproval.planFeedback
              ? { feedback: feedback ?? pendingApproval.planFeedback }
              : {}),
          })
        : actions.respondApproval(
            pendingApproval.id,
            decision as "allow_once" | "allow_session" | "deny",
          );
    void operation;
  };

  const workbarChangeCount = conversation?.changes?.length ?? 0;
  const renderWorkbarPanel = useCallback(
    (tab: WorkbarTab, dock: WorkbarDock): ReactNode => {
      const active = isWorkbarPanelActive(workbar, dock, tab.id, {
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
            onRequestClose={() => dispatchWorkbar({ type: "close", tabId: tab.id })}
          />
        );
      }
      return null;
    },
    [inspector, runtime, session?.status, sessionId, sessionRef, workbar, workspacePath],
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
      const dock = (Object.keys(workbar.docks) as WorkbarDock[]).find((candidate) =>
        workbar.docks[candidate].tabs.some((tab) => tab.id === action.tabId),
      );
      if (!dock) {
        dispatchWorkbar(action);
        return;
      }
      const tabs = workbar.docks[dock].tabs;
      const targetIndex = tabs.findIndex((tab) => tab.id === action.tabId);
      const closingTabs =
        action.type === "close"
          ? tabs.filter((tab) => tab.id === action.tabId)
          : action.type === "closeOthers"
            ? tabs.filter((tab) => tab.id !== action.tabId)
            : tabs.slice(targetIndex + 1);
      const terminalTabs = closingTabs.filter((tab) => tab.kind === "terminal");
      if (terminalTabs.length === 0) {
        dispatchWorkbar(action);
        return;
      }
      void Promise.allSettled(
        terminalTabs.map((tab) =>
          stopWorkbarTerminalInstance(window.pico.runtime, {
            workspacePath,
            sessionId,
            instanceId: tab.id,
          }),
        ),
      ).finally(() => dispatchWorkbar(action));
    },
    [sessionId, workbar.docks, workspacePath],
  );

  const openWorkbarTab = useCallback((kind: WorkbarToolKind, dock?: WorkbarDock) => {
    const tool = getWorkbarTool(kind);
    const tab = tool.multiple
      ? {
          id: `${kind}:${globalThis.crypto.randomUUID()}`,
          kind,
          label: tool.label,
        }
      : createWorkbarToolTab(kind);
    dispatchWorkbar({ type: "open", tab, dock: dock ?? tool.defaultDock });
  }, []);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const kind = resolveWorkbarShortcut(event);
      if (!kind || !sessionRef) return;
      event.preventDefault();
      openWorkbarTab(kind);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openWorkbarTab, sessionRef]);

  const workbarLauncher = useCallback(
    (dock: WorkbarDock): ReactNode =>
      workbar.docks[dock].launcherOpen ? (
        <WorkbarLauncher
          dock={dock}
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
          onOpen={(kind, targetDock) => openWorkbarTab(kind, targetDock)}
          onClose={() => dispatchWorkbar({ type: "setLauncherOpen", dock, open: false })}
        />
      ) : undefined,
    [openWorkbarTab, workbar.docks],
  );

  return (
    <SessionWorkbarLayout
      state={workbar}
      enabled={Boolean(sessionRef)}
      showRestoreButton={false}
      launcher={workbarLauncher}
      presentTab={(tab) => ({
        closable: true,
        ...(tab.kind === "review" && workbarChangeCount > 0 ? { badge: workbarChangeCount } : {}),
      })}
      renderPanel={renderWorkbarPanel}
      onAction={(action) => {
        handleWorkbarAction(action);
        if (action.type === "setCollapsed" && action.collapsed) {
          window.requestAnimationFrame(() =>
            document.getElementById(`workbar-toggle-${action.dock}`)?.focus(),
          );
        }
      }}
    >
      <ConversationSurface
        className="session-conversation"
        header={
          sessionRef ? (
            <div className="conversation-session-header">
              <div className="conversation-session-header__identity">
                {workspacePath && (
                  <span className="conversation-session-project" title={workspacePath}>
                    <Folder aria-hidden="true" /> {workspaceLabel}
                  </span>
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
                    <input
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
                  <span>
                    {formatCompact(
                      (conversation.usage.inputTokens ?? 0) +
                        (conversation.usage.outputTokens ?? 0),
                    )}{" "}
                    tokens
                  </span>
                )}
                {activeRun && <StatusPill status={activeRun.status} />}
                {conversation?.settings?.orchestrationMode === "graph" && (
                  <button
                    type="button"
                    className="conversation-graph-status"
                    aria-label="打开 Graph 面板"
                    onClick={() => openWorkbarTab("graph", "right")}
                  >
                    <GitFork aria-hidden="true" /> Graph
                  </button>
                )}
                {sessionRef && (
                  <div className="conversation-session-actions" aria-label="会话操作">
                    <button
                      type="button"
                      disabled={Boolean(activeRun) || Boolean(busy)}
                      onClick={() => setEditingTitle(true)}
                    >
                      <Pencil aria-hidden="true" /> 重命名
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(activeRun) || Boolean(busy)}
                      onClick={() =>
                        void actions
                          .forkSession(sessionRef)
                          .then((forked) => forked && navigate(sessionHref(forked)))
                      }
                    >
                      <GitFork aria-hidden="true" /> 分叉
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(activeRun) || Boolean(busy)}
                      onClick={() => {
                        if (!confirmCompact) {
                          setConfirmCompact(true);
                          return;
                        }
                        void actions
                          .compactSession(sessionRef)
                          .then(() => setConfirmCompact(false));
                      }}
                    >
                      <Minimize2 aria-hidden="true" /> {confirmCompact ? "确认压缩" : "压缩"}
                    </button>
                  </div>
                )}
                {sessionRef && (
                  <button
                    type="button"
                    id="workbar-toggle-bottom"
                    className="conversation-panel-toggle"
                    aria-label={
                      workbar.docks.bottom.collapsed ? "打开底部工作栏" : "收起底部工作栏"
                    }
                    aria-expanded={!workbar.docks.bottom.collapsed}
                    onClick={() =>
                      dispatchWorkbar({
                        type: "setCollapsed",
                        dock: "bottom",
                        collapsed: !workbar.docks.bottom.collapsed,
                      })
                    }
                  >
                    <PanelBottomOpen aria-hidden="true" />
                  </button>
                )}
                {sessionRef && (
                  <button
                    type="button"
                    className="conversation-panel-toggle"
                    id="workbar-toggle-right"
                    aria-label={workbar.docks.right.collapsed ? "打开任务工作栏" : "收起任务工作栏"}
                    aria-expanded={!workbar.docks.right.collapsed}
                    onClick={() =>
                      dispatchWorkbar({
                        type: "setCollapsed",
                        dock: "right",
                        collapsed: !workbar.docks.right.collapsed,
                      })
                    }
                  >
                    {workbar.docks.right.collapsed ? (
                      <PanelRightOpen aria-hidden="true" />
                    ) : (
                      <PanelRightClose aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            </div>
          ) : undefined
        }
        composer={
          <>
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
                onDetails={() => openWorkbarTab("graph", "right")}
                onOpenSession={(childSessionId) =>
                  navigate(
                    `${sessionHref({ workspacePath, sessionId: childSessionId })}&graphParent=${encodeURIComponent(sessionRef.sessionId)}`,
                  )
                }
              />
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
                {usingOpenCodeFree && (
                  <p className="conversation-free-notice">
                    OpenCode Free 免费试用 · 按 IP 限流，请勿提交个人或机密信息。
                    <a href="https://opencode.ai/docs/zen#privacy" target="_blank" rel="noreferrer">
                      数据使用说明
                    </a>
                  </p>
                )}
                {catalogOpen && (
                  <ConversationContextMenu
                    skills={data.catalogSkills}
                    agents={data.catalogAgents}
                    onClose={() => setCatalogOpen(false)}
                    onSelect={(nextActivation) => {
                      setActivation(nextActivation);
                      setCatalogOpen(false);
                      window.requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLTextAreaElement>(".conversation-composer textarea")
                          ?.focus(),
                      );
                    }}
                  />
                )}
                <ConversationComposer
                  value={draft}
                  onValueChange={handleDraftChange}
                  onSubmit={(value) => void submit(value.text, value.behavior)}
                  status={composerStatus}
                  behavior={behavior}
                  onBehaviorChange={setBehavior}
                  busy={preparingSend || busy === "send-message"}
                  disabled={Boolean(conversation?.loadError)}
                  submitDisabled={!composerReady}
                  placeholder={
                    activation?.kind === "skill"
                      ? `输入 ${activation.name} 的参数或补充要求…`
                      : activation?.kind === "agent"
                        ? `描述要委派给 ${activation.name} 的任务…`
                        : sessionId
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
                  onAttach={composerStatus === "idle" && workspaceReady ? openCatalog : undefined}
                  modes={
                    composerReady && (!sessionRef || conversation?.settings)
                      ? {
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
                  trailingAccessory={
                    activation ? (
                      <button
                        type="button"
                        className="conversation-activation-chip"
                        onClick={() => setActivation(undefined)}
                        aria-label={`移除 ${activation.kind === "skill" ? "Skill" : "子代理"} ${activation.name}`}
                      >
                        {activation.kind === "skill" ? "Skill" : "Agent"}: {activation.name} ×
                      </button>
                    ) : undefined
                  }
                  leadingAccessory={
                    <>
                      {!sessionRef ? (
                        <>
                          <label className="conversation-context-option conversation-project-option">
                            <span className="conversation-sr-only">项目</span>
                            <Folder aria-hidden="true" />
                            <select
                              name="workspace"
                              aria-label="项目"
                              value={
                                workspace?.temporary
                                  ? TEMPORARY_PROJECT_OPTION_VALUE
                                  : workspacePath || ""
                              }
                              onChange={(event) => {
                                const nextWorkspacePath = event.target.value;
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
                            >
                              <option value="">无项目</option>
                              <option value={CHOOSE_PROJECT_OPTION_VALUE}>打开项目文件夹…</option>
                              {workspace?.temporary && (
                                <option value={TEMPORARY_PROJECT_OPTION_VALUE}>
                                  {workspaceLabel}
                                </option>
                              )}
                              {projectWorkspaceOptions.map((workspace) => (
                                <option key={workspace.path} value={workspace.path}>
                                  {workspaceDisplayName(workspace.path, workspace)}
                                </option>
                              ))}
                            </select>
                          </label>
                          {composerReady && (
                            <>
                              <ComposerModelPicker
                                routes={newTaskModelRoutes}
                                providers={data.providerConfig.providers}
                                value={newTaskSettings.modelRouteId}
                                onChange={(modelRouteId) => updateNewTaskSettings({ modelRouteId })}
                                onConfigure={() => navigate("/settings/models")}
                              />

                              <label
                                className={`conversation-context-option conversation-icon-select ${newTaskSettings.permissionMode === "full-access" ? "is-danger" : ""}`}
                                title={`权限：${PERMISSION_MODE_LABELS[newTaskSettings.permissionMode ?? "ask"]}`}
                              >
                                <ShieldCheck aria-hidden="true" />
                                <span className="conversation-sr-only">权限模式</span>
                                <select
                                  name="initial-permission-mode"
                                  aria-label="权限模式"
                                  title={`权限：${PERMISSION_MODE_LABELS[newTaskSettings.permissionMode ?? "ask"]}`}
                                  value={newTaskSettings.permissionMode ?? "ask"}
                                  onChange={(event) =>
                                    updateNewTaskSettings({
                                      permissionMode: event.target.value as
                                        | "ask"
                                        | "auto"
                                        | "full-access",
                                    })
                                  }
                                >
                                  <option value="ask">权限：请求批准</option>
                                  <option value="auto">权限：帮我批准</option>
                                  <option value="full-access">权限：完全访问权限</option>
                                </select>
                              </label>
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
                            routes={data.modelRoutes}
                            providers={data.providerConfig.providers}
                            value={conversation.settings.modelRouteId}
                            currentLabel={conversation.settings.model}
                            disabled={Boolean(activeRun) || Boolean(busy)}
                            hasHistory={conversation.items.length > 0}
                            onChange={(modelRouteId) =>
                              actions.updateSessionSettings(sessionRef, { modelRouteId })
                            }
                            onConfigure={() => navigate("/settings/models")}
                          />

                          <label className="conversation-context-option">
                            <span className="conversation-sr-only">权限模式</span>
                            <select
                              name="permission-mode"
                              aria-label="权限模式"
                              title={`权限：${PERMISSION_MODE_LABELS[conversation.settings.permissionMode]}`}
                              value={conversation.settings.permissionMode}
                              disabled={Boolean(activeRun) || Boolean(busy)}
                              onChange={(event) =>
                                void actions.updateSessionSettings(sessionRef, {
                                  permissionMode: event.target.value as
                                    | "ask"
                                    | "auto"
                                    | "full-access",
                                })
                              }
                            >
                              <option value="ask">权限：请求批准</option>
                              <option value="auto">权限：帮我批准</option>
                              <option value="full-access">权限：完全访问权限</option>
                            </select>
                          </label>

                          {conversation.settings.reasoningLevels.length > 0 && (
                            <label className="conversation-context-option">
                              <span className="conversation-sr-only">Thinking</span>
                              <select
                                name="thinking-effort"
                                aria-label="Thinking"
                                value={conversation.settings.thinkingEffort}
                                disabled={Boolean(activeRun) || Boolean(busy)}
                                onChange={(event) =>
                                  void actions.updateSessionSettings(sessionRef, {
                                    thinkingEffort: event.target.value,
                                  })
                                }
                              >
                                {conversation.settings.reasoningLevels.map((level) => (
                                  <option key={level} value={level}>
                                    {level}
                                  </option>
                                ))}
                              </select>
                            </label>
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
              items={items}
              assistantLabel={
                parentRef
                  ? `子智能体 · ${childParent?.name ?? session?.title ?? "执行记录"}`
                  : "主智能体 · Pico"
              }
              onOpenItem={openItem}
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
                    <span className="conversation-wordmark" aria-label="Pico">
                      pico
                    </span>
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
  return {
    id: item.id,
    kind: "status",
    title: item.title,
    detail: item.detail,
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
