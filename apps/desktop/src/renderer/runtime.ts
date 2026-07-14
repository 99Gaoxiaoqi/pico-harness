import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptyData,
  folderWorkspaceCapabilities,
  type AppData,
  type ChangeView,
  type ConnectionState,
  type ConversationView,
  type JsonRecord,
  type UsageView,
  type WorkspaceCapabilities,
  type WorkspaceMode,
} from "./model.js";
import { previewData } from "./fixture.js";
import type {
  ComposerBehavior,
  ConversationItemView,
  ConversationProgressState,
} from "./conversation/types.js";

type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

interface RuntimeSubscription {
  readonly ready: Promise<DesktopResult<unknown>>;
  dispose(): void;
}

export interface RendererBridge {
  readonly runtime: Readonly<
    Record<string, (params: Readonly<Record<string, unknown>>) => Promise<DesktopResult<unknown>>>
  >;
  readonly events: {
    subscribe(
      params: Readonly<Record<string, unknown>>,
      listener: (event: unknown) => void,
    ): RuntimeSubscription;
  };
  readonly platform: {
    chooseWorkspace(): Promise<DesktopResult<string | undefined>>;
    openDirectory(path: string): Promise<DesktopResult<void>>;
    getLaunchAtLogin(): Promise<DesktopResult<boolean>>;
    setLaunchAtLogin(enabled: boolean): Promise<DesktopResult<void>>;
  };
  readonly lifecycle: {
    setBackgroundMode(enabled: boolean): Promise<DesktopResult<void>>;
    quit(): Promise<DesktopResult<void>>;
  };
}

function getBridge(): RendererBridge | undefined {
  return (window as unknown as { readonly pico?: RendererBridge }).pico;
}

export function isPreviewMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return params.get("demo") === "1" || hashParams.get("demo") === "1";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordArray(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function progressState(value: unknown): ConversationProgressState {
  return value === "done" || value === "failed" || value === "waiting" ? value : "active";
}

function conversationItem(item: JsonRecord, index: number): ConversationItemView | undefined {
  const id = stringValue(item.id, `conversation-item-${index}`);
  const at = numberValue(item.at) || undefined;
  if (item.kind === "userMessage" || item.kind === "assistantMessage") {
    const text = stringValue(item.content);
    if (!text) return undefined;
    return {
      id,
      kind: item.kind,
      text,
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "tool") {
    return {
      id,
      kind: "tool",
      toolName: stringValue(item.name, "tool"),
      title: stringValue(item.name, "工具调用"),
      detail: stringValue(item.args) || undefined,
      output: stringValue(item.summary) || undefined,
      state: item.status === "success" ? "done" : item.status === "error" ? "failed" : "active",
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "plan") {
    return {
      id,
      kind: "plan",
      title: stringValue(item.title, "执行计划"),
      steps: [
        {
          id: `${id}:step`,
          title: stringValue(item.detail ?? item.title, "计划已更新"),
          state: progressState(item.state),
        },
      ],
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "runBoundary") {
    const status = stringValue(item.status);
    return {
      id,
      kind: "runBoundary",
      status:
        status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "interrupted"
            : status === "succeeded"
              ? "completed"
              : "started",
      label: stringValue(item.label, status === "succeeded" ? "运行完成" : "Pico 正在处理"),
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "goal") {
    return {
      id,
      kind: "goal",
      title: stringValue(item.title, "当前目标"),
      detail: stringValue(item.detail) || undefined,
      state: progressState(item.state),
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "subagent") {
    return {
      id,
      kind: "subagent",
      name: stringValue(item.name, "Agent"),
      title: stringValue(item.title, "子代理活动"),
      detail: stringValue(item.detail) || undefined,
      state: progressState(item.state),
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "approval") {
    return {
      id,
      kind: "approval",
      title: stringValue(item.title, "需要你的批准"),
      detail: stringValue(item.detail, "Runtime 请求执行受保护操作。"),
      state: item.state === "allowed" || item.state === "denied" ? item.state : "pending",
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "prompt") {
    return {
      id,
      kind: "prompt",
      question: stringValue(item.title, "Pico 需要你的回答"),
      detail: stringValue(item.detail) || undefined,
      state: item.state === "answered" ? "answered" : "pending",
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "changes") {
    const data = isRecord(item.data) ? item.data : {};
    return {
      id,
      kind: "changes",
      title: stringValue(item.title, "文件已修改"),
      detail: stringValue(item.detail) || undefined,
      files: Array.isArray(data.files)
        ? data.files.map((file) => stringValue(file)).filter(Boolean)
        : [],
      state: item.state === "applied" || item.state === "conflict" ? item.state : "pending",
      ...(at ? { at } : {}),
    };
  }
  if (item.kind === "systemNotice" || item.kind === "error") {
    return {
      id,
      kind: "status",
      title: stringValue(item.content, item.kind === "error" ? "运行失败" : "状态更新"),
      tone: item.kind === "error" ? "error" : "neutral",
      ...(at ? { at } : {}),
    };
  }
  return undefined;
}

function parseConversation(value: unknown, sessionId: string): ConversationView {
  const result = isRecord(value) ? value : {};
  return {
    sessionId,
    items: recordArray(result.items)
      .map(conversationItem)
      .filter((item): item is ConversationItemView => item !== undefined),
    revision: stringValue(result.revision) || undefined,
    nextBefore: stringValue(result.nextBefore) || undefined,
    queuedCount: recordArray(result.queuedInputs).length,
  };
}

function parseChanges(value: unknown): {
  readonly changes: readonly ChangeView[];
  readonly fingerprint?: string | undefined;
} {
  const result = isRecord(value) ? value : {};
  return {
    changes: recordArray(result.changes).map((item) => ({
      path: stringValue(item.path),
      status:
        item.status === "added" || item.status === "deleted" || item.status === "renamed"
          ? item.status
          : "modified",
      additions: numberValue(item.additions),
      deletions: numberValue(item.deletions),
      patch: stringValue(item.patch) || undefined,
    })),
    fingerprint: stringValue(result.fingerprint) || undefined,
  };
}

function parseUsage(value: unknown): UsageView {
  const result = isRecord(value) ? value : {};
  const usage = isRecord(result.usage) ? result.usage : result;
  const total = isRecord(usage.total) ? usage.total : usage;
  return {
    inputTokens: numberValue(total.inputTokens || total.input_tokens) || undefined,
    outputTokens: numberValue(total.outputTokens || total.output_tokens) || undefined,
    cachedTokens: numberValue(total.cachedTokens || total.cached_tokens) || undefined,
    cost: numberValue(total.cost) || undefined,
    period: stringValue(usage.period || usage.rangeAccuracy),
  };
}

function capability(item: JsonRecord, index: number) {
  const enabled = item.enabled;
  const configured = item.configured;
  return {
    id: stringValue(item.id ?? item.name, `capability-${index}`),
    name: stringValue(item.name ?? item.id, "未命名能力"),
    description: stringValue(item.description, "由当前 Runtime 提供。"),
    state:
      configured === false || enabled === false
        ? ("disabled" as const)
        : item.error
          ? ("attention" as const)
          : ("ready" as const),
    meta: stringValue(item.model ?? item.version ?? item.status),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime 返回了未知错误。";
}

async function invoke(
  bridge: RendererBridge,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const call = bridge.runtime[method];
  if (!call) throw new Error(`当前 Runtime 不支持 ${method}`);
  const result = await call(params);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function optionalInvoke(
  bridge: RendererBridge,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ readonly value?: unknown; readonly error?: string }> {
  try {
    return { value: await invoke(bridge, method, params) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function parseWorkspaceList(value: unknown): readonly JsonRecord[] {
  if (!isRecord(value)) return [];
  return recordArray(value.workspaces);
}

function parseWorkspaceMode(value: unknown, fallback?: WorkspaceMode): WorkspaceMode | undefined {
  return value === "git" || value === "folder" ? value : fallback;
}

function parseWorkspaceCapabilities(
  value: unknown,
  mode: WorkspaceMode | undefined,
  fallback: WorkspaceCapabilities,
): WorkspaceCapabilities {
  const capabilities = isRecord(value) ? value : {};
  const defaults =
    mode === "git"
      ? {
          foregroundRuns: true,
          fileHistory: true,
          isolatedWorktrees: true,
          branchMerge: true,
        }
      : mode === "folder"
        ? folderWorkspaceCapabilities
        : fallback;
  return {
    foregroundRuns: booleanValue(capabilities.foregroundRuns, defaults.foregroundRuns),
    fileHistory: booleanValue(capabilities.fileHistory, defaults.fileHistory),
    isolatedWorktrees: booleanValue(capabilities.isolatedWorktrees, defaults.isolatedWorktrees),
    branchMerge: booleanValue(capabilities.branchMerge, defaults.branchMerge),
  };
}

function mergeLoadedData(base: AppData, results: Readonly<Record<string, unknown>>): AppData {
  const workspaceResult = isRecord(results.workspace) ? results.workspace : {};
  const workspaceMode = parseWorkspaceMode(workspaceResult.mode, base.workspaceMode);
  const sessionResult = isRecord(results.sessions) ? results.sessions : {};
  const runResult = isRecord(results.runs) ? results.runs : {};
  const jobResult = isRecord(results.jobs) ? results.jobs : {};
  const skillResult = isRecord(results.skills) ? results.skills : {};
  const mcpResult = isRecord(results.mcp) ? results.mcp : {};
  const providerResult = isRecord(results.providers) ? results.providers : {};
  const usageResult = isRecord(results.usage) ? results.usage : {};
  const usage = isRecord(usageResult.usage) ? usageResult.usage : {};
  const usageTotal = isRecord(usage.total) ? usage.total : usage;
  const configResult = isRecord(results.config) ? results.config : {};
  const changeResult = isRecord(results.changes) ? results.changes : {};

  return {
    ...base,
    workspaceMode,
    workspaceCapabilities: parseWorkspaceCapabilities(
      workspaceResult.capabilities,
      workspaceMode,
      base.workspaceCapabilities,
    ),
    sessions: recordArray(sessionResult.sessions).map((item, index) => ({
      id: stringValue(item.sessionId ?? item.id, `session-${index}`),
      title: stringValue(item.title, "未命名任务"),
      status: item.status === "archived" ? "archived" : "active",
      updatedAt: numberValue(item.updatedAt, Date.now()),
      summary: stringValue(item.summary),
    })),
    runs: recordArray(runResult.runs).map((item, index) => ({
      id: stringValue(item.runId ?? item.id, `run-${index}`),
      sessionId: stringValue(item.sessionId) || undefined,
      description: stringValue(item.description, "任务运行"),
      status: stringValue(item.status, "unknown"),
      startedAt: numberValue(item.startedAt, Date.now()),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    })),
    jobs: recordArray(jobResult.jobs).map((item, index) => ({
      id: stringValue(item.jobId ?? item.id, `job-${index}`),
      name: stringValue(item.name, "未命名自动化"),
      prompt: stringValue(item.prompt),
      schedule: stringValue(item.schedule),
      enabled: booleanValue(item.enabled),
      status: stringValue(item.status, "idle"),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    })),
    skills: recordArray(skillResult.skills).map(capability),
    mcpServers: recordArray(mcpResult.servers).map(capability),
    providers: recordArray(providerResult.providers).map(capability),
    changes: recordArray(changeResult.changes).map((item) => ({
      path: stringValue(item.path),
      status:
        item.status === "added" || item.status === "deleted" || item.status === "renamed"
          ? item.status
          : "modified",
      additions: numberValue(item.additions),
      deletions: numberValue(item.deletions),
      patch: stringValue(item.patch) || undefined,
    })),
    changeFingerprint: stringValue(changeResult.fingerprint) || undefined,
    usage: {
      inputTokens: numberValue(usageTotal.inputTokens || usageTotal.input_tokens) || undefined,
      outputTokens: numberValue(usageTotal.outputTokens || usageTotal.output_tokens) || undefined,
      cachedTokens: numberValue(usageTotal.cachedTokens || usageTotal.cached_tokens) || undefined,
      cost: numberValue(usageTotal.cost) || undefined,
      period: stringValue(usage.period || usage.rangeAccuracy),
    },
    configVersion: numberValue(configResult.version),
  };
}

export interface RuntimeActions {
  chooseWorkspace(): Promise<void>;
  trustWorkspace(trusted: boolean): Promise<void>;
  reload(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  sendMessage(input: {
    readonly sessionId?: string;
    readonly text: string;
    readonly behavior?: ComposerBehavior;
    readonly expectedRunId?: string;
  }): Promise<string | undefined>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  steerRun(runId: string, message: string): Promise<void>;
  respondApproval(id: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void>;
  respondPrompt(id: string, answer: string): Promise<void>;
  reviewChanges(
    decision: "approve" | "request_changes",
    message?: string,
    target?: { readonly runId: string; readonly fingerprint: string },
  ): Promise<void>;
  applyChanges(target?: { readonly runId: string; readonly fingerprint: string }): Promise<void>;
  previewRewind(sessionId: string): Promise<
    | {
        readonly checkpointId: string;
        readonly fingerprint: string;
        readonly changeCount: number;
      }
    | undefined
  >;
  applyRewind(sessionId: string, checkpointId: string, fingerprint: string): Promise<void>;
  toggleJob(id: string, enabled: boolean): Promise<void>;
  createJob(input: {
    readonly name: string;
    readonly prompt: string;
    readonly schedule: string;
  }): Promise<void>;
  runJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<void>;
  updateSetting(patch: Readonly<Record<string, unknown>>): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  setBackgroundMode(enabled: boolean): Promise<void>;
  openWorkspace(): Promise<void>;
}

export interface RuntimeStore {
  readonly preview: boolean;
  readonly connection: ConnectionState;
  readonly data: AppData;
  readonly busy: string | undefined;
  readonly message: string | undefined;
  readonly actions: RuntimeActions;
}

export function useRuntimeStore(): RuntimeStore {
  const preview = useMemo(isPreviewMode, []);
  const [connection, setConnection] = useState<ConnectionState>(
    preview ? { kind: "ready" } : { kind: "loading" },
  );
  const [data, setData] = useState<AppData>(preview ? previewData : emptyData);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const dataRef = useRef(data);
  dataRef.current = data;

  const reportFailure = useCallback((error: unknown) => {
    setMessage(errorMessage(error));
  }, []);

  const loadWorkspace = useCallback(async (bridge: RendererBridge, workspacePath: string) => {
    const params = { workspacePath };
    const entries = await Promise.all(
      [
        ["workspace", "workspace.status", params],
        ["sessions", "session.list", { ...params, includeArchived: true }],
        ["runs", "runs.list", params],
        ["jobs", "jobs.list", params],
        ["skills", "config.skills", params],
        ["mcp", "config.mcpServers", params],
        ["providers", "config.providers", params],
        ["usage", "usage.get", params],
        ["config", "config.get", params],
      ].map(async ([key, method, invocationParams]) => {
        const result = await optionalInvoke(
          bridge,
          String(method),
          invocationParams as Readonly<Record<string, unknown>>,
        );
        return [String(key), result] as const;
      }),
    );
    const values: Record<string, unknown> = {};
    const notices: Record<string, string> = {};
    for (const [key, result] of entries) {
      if (result.error) notices[key] = result.error;
      else values[key] = result.value;
    }
    const loadedRuns = isRecord(values.runs) ? recordArray(values.runs.runs) : [];
    const runId = stringValue(loadedRuns[0]?.runId);
    if (runId) {
      const changeList = await optionalInvoke(bridge, "changes.list", { workspacePath, runId });
      if (changeList.error) {
        notices.changes = changeList.error;
      } else {
        const listValue = isRecord(changeList.value) ? changeList.value : {};
        const changes = recordArray(listValue.changes);
        const hydrated = await Promise.all(
          changes.map(async (change) => {
            const path = stringValue(change.path);
            if (!path) return change;
            const diff = await optionalInvoke(bridge, "changes.diff", {
              workspacePath,
              runId,
              path,
            });
            const diffValue = isRecord(diff.value) ? diff.value : {};
            return { ...change, patch: stringValue(diffValue.patch) || undefined };
          }),
        );
        values.changes = { ...listValue, changes: hydrated };
      }
    }
    const trustResult = await optionalInvoke(bridge, "workspace.trustStatus", params);
    let launchAtLogin: boolean | undefined;
    try {
      const launchResult = await bridge.platform.getLaunchAtLogin();
      if (launchResult.ok) launchAtLogin = launchResult.value;
      else notices.desktopPreferences = launchResult.error.message;
    } catch (error) {
      notices.desktopPreferences = errorMessage(error);
    }
    if (trustResult.error) notices.trust = trustResult.error;
    const trustValue = isRecord(trustResult.value) ? trustResult.value : {};
    setData((current) =>
      mergeLoadedData(
        {
          ...current,
          workspacePath,
          trusted: booleanValue(trustValue.trusted),
          launchAtLogin,
          notices,
        },
        values,
      ),
    );
  }, []);

  const loadConversation = useCallback(
    async (bridge: RendererBridge, workspacePath: string, sessionId: string) => {
      if (preview) return;
      const value = await invoke(bridge, "session.transcript", {
        workspacePath,
        sessionId,
        limit: 200,
      });
      const record = isRecord(value) ? value : {};
      const activeRun = isRecord(record.activeRun) ? record.activeRun : undefined;
      const runId =
        stringValue(activeRun?.runId) ||
        dataRef.current.runs.find((run) => run.sessionId === sessionId)?.id;
      const sessionUsage = await optionalInvoke(bridge, "usage.get", { workspacePath, sessionId });
      let conversation: ConversationView = {
        ...parseConversation(record, sessionId),
        ...(!sessionUsage.error ? { usage: parseUsage(sessionUsage.value) } : {}),
      };
      if (runId) {
        const changeList = await optionalInvoke(bridge, "changes.list", { workspacePath, runId });
        if (!changeList.error) {
          const listValue = isRecord(changeList.value) ? changeList.value : {};
          const changes = await Promise.all(
            recordArray(listValue.changes).map(async (change) => {
              const path = stringValue(change.path);
              if (!path) return change;
              const diff = await optionalInvoke(bridge, "changes.diff", {
                workspacePath,
                runId,
                path,
              });
              const diffValue = isRecord(diff.value) ? diff.value : {};
              return { ...change, patch: stringValue(diffValue.patch) || undefined };
            }),
          );
          const parsed = parseChanges({ ...listValue, changes });
          conversation = {
            ...conversation,
            runId,
            changes: parsed.changes,
            changeFingerprint: parsed.fingerprint,
          };
        }
      }
      setData((current) => ({
        ...current,
        conversations: { ...current.conversations, [sessionId]: conversation },
        runs: activeRun
          ? [
              {
                id: stringValue(activeRun.runId),
                sessionId: stringValue(activeRun.sessionId, sessionId),
                description: stringValue(activeRun.description, "会话运行"),
                status: stringValue(activeRun.status, "running"),
                startedAt: numberValue(activeRun.startedAt, Date.now()),
                updatedAt: numberValue(activeRun.updatedAt, Date.now()),
              },
              ...current.runs.filter((run) => run.id !== stringValue(activeRun.runId)),
            ]
          : current.runs,
      }));
    },
    [preview],
  );

  const bootstrap = useCallback(async () => {
    if (preview) return;
    setConnection({ kind: "loading" });
    setMessage(undefined);
    const bridge = getBridge();
    if (!bridge) {
      setConnection({
        kind: "unavailable",
        detail: "安全桥接未加载。请从 Pico 桌面应用启动，而不是直接打开页面。",
      });
      return;
    }
    try {
      const pingValue = await invoke(bridge, "runtime.ping", {});
      const ping = isRecord(pingValue) ? pingValue : {};
      const capabilities = Array.isArray(ping.capabilities)
        ? ping.capabilities.map((capability) => stringValue(capability))
        : [];
      if (!capabilities.includes("session-conversation-v1")) {
        throw new Error("当前 Runtime 缺少会话能力。请完全退出并重新启动 Pico。");
      }
      const workspaceValue = await invoke(bridge, "workspace.list", {});
      const workspaces = parseWorkspaceList(workspaceValue);
      const workspacePath = stringValue(
        workspaces.find(
          (workspace) =>
            booleanValue(workspace.registered, true) &&
            Boolean(stringValue(workspace.workspacePath)),
        )?.workspacePath,
      );
      if (workspacePath) await loadWorkspace(bridge, workspacePath);
      else setData(emptyData);
      setConnection({ kind: "ready" });
    } catch (error) {
      setConnection({ kind: "error", detail: errorMessage(error), retryable: true });
    }
  }, [loadWorkspace, preview]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (preview || connection.kind !== "ready" || !data.workspacePath) return;
    const bridge = getBridge();
    if (!bridge) return;
    const subscription = bridge.events.subscribe({ workspacePath: data.workspacePath }, (event) => {
      if (!isRecord(event)) return;
      const payload = isRecord(event.payload) ? event.payload : {};
      const scope = isRecord(event.scope) ? event.scope : {};
      const topic = stringValue(event.topic);
      if (topic === "approval.requested") {
        const request = isRecord(payload.request) ? payload.request : {};
        setData((current) => ({
          ...current,
          approvals: [
            ...current.approvals.filter((item) => item.id !== stringValue(payload.approvalId)),
            {
              id: stringValue(payload.approvalId),
              runId: stringValue(payload.runId),
              title: stringValue(request.title, "需要你的批准"),
              detail: stringValue(
                request.detail ?? request.description,
                "Runtime 请求执行受保护操作。",
              ),
              command: stringValue(request.command) || undefined,
              risk: request.risk === "high" || request.risk === "medium" ? request.risk : "low",
            },
          ],
        }));
      } else if (topic === "prompt.requested") {
        const prompt = isRecord(payload.prompt) ? payload.prompt : {};
        const options = Array.isArray(prompt.options)
          ? prompt.options.map((item) =>
              isRecord(item) ? stringValue(item.label) : stringValue(item),
            )
          : [];
        setData((current) => ({
          ...current,
          prompts: [
            ...current.prompts.filter((item) => item.id !== stringValue(payload.promptId)),
            {
              id: stringValue(payload.promptId),
              runId: stringValue(payload.runId),
              question: stringValue(prompt.question ?? prompt.message, "Pico 需要你的选择"),
              options,
            },
          ],
        }));
      } else if (topic === "approval.resolved") {
        const approvalId = stringValue(payload.approvalId);
        setData((current) => ({
          ...current,
          approvals: current.approvals.filter((approval) => approval.id !== approvalId),
        }));
      } else if (topic === "prompt.resolved") {
        const promptId = stringValue(payload.promptId);
        setData((current) => ({
          ...current,
          prompts: current.prompts.filter((prompt) => prompt.id !== promptId),
        }));
      } else if (topic === "run.timeline") {
        const item = isRecord(payload.item) ? payload.item : {};
        setData((current) => ({
          ...current,
          timeline: [
            ...current.timeline,
            {
              id: stringValue(event.eventId, `timeline-${Date.now()}`),
              kind:
                item.kind === "plan" || item.kind === "tool" || item.kind === "agent"
                  ? item.kind
                  : "status",
              title: stringValue(item.title ?? item.message, "运行状态已更新"),
              detail: stringValue(item.detail),
              state: item.state === "failed" ? "failed" : item.state === "done" ? "done" : "active",
              at: numberValue(event.at, Date.now()),
              sessionId: stringValue(scope.sessionId) || undefined,
              runId: stringValue(scope.runId ?? payload.runId) || undefined,
              eventType: stringValue(item.eventType) || undefined,
            },
          ],
        }));
      } else if (topic.startsWith("run.") || topic.startsWith("session.")) {
        const workspace = dataRef.current.workspacePath;
        if (workspace) {
          void loadWorkspace(bridge, workspace);
          const sessionId = stringValue(scope.sessionId);
          if (sessionId) void loadConversation(bridge, workspace, sessionId);
        }
      }
    });
    void subscription.ready.then((result) => {
      if (!result.ok) setMessage(`事件订阅失败：${result.error.message}`);
    });
    return () => subscription.dispose();
  }, [connection.kind, data.workspacePath, loadConversation, loadWorkspace, preview]);

  const perform = useCallback(
    async (label: string, operation: (bridge: RendererBridge) => Promise<void>) => {
      setBusy(label);
      setMessage(undefined);
      try {
        if (preview) {
          await operation(createPreviewBridge());
          return;
        }
        const bridge = getBridge();
        if (!bridge) throw new Error("桌面安全桥接不可用。");
        await operation(bridge);
      } catch (error) {
        reportFailure(error);
      } finally {
        setBusy(undefined);
      }
    },
    [preview, reportFailure],
  );

  const actions = useMemo<RuntimeActions>(
    () => ({
      async chooseWorkspace() {
        await perform("choose-workspace", async (bridge) => {
          const result = await bridge.platform.chooseWorkspace();
          if (!result.ok) throw new Error(result.error.message);
          if (!result.value) return;
          const registeredValue = await invoke(bridge, "workspace.register", {
            workspacePath: result.value,
          });
          const registered = isRecord(registeredValue) ? registeredValue : {};
          const workspacePath = stringValue(registered.workspacePath, result.value);
          setData({ ...emptyData, workspacePath });
          if (!preview) await loadWorkspace(bridge, workspacePath);
        });
      },
      async trustWorkspace(trusted) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("trust-workspace", async (bridge) => {
          if (!preview) await invoke(bridge, "workspace.trust", { workspacePath, trusted });
          setData((current) => ({ ...current, trusted }));
        });
      },
      reload: bootstrap,
      async loadSession(sessionId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !sessionId) return;
        await perform("load-session", async (bridge) => {
          if (!preview) await loadConversation(bridge, workspacePath, sessionId);
        });
      },
      async sendMessage(input) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !input.text.trim()) return undefined;
        let resolvedSessionId = input.sessionId;
        await perform("send-message", async (bridge) => {
          if (preview) {
            resolvedSessionId ??= "session-atlas";
            const sessionId = resolvedSessionId;
            if (!sessionId) return;
            setData((current) => {
              const conversation = current.conversations[sessionId] ?? {
                sessionId,
                items: [],
                queuedCount: 0,
              };
              return {
                ...current,
                conversations: {
                  ...current.conversations,
                  [sessionId]: {
                    ...conversation,
                    items: [
                      ...conversation.items,
                      {
                        id: `preview-user-${Date.now()}`,
                        kind: "userMessage" as const,
                        text: input.text.trim(),
                        at: Date.now(),
                      },
                    ],
                  },
                },
              };
            });
            return;
          }
          const value = await invoke(bridge, "session.send", {
            workspacePath,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            input: { text: input.text.trim() },
            behavior: input.behavior ?? "auto",
            ...(input.expectedRunId ? { expectedRunId: input.expectedRunId } : {}),
            idempotencyKey: crypto.randomUUID(),
          });
          const result = isRecord(value) ? value : {};
          const session = isRecord(result.session) ? result.session : {};
          resolvedSessionId = stringValue(session.sessionId, input.sessionId);
          await loadWorkspace(bridge, workspacePath);
          if (resolvedSessionId) {
            await loadConversation(bridge, workspacePath, resolvedSessionId);
          }
        });
        return resolvedSessionId;
      },
      async setSessionArchived(sessionId, archived) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("session-state", async (bridge) => {
          if (!preview)
            await invoke(bridge, archived ? "session.archive" : "session.restore", {
              workspacePath,
              sessionId,
            });
          setData((current) => ({
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === sessionId
                ? { ...session, status: archived ? "archived" : "active" }
                : session,
            ),
          }));
        });
      },
      async pauseRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("pause-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.pause", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.id === runId ? { ...run, status: "pause_requested" } : run,
            ),
          }));
        });
      },
      async resumeRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("resume-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.resume", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.id === runId ? { ...run, status: "running" } : run,
            ),
          }));
        });
      },
      async stopRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("stop-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.cancel", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.id === runId ? { ...run, status: "cancelling" } : run,
            ),
          }));
        });
      },
      async steerRun(runId, messageText) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !messageText.trim()) return;
        await perform("steer-run", async (bridge) => {
          if (!preview)
            await invoke(bridge, "run.steer", {
              workspacePath,
              runId,
              message: messageText.trim(),
            });
          setMessage("新指令已排队，会在安全边界生效。");
        });
      },
      async respondApproval(id, decision) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("approval", async (bridge) => {
          if (!preview)
            await invoke(bridge, "approval.respond", {
              workspacePath,
              approvalId: id,
              decision,
              idempotencyKey: crypto.randomUUID(),
            });
          setData((current) => ({
            ...current,
            approvals: current.approvals.filter((approval) => approval.id !== id),
          }));
        });
      },
      async respondPrompt(id, answer) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !answer.trim()) return;
        await perform("prompt", async (bridge) => {
          if (!preview)
            await invoke(bridge, "prompt.respond", {
              workspacePath,
              promptId: id,
              answer: answer.trim(),
              idempotencyKey: crypto.randomUUID(),
            });
          setData((current) => ({
            ...current,
            prompts: current.prompts.filter((prompt) => prompt.id !== id),
          }));
        });
      },
      async reviewChanges(decision, reviewMessage, target) {
        const workspacePath = dataRef.current.workspacePath;
        const runId = target?.runId ?? dataRef.current.runs[0]?.id;
        const expectedFingerprint = target?.fingerprint ?? dataRef.current.changeFingerprint;
        if (!workspacePath || !runId || !expectedFingerprint) return;
        await perform("review", async (bridge) => {
          if (!preview)
            await invoke(bridge, "changes.review", {
              workspacePath,
              runId,
              decision,
              expectedFingerprint,
              ...(reviewMessage ? { message: reviewMessage } : {}),
            });
          setMessage(decision === "approve" ? "更改已批准，等待应用。" : "修改意见已发回任务。");
        });
      },
      async applyChanges(target) {
        const workspacePath = dataRef.current.workspacePath;
        const runId = target?.runId ?? dataRef.current.runs[0]?.id;
        const expectedFingerprint = target?.fingerprint ?? dataRef.current.changeFingerprint;
        if (!workspacePath || !runId || !expectedFingerprint) return;
        await perform("apply", async (bridge) => {
          if (!preview)
            await invoke(bridge, "changes.apply", { workspacePath, runId, expectedFingerprint });
          setMessage("更改已应用到工作区。");
        });
      },
      async previewRewind(sessionId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return undefined;
        let previewResult:
          | {
              readonly checkpointId: string;
              readonly fingerprint: string;
              readonly changeCount: number;
            }
          | undefined;
        await perform("rewind-preview", async (bridge) => {
          if (preview) {
            previewResult = {
              checkpointId: "preview-checkpoint",
              fingerprint: "preview-rewind:54b9c2",
              changeCount: dataRef.current.changes.length,
            };
            return;
          }
          const listValue = await invoke(bridge, "rewind.list", { workspacePath, sessionId });
          const list = isRecord(listValue) ? recordArray(listValue.checkpoints) : [];
          const checkpoint = [...list].sort(
            (left, right) => numberValue(right.createdAt) - numberValue(left.createdAt),
          )[0];
          const checkpointId = checkpoint ? stringValue(checkpoint.checkpointId) : "";
          if (!checkpointId) throw new Error("当前会话没有可用检查点。");
          const value = await invoke(bridge, "rewind.preview", {
            workspacePath,
            sessionId,
            checkpointId,
          });
          const result = isRecord(value) ? value : {};
          previewResult = {
            checkpointId,
            fingerprint: stringValue(result.fingerprint),
            changeCount: recordArray(result.changes).length,
          };
        });
        return previewResult;
      },
      async applyRewind(sessionId, checkpointId, fingerprint) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !fingerprint) return;
        await perform("rewind-apply", async (bridge) => {
          if (!preview)
            await invoke(bridge, "rewind.apply", {
              workspacePath,
              sessionId,
              checkpointId,
              expectedFingerprint: fingerprint,
            });
          setMessage("已回到检查点。Runtime 已使用预览指纹重新验证。");
          if (!preview) await loadWorkspace(bridge, workspacePath);
        });
      },
      async toggleJob(id, enabled) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("toggle-job", async (bridge) => {
          if (!preview)
            await invoke(bridge, "jobs.setEnabled", { workspacePath, jobId: id, enabled });
          setData((current) => ({
            ...current,
            jobs: current.jobs.map((job) => (job.id === id ? { ...job, enabled } : job)),
          }));
        });
      },
      async createJob(input) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !input.name.trim() || !input.prompt.trim() || !input.schedule.trim())
          return;
        await perform("create-job", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              jobs: [
                ...current.jobs,
                {
                  id: `preview-job-${Date.now()}`,
                  name: input.name.trim(),
                  prompt: input.prompt.trim(),
                  schedule: input.schedule.trim(),
                  enabled: true,
                  status: "idle",
                  updatedAt: Date.now(),
                },
              ],
            }));
          } else {
            await invoke(bridge, "jobs.create", {
              workspacePath,
              name: input.name.trim(),
              prompt: input.prompt.trim(),
              schedule: input.schedule.trim(),
              enabled: true,
            });
            await loadWorkspace(bridge, workspacePath);
          }
        });
      },
      async runJob(id) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("run-job", async (bridge) => {
          if (!preview) await invoke(bridge, "jobs.runNow", { workspacePath, jobId: id });
          setData((current) => ({
            ...current,
            jobs: current.jobs.map((job) =>
              job.id === id ? { ...job, status: "running", updatedAt: Date.now() } : job,
            ),
          }));
        });
      },
      async deleteJob(id) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("delete-job", async (bridge) => {
          if (!preview) await invoke(bridge, "jobs.delete", { workspacePath, jobId: id });
          setData((current) => ({
            ...current,
            jobs: current.jobs.filter((job) => job.id !== id),
          }));
        });
      },
      async updateSetting(patch) {
        const current = dataRef.current;
        if (!current.workspacePath) return;
        await perform("setting", async (bridge) => {
          if (!preview)
            await invoke(bridge, "config.update", {
              workspacePath: current.workspacePath,
              patch,
              expectedVersion: current.configVersion,
            });
          setData((value) => ({ ...value, configVersion: value.configVersion + 1 }));
          setMessage("设置已保存。");
        });
      },
      async setLaunchAtLogin(enabled) {
        await perform("launch-at-login", async (bridge) => {
          const result = await bridge.platform.setLaunchAtLogin(enabled);
          if (!result.ok) throw new Error(result.error.message);
          setData((current) => ({ ...current, launchAtLogin: enabled }));
          setMessage(enabled ? "已开启登录时启动。" : "已关闭登录时启动。");
        });
      },
      async setBackgroundMode(enabled) {
        await perform("background-mode", async (bridge) => {
          const result = await bridge.lifecycle.setBackgroundMode(enabled);
          if (!result.ok) throw new Error(result.error.message);
          setMessage(enabled ? "关闭窗口后 Pico 会继续运行。" : "关闭窗口时 Pico 将退出。");
        });
      },
      async openWorkspace() {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("open-workspace", async (bridge) => {
          const result = await bridge.platform.openDirectory(workspacePath);
          if (!result.ok) throw new Error(result.error.message);
        });
      },
    }),
    [bootstrap, loadConversation, loadWorkspace, perform, preview],
  );

  return { preview, connection, data, busy, message, actions };
}

function createPreviewBridge(): RendererBridge {
  const success = <T>(value: T): Promise<DesktopResult<T>> => Promise.resolve({ ok: true, value });
  return {
    runtime: new Proxy(
      {},
      {
        get: () => () => success({}),
      },
    ),
    events: {
      subscribe: () => ({
        ready: success({ subscribed: true, events: [] }),
        dispose: () => undefined,
      }),
    },
    platform: {
      chooseWorkspace: () => success(previewData.workspacePath),
      openDirectory: () => success(undefined),
      getLaunchAtLogin: () => success(false),
      setLaunchAtLogin: () => success(undefined),
    },
    lifecycle: {
      setBackgroundMode: () => success(undefined),
      quit: () => success(undefined),
    },
  };
}
