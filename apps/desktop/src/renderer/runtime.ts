import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  isJsonValue,
  isTerminalRunStatus,
  parseApprovalRequestedPayload,
  type DesktopRuntimeMethod,
  type RuntimeDiagnosticCheck,
  type RuntimeMcpServerInput,
  type RuntimeMemoryFact,
  type RuntimeMemorySettings,
  type RuntimeNotification,
  type RuntimeParams,
  type RuntimeProviderInput,
  type RuntimeResult,
  type RuntimeUserDefaults,
} from "@pico/protocol";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopBridge, DesktopResult } from "../preload/contract.js";
import { ConversationLoadTracker } from "./conversation-load-tracker.js";
import { mergeHydratedConversationItems } from "./conversation/items.js";
import {
  type RuntimeTranscriptCursor,
  type RuntimeTranscriptFragment,
  type ToolEvidencePage,
  approvalFromPlanControlSnapshot,
  conversationItemsFromReplica,
  overlayRuntimeItem,
  parseConversation,
  parseGoalItem,
  resolveApprovalState,
  resolvePromptState,
  toolEvidencePage,
} from "./conversation/runtime-projection.js";
import type { ComposerBehavior } from "./conversation/types.js";
import { previewData } from "./fixture.js";
import {
  emptyData,
  type AppData,
  type AppRuntimePhase,
  type CapabilityView,
  type ConversationView,
  type MemoryFactPatch,
  type MemorySettingsPatch,
  type ProviderDraft,
  type ProviderView,
  type UsageView,
  type WorkspaceView,
} from "./model.js";
import { saveProviderConnection } from "./provider-connection.js";
import {
  capability,
  parseCatalogAgents,
  parseCatalogSkills,
  parseModelRoutes,
  parseProviderConfig,
  scopedMcpServer,
  scopedSkill,
} from "./runtime-projections/configuration.js";
import {
  booleanValue,
  isRecord,
  numberValue,
  recordArray,
  stringValue,
} from "./runtime-projections/values.js";
import {
  compareSessions,
  parseChanges,
  parseRuns,
  parseSessionContext,
  parseSessionSettings,
  parseSessions,
  parseWorkspaceCapabilities,
  parseWorkspaceList,
  parseWorkspaceMode,
} from "./runtime-projections/workspace.js";
import {
  DesktopSessionContinuity,
  type DesktopSessionContinuityTransport,
} from "./session-continuity.js";
import { parseSwarmCommand } from "./swarm-command.js";
import { TemporaryWorkspaceRequest } from "./temporary-workspace-request.js";
import { applyTimelineNotification } from "./timeline.js";
import { parseUsage } from "./usage/runtime-projection.js";
import {
  TEMPORARY_WORKSPACE_LABEL,
  replaceWorkspaceItems,
  workspaceName,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "./workspace-session.js";

const SHARED_CONFIG_CAPABILITY = "shared-config-v1";

const WORKSPACE_MEMORY_CAPABILITY = "workspace-memory-v1";

const MAX_RENDERER_SEEN_EVENT_IDS = 10_000;

export function isMemoryNotificationTopic(topic: string): boolean {
  return topic === "memory.proposed" || topic === "memory.changed" || topic === "memory.forgotten";
}

export function shouldBatchHydrateRuntimeNotification(topic: string): boolean {
  return (
    topic === "plan.updated" ||
    topic === "discovery.updated" ||
    topic.startsWith("session.") ||
    (topic.startsWith("run.") && topic !== "run.started" && topic !== "run.timeline")
  );
}

export function isMemoryConflict(error: unknown): boolean {
  return error instanceof RuntimeInvocationError && error.code === "CONFLICT";
}

function getBridge(): DesktopBridge | undefined {
  return window.pico;
}

export function isPreviewMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return params.get("demo") === "1" || hashParams.get("demo") === "1";
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Runtime 返回了未知错误。";
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : undefined;
  return friendlyRuntimeMessage(raw, code);
}

/**
 * 把常见的技术性运行时错误归一化为可理解的中文提示 + 可操作建议，让普通用户知道
 * "出错了"和"该怎么做"，而非面对 socket/auth 英文报错。未匹配的原始错误原样返回。
 */
function friendlyRuntimeMessage(raw: string, code?: string): string {
  if (code === "RUNTIME_UNAVAILABLE" || code === "RUNTIME_DISCONNECTED") {
    return "无法连接本地 Runtime，连接恢复后会自动重试；若持续失败可重启 Pico 桌面应用。";
  }
  if (code === "RUNTIME_AUTH_FAILED") {
    return "本地 Runtime 认证失败，请重启 Pico 桌面应用。";
  }
  const lower = raw.toLowerCase();
  if (/api key|unauthorized|\b401\b|invalid.*credential|authentication failed/.test(lower)) {
    return "模型凭证无效或未配置，请到“模型”页检查 Provider 的 API Key。";
  }
  if (/econnrefused|etimedout|fetch failed|socket hang up|network error/.test(lower)) {
    return "无法连接本地 Runtime 或模型服务，请检查网络或重启 Pico。";
  }
  if (/rate limit|\b429\b|too many requests/.test(lower)) {
    return "请求过于频繁或触发限流，请稍后重试。";
  }
  return raw;
}

export class RuntimeInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`);
    this.name = "RuntimeInvocationError";
  }
}

async function invoke<Method extends DesktopRuntimeMethod>(
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<RuntimeResult<Method>> {
  const call = bridge.runtime[method];
  const result = await call(params);
  if (!result.ok) {
    throw new RuntimeInvocationError(
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  }
  return result.value;
}

async function optionalInvoke<Method extends DesktopRuntimeMethod>(
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<
  | { readonly value: RuntimeResult<Method>; readonly error?: never }
  | { readonly value?: never; readonly error: string }
> {
  try {
    return { value: await invoke(bridge, method, params) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function optionalEntry<Key extends string, Method extends DesktopRuntimeMethod>(
  key: Key,
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
) {
  return [key, await optionalInvoke(bridge, method, params)] as const;
}

function mergeLoadedData(
  base: AppData,
  workspacePath: string,
  results: Readonly<Record<string, unknown>>,
): AppData {
  const workspaceResult = isRecord(results.workspace) ? results.workspace : {};
  const workspaceMode = parseWorkspaceMode(workspaceResult.mode, base.workspaceMode);
  const jobResult = isRecord(results.jobs) ? results.jobs : {};
  const providerResult = isRecord(results.legacyProviders) ? results.legacyProviders : {};
  const usageResult = isRecord(results.usage) ? results.usage : {};
  const usage = isRecord(usageResult.usage) ? usageResult.usage : {};
  const configResult = isRecord(results.config) ? results.config : {};
  const changeResult = isRecord(results.changes) ? results.changes : {};
  const agentCatalogResult = isRecord(results.agentCatalog) ? results.agentCatalog : {};
  const skillCatalogResult = isRecord(results.skillCatalog) ? results.skillCatalog : {};

  return {
    ...base,
    workspaceMode,
    workspaceBranch: stringValue(workspaceResult.branch) || undefined,
    workspaceCapabilities: parseWorkspaceCapabilities(
      workspaceResult.capabilities,
      workspaceMode,
      base.workspaceCapabilities,
    ),
    sessions: [
      ...replaceWorkspaceItems(
        base.sessions,
        workspacePath,
        parseSessions(results.sessions, workspacePath),
      ),
    ].sort(compareSessions),
    runs: [
      ...replaceWorkspaceItems(base.runs, workspacePath, parseRuns(results.runs, workspacePath)),
    ].sort((left, right) => right.updatedAt - left.updatedAt),
    jobs: recordArray(jobResult.jobs).map((item, index) => ({
      id: stringValue(item.jobId ?? item.id, `job-${index}`),
      name: stringValue(item.name, "未命名自动化"),
      prompt: stringValue(item.prompt),
      schedule: stringValue(item.schedule),
      enabled: booleanValue(item.enabled),
      status: stringValue(item.status, "idle"),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    })),
    providers: recordArray(providerResult.providers).map(capability),
    modelRoutes:
      isRecord(results.effectiveConfig) && isRecord(results.effectiveConfig.config)
        ? parseModelRoutes(results.effectiveConfig.config)
        : base.modelRoutes,
    catalogAgents: parseCatalogAgents(agentCatalogResult),
    catalogSkills: parseCatalogSkills(skillCatalogResult),
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
    usage: parseUsage({ usage }),
    configVersion: numberValue(configResult.version),
  };
}

export interface RuntimeActions {
  dismissMessage(): void;
  showMessage?(message: string): void;
  chooseWorkspace(): Promise<string | undefined>;
  registerWorkspace(): Promise<string | undefined>;
  ensureTemporaryWorkspace(): Promise<string | undefined>;
  selectWorkspace(workspacePath: string): Promise<void>;
  trustWorkspace(workspacePath: string, trusted: boolean): Promise<void>;
  unregisterWorkspace(workspacePath: string): Promise<void>;
  reload(): Promise<void>;
  loadSession(ref: WorkspaceSessionRef): Promise<void>;
  loadEarlierSession(ref: WorkspaceSessionRef): Promise<void>;
  readToolEvidence(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly evidenceUri: string;
    readonly offsetBytes?: number;
    readonly limitBytes?: number;
  }): Promise<ToolEvidencePage | undefined>;
  sendMessage(input: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly text: string;
    readonly initialSettings?: RuntimeUserDefaults;
    readonly behavior?: ComposerBehavior;
    readonly expectedRunId?: string;
    readonly activation?:
      | { readonly kind: "skill"; readonly name: string }
      | { readonly kind: "agent"; readonly name: string };
  }): Promise<{
    readonly succeeded: boolean;
    readonly workspacePath?: string | undefined;
    readonly sessionId?: string | undefined;
  }>;
  renameSession(ref: WorkspaceSessionRef, title: string): Promise<void>;
  forkSession(ref: WorkspaceSessionRef): Promise<WorkspaceSessionRef | undefined>;
  compactSession(ref: WorkspaceSessionRef): Promise<void>;
  updateSessionSettings(
    ref: WorkspaceSessionRef,
    patch: Readonly<{
      modelRouteId?: string;
      collaborationMode?: "agent" | "plan";
      orchestrationMode?: "default" | "graph" | "swarm";
      permissionMode?: "default" | "auto" | "yolo";
      thinkingEffort?: string;
    }>,
  ): Promise<void>;
  setSessionArchived(ref: WorkspaceSessionRef, archived: boolean): Promise<void>;
  setSessionPinned(ref: WorkspaceSessionRef, pinned: boolean): Promise<void>;
  deleteSession(ref: WorkspaceSessionRef): Promise<boolean>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  steerRun(runId: string, message: string): Promise<void>;
  respondApproval(id: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void>;
  respondPlan(input: {
    readonly planId: string;
    readonly sessionId: string;
    readonly action:
      | "execute"
      | "continue_editing"
      | "reject_exit"
      | "resume_execution"
      | "cancel_execution"
      | "replan_execution";
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
    readonly controlEpoch: string;
    readonly feedback?: string;
  }): Promise<void>;
  respondPrompt(id: string, answer: string): Promise<void>;
  loadChangeDiff(input: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly runId: string;
    readonly path: string;
  }): Promise<void>;
  reviewChanges(
    decision: "approve" | "request_changes",
    message?: string,
    target?: { readonly runId: string; readonly fingerprint: string },
  ): Promise<void>;
  applyChanges(target?: { readonly runId: string; readonly fingerprint: string }): Promise<void>;
  previewRewind(ref: WorkspaceSessionRef): Promise<
    | {
        readonly checkpointId: string;
        readonly fingerprint: string;
        readonly changeCount: number;
      }
    | undefined
  >;
  applyRewind(ref: WorkspaceSessionRef, checkpointId: string, fingerprint: string): Promise<void>;
  toggleJob(id: string, enabled: boolean): Promise<void>;
  createJob(input: {
    readonly name: string;
    readonly prompt: string;
    readonly schedule: string;
  }): Promise<void>;
  runJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<void>;
  loadCapabilityScope(kind: "skills" | "mcp", workspacePath?: string): Promise<void>;
  addUserMcp(server: RuntimeMcpServerInput): Promise<boolean>;
  deleteUserMcp(serverName: string): Promise<boolean>;
  upsertProvider(
    provider: ProviderDraft,
    newConnectionSecret?: string,
    createOnly?: boolean,
  ): Promise<boolean>;
  deleteProvider(providerId: string): Promise<boolean>;
  setDefaultModelRoute(modelRouteId?: string): Promise<boolean>;
  queryUsage(input?: {
    readonly workspacePath?: string;
    readonly from?: number;
    readonly to?: number;
  }): Promise<UsageView | undefined>;
  setProviderCredential(
    providerId: string,
    secret: string,
    expectedRevision: string,
  ): Promise<boolean>;
  deleteProviderCredential(providerId: string, expectedRevision: string): Promise<boolean>;
  refreshMemory(): Promise<void>;
  createMemoryFact(text: string): Promise<RuntimeMemoryFact | undefined>;
  updateMemoryFact(
    factId: string,
    expectedVersion: number,
    patch: MemoryFactPatch,
  ): Promise<RuntimeMemoryFact | undefined>;
  forgetMemoryFact(factId: string, expectedVersion: number): Promise<boolean>;
  updateMemorySettings(
    expectedVersion: number,
    patch: MemorySettingsPatch,
  ): Promise<RuntimeMemorySettings | undefined>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  setBackgroundMode(enabled: boolean): Promise<void>;
  openWorkspace(workspacePath?: string): Promise<void>;
  initializeWorkspace(workspacePath?: string): Promise<void>;
  runDiagnostics(
    kind: "runtime" | "resources",
    workspacePath?: string,
  ): Promise<DesktopDiagnosticReport | undefined>;
}

export interface DesktopDiagnosticReport {
  readonly kind: "runtime" | "resources";
  readonly healthy: boolean;
  readonly checks: readonly RuntimeDiagnosticCheck[];
  readonly output: string;
}

export interface RuntimeStore {
  readonly preview: boolean;
  readonly connection: AppRuntimePhase;
  readonly data: AppData;
  readonly busy: string | undefined;
  readonly message: string | undefined;
  readonly actions: RuntimeActions;
}

export function useRuntimeStore(): RuntimeStore {
  const preview = useMemo(isPreviewMode, []);
  const [connection, setConnection] = useState<AppRuntimePhase>(
    preview ? { kind: "ready" } : { kind: "loading" },
  );
  const [data, setData] = useState<AppData>(preview ? previewData : emptyData);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const dataRef = useRef(data);
  const runtimeCapabilitiesRef = useRef(
    new Set<string>(
      preview
        ? [
            SHARED_CONFIG_CAPABILITY,
            WORKSPACE_MEMORY_CAPABILITY,
            CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
          ]
        : [],
    ),
  );
  const seenEventIdsRef = useRef(new Set<string>());
  const workspaceIndexLoadGenerationRef = useRef(0);
  const workspaceLoadGenerationRef = useRef(0);
  const workspaceLoadIntentRef = useRef<string | undefined>(undefined);
  const providerConfigLoadGenerationRef = useRef(0);
  const memoryLoadGenerationRef = useRef(0);
  const conversationLoadTracker = useRef(new ConversationLoadTracker());
  const temporaryWorkspaceRequest = useRef(new TemporaryWorkspaceRequest());
  const transcriptCursorByConversation = useRef(new Map<string, RuntimeTranscriptCursor>());
  const transcriptFragmentsByConversation = useRef(
    new Map<string, Map<string, RuntimeTranscriptFragment[]>>(),
  );
  const desktopContinuityRef = useRef<DesktopSessionContinuity | undefined>(undefined);
  const desktopContinuityBridgeRef = useRef<DesktopBridge | undefined>(undefined);
  const pendingSendRef = useRef<
    | {
        readonly identity: string;
        readonly idempotencyKey: string;
      }
    | undefined
  >(undefined);
  dataRef.current = data;

  const applyReplicaView = useCallback(
    (workspacePath: string, sessionId: string, view: TranscriptReplicaView) => {
      const conversationKey = workspaceSessionKey({ workspacePath, sessionId });
      const activeRun =
        view.activeRun && !isTerminalRunStatus(view.activeRun.status) ? view.activeRun : undefined;
      setData((current) => {
        const existing = current.conversations[conversationKey] ?? {
          workspacePath,
          sessionId,
          items: [],
          queuedCount: 0,
        };
        // A failed open may recover through the continuity controller's background retry.
        // Once a ready replica arrives, the old load error is no longer authoritative.
        const {
          runId: _previousRunId,
          loadError: _previousLoadError,
          ...conversationWithoutRun
        } = existing;
        return {
          ...current,
          conversations: {
            ...current.conversations,
            [conversationKey]: {
              ...conversationWithoutRun,
              items: conversationItemsFromReplica(view),
              queuedCount: view.queuedInputs.length,
              ...(activeRun ? { runId: activeRun.runId } : {}),
            },
          },
          runs: view.activeRun
            ? [
                {
                  id: view.activeRun.runId,
                  workspacePath,
                  sessionId,
                  description: view.activeRun.description,
                  status: view.activeRun.status,
                  startedAt: view.activeRun.startedAt,
                  updatedAt: view.activeRun.updatedAt,
                },
                ...current.runs.filter(
                  (run) => run.workspacePath !== workspacePath || run.id !== view.activeRun?.runId,
                ),
              ]
            : current.runs,
        };
      });
    },
    [],
  );

  const ensureDesktopContinuity = useCallback(
    (bridge: DesktopBridge): DesktopSessionContinuity => {
      if (desktopContinuityRef.current && desktopContinuityBridgeRef.current === bridge) {
        return desktopContinuityRef.current;
      }
      desktopContinuityRef.current?.dispose();
      const transport: DesktopSessionContinuityTransport = {
        open: (params) => invoke(bridge, "session.subscription.open", params),
        close: (params) => invoke(bridge, "session.subscription.close", params),
        page: (params) => invoke(bridge, "session.transcript.page", params),
        advance: (params) => invoke(bridge, "session.transcript.advance", params),
        subscribeFrames: (listener, onDisconnect) =>
          bridge.sessionFrames.subscribe(listener, onDisconnect),
      };
      const continuity = new DesktopSessionContinuity({
        transport,
        onView: applyReplicaView,
        onPlanControl: (_workspacePath, sessionId, control) => {
          const approval = approvalFromPlanControlSnapshot(control, sessionId);
          setData((current) => ({
            ...current,
            approvals: [
              ...current.approvals.filter(
                (candidate) => candidate.kind !== "plan" || candidate.sessionId !== sessionId,
              ),
              ...(approval ? [approval] : []),
            ],
          }));
        },
        onError: (error) => setMessage(errorMessage(error)),
      });
      desktopContinuityBridgeRef.current = bridge;
      desktopContinuityRef.current = continuity;
      return continuity;
    },
    [applyReplicaView],
  );

  const reportFailure = useCallback((error: unknown) => {
    setMessage(errorMessage(error));
  }, []);

  const loadWorkspaceIndex = useCallback(
    async (bridge: DesktopBridge, reset = false): Promise<readonly WorkspaceView[]> => {
      const generation = workspaceIndexLoadGenerationRef.current + 1;
      workspaceIndexLoadGenerationRef.current = generation;
      const workspaceValue = await invoke(bridge, "workspace.list", {});
      const indexed = await Promise.all(
        parseWorkspaceList(workspaceValue).flatMap((workspace) => {
          const workspacePath = stringValue(workspace.workspacePath);
          if (!workspacePath || !booleanValue(workspace.registered, true)) return [];
          return [
            (async () => {
              const trust = await optionalInvoke(bridge, "workspace.trustStatus", {
                workspacePath,
              });
              const trusted = booleanValue(trust.value?.trusted);
              const [sessions, runs] = trusted
                ? await Promise.all([
                    optionalInvoke(bridge, "session.list", {
                      workspacePath,
                      includeArchived: true,
                    }),
                    optionalInvoke(bridge, "runs.list", { workspacePath }),
                  ])
                : [{ value: { sessions: [] } }, { value: { runs: [] } }];
              return {
                workspace: {
                  path: workspacePath,
                  name:
                    workspace.temporary === true
                      ? TEMPORARY_WORKSPACE_LABEL
                      : workspaceName(workspacePath),
                  mode: parseWorkspaceMode(workspace.mode, "folder") ?? "folder",
                  registered: true,
                  trusted,
                  ...(workspace.temporary === true ? { temporary: true as const } : {}),
                } satisfies WorkspaceView,
                sessions: parseSessions(sessions.value, workspacePath),
                runs: parseRuns(runs.value, workspacePath),
              };
            })(),
          ];
        }),
      );
      const workspaces = indexed.map((item) => item.workspace);
      const sessions = indexed.flatMap((item) => item.sessions).sort(compareSessions);
      const runs = indexed
        .flatMap((item) => item.runs)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (workspaceIndexLoadGenerationRef.current !== generation) return workspaces;
      setData((current) => {
        if (workspaceIndexLoadGenerationRef.current !== generation) return current;
        const base = reset ? emptyData : current;
        return {
          ...base,
          workspaces,
          sessions,
          runs,
          providerConfig: {
            ...base.providerConfig,
            supported: runtimeCapabilitiesRef.current.has(SHARED_CONFIG_CAPABILITY),
          },
        };
      });
      return workspaces;
    },
    [],
  );

  const loadUserCapabilities = useCallback(async (bridge: DesktopBridge) => {
    if (!runtimeCapabilitiesRef.current.has(CAPABILITY_SCOPE_RUNTIME_CAPABILITY)) {
      setData((current) => ({
        ...current,
        notices: {
          ...current.notices,
          skills: "当前 Runtime 未提供全局 Skills 作用域能力。",
          mcp: "当前 Runtime 未提供全局 MCP 作用域能力。",
        },
      }));
      return;
    }
    const [skillResult, mcpResult] = await Promise.all([
      optionalInvoke(bridge, "skills.user.list", {}),
      optionalInvoke(bridge, "mcp.user.list", {}),
    ]);
    setData((current) => {
      const skills = skillResult.value?.skills.map(scopedSkill);
      const mcpServers = mcpResult.value?.servers.map(scopedMcpServer);
      const skillRevision = skillResult.value?.revision;
      const mcpRevision = mcpResult.value?.revision;
      const notices = { ...current.notices };
      if (skillResult.error) notices.skills = skillResult.error;
      else delete notices.skills;
      if (mcpResult.error) notices.mcp = mcpResult.error;
      else delete notices.mcp;
      return {
        ...current,
        ...(skills && skillRevision
          ? {
              skills: current.skillScope.workspacePath ? current.skills : skills,
              skillScope: {
                ...current.skillScope,
                userItems: skills,
                userRevision: skillRevision,
              },
            }
          : {}),
        ...(mcpServers && mcpRevision
          ? {
              mcpServers: current.mcpScope.workspacePath ? current.mcpServers : mcpServers,
              mcpScope: {
                ...current.mcpScope,
                userItems: mcpServers,
                userRevision: mcpRevision,
              },
            }
          : {}),
        notices,
      };
    });
  }, []);

  const loadGlobalProviderConfig = useCallback(async (bridge: DesktopBridge) => {
    const generation = providerConfigLoadGenerationRef.current + 1;
    providerConfigLoadGenerationRef.current = generation;
    const sharedConfigSupported = runtimeCapabilitiesRef.current.has(SHARED_CONFIG_CAPABILITY);
    if (!sharedConfigSupported) {
      setData((current) => ({
        ...current,
        providerConfig: parseProviderConfig({}, false),
        notices: {
          ...current.notices,
          providers: "当前 Runtime 缺少统一配置能力。请完全退出并重新启动 Pico 后再管理 Provider。",
        },
      }));
      return;
    }

    const entries = await Promise.all([
      optionalEntry("providerRegistry", bridge, "provider.list", {}),
      optionalEntry("userConfig", bridge, "config.user.get", {}),
    ]);
    if (providerConfigLoadGenerationRef.current !== generation) return;
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [key, result] of entries) {
      if (result.error) errors.push(result.error);
      else values[key] = result.value;
    }
    setData((current) => {
      const notices = { ...current.notices };
      if (errors.length > 0) notices.providers = errors.join("；");
      else delete notices.providers;
      return {
        ...current,
        providerConfig: parseProviderConfig(values, true),
        notices,
      };
    });
  }, []);

  const loadDesktopPreferences = useCallback(async (bridge: DesktopBridge): Promise<void> => {
    const [launchResult, backgroundResult] = await Promise.all([
      bridge.platform.getLaunchAtLogin(),
      bridge.lifecycle.getBackgroundMode(),
    ]);
    setData((current) => {
      const notices = { ...current.notices };
      const errors = [
        !launchResult.ok ? launchResult.error.message : undefined,
        !backgroundResult.ok ? backgroundResult.error.message : undefined,
      ].filter((message): message is string => Boolean(message));
      if (errors.length > 0) notices.desktopPreferences = errors.join("；");
      else delete notices.desktopPreferences;
      return {
        ...current,
        ...(launchResult.ok ? { launchAtLogin: launchResult.value } : {}),
        ...(backgroundResult.ok ? { backgroundMode: backgroundResult.value } : {}),
        notices,
      };
    });
  }, []);

  const loadScopedCapabilities = useCallback(
    async (bridge: DesktopBridge, kind: "skills" | "mcp", workspacePath?: string) => {
      if (!workspacePath) {
        await loadUserCapabilities(bridge);
        setData((current) => ({
          ...current,
          ...(kind === "skills"
            ? {
                skills: current.skillScope.userItems,
                skillScope: { ...current.skillScope, workspacePath: undefined },
              }
            : {
                mcpServers: current.mcpScope.userItems,
                mcpScope: { ...current.mcpScope, workspacePath: undefined },
              }),
        }));
        return;
      }
      try {
        if (kind === "skills") {
          const result = await invoke(bridge, "skills.effective.list", { workspacePath });
          setData((current) => {
            const notices = { ...current.notices };
            delete notices.skills;
            return {
              ...current,
              skills: result.skills.map(scopedSkill),
              skillScope: { ...current.skillScope, workspacePath },
              notices,
            };
          });
        } else {
          const result = await invoke(bridge, "mcp.effective.list", { workspacePath });
          setData((current) => {
            const notices = { ...current.notices };
            delete notices.mcp;
            return {
              ...current,
              mcpServers: result.servers.map(scopedMcpServer),
              mcpScope: { ...current.mcpScope, workspacePath },
              notices,
            };
          });
        }
      } catch (error) {
        const detail =
          error instanceof RuntimeInvocationError && error.code === "FORBIDDEN"
            ? "该项目尚未信任，无法读取项目级能力；已继续显示用户级列表。"
            : `${errorMessage(error)}；已继续显示用户级列表。`;
        setData((current) => ({
          ...current,
          ...(kind === "skills"
            ? {
                skills: current.skillScope.userItems,
                skillScope: { ...current.skillScope, workspacePath: undefined },
              }
            : {
                mcpServers: current.mcpScope.userItems,
                mcpScope: { ...current.mcpScope, workspacePath: undefined },
              }),
          notices: {
            ...current.notices,
            [kind]: detail,
          },
        }));
        throw error;
      }
    },
    [loadUserCapabilities],
  );

  const loadMemory = useCallback(
    async (bridge: DesktopBridge, workspacePath: string) => {
      const generation = memoryLoadGenerationRef.current + 1;
      memoryLoadGenerationRef.current = generation;
      const isCurrentLoad = () =>
        memoryLoadGenerationRef.current === generation &&
        dataRef.current.workspacePath === workspacePath;
      if (!runtimeCapabilitiesRef.current.has(WORKSPACE_MEMORY_CAPABILITY)) {
        setData((current) => ({
          ...current,
          memory: {
            workspacePath,
            facts: [],
            status: "degraded",
            error: "当前 Runtime 未提供工作区记忆能力。请完整重启 Pico 后重试。",
          },
        }));
        return;
      }
      if (preview) {
        setData((current) => ({ ...current, memory: previewData.memory }));
        return;
      }
      setData((current) => ({
        ...current,
        memory: { ...current.memory, workspacePath, status: "loading", error: undefined },
      }));
      try {
        const [factsResult, settingsResult] = await Promise.all([
          invoke(bridge, "memory.list", {
            workspacePath,
            states: ["active", "disabled", "archived"],
            limit: 500,
          }),
          invoke(bridge, "memory.settings.get", { workspacePath }),
        ]);
        if (!isCurrentLoad()) return;
        setData((current) => ({
          ...current,
          memory: {
            workspacePath,
            facts: factsResult.facts,
            settings: settingsResult.settings,
            status: "ready",
          },
        }));
      } catch (error) {
        if (isCurrentLoad()) {
          setData((current) => ({
            ...current,
            memory: {
              ...current.memory,
              workspacePath,
              status: "error",
              error: errorMessage(error),
            },
          }));
        }
        throw error;
      }
    },
    [preview],
  );

  const loadWorkspace = useCallback(async (bridge: DesktopBridge, workspacePath: string) => {
    workspaceLoadIntentRef.current = workspacePath;
    workspaceIndexLoadGenerationRef.current += 1;
    const generation = workspaceLoadGenerationRef.current + 1;
    workspaceLoadGenerationRef.current = generation;
    const isCurrentLoad = () => workspaceLoadGenerationRef.current === generation;
    const params = { workspacePath };
    const sharedConfigSupported = runtimeCapabilitiesRef.current.has(SHARED_CONFIG_CAPABILITY);
    // Main may be awaiting native storage-repair confirmation. Do not open dependent stores yet.
    const workspaceEntry = await optionalEntry("workspace", bridge, "workspace.status", params);
    if (!isCurrentLoad()) return;
    if (workspaceEntry[1].error) throw new Error(workspaceEntry[1].error);
    const requests = [
      Promise.resolve(workspaceEntry),
      optionalEntry("sessions", bridge, "session.list", { ...params, includeArchived: true }),
      optionalEntry("runs", bridge, "runs.list", params),
      optionalEntry("jobs", bridge, "jobs.list", params),
      optionalEntry("legacyProviders", bridge, "config.providers", params),
      optionalEntry("agentCatalog", bridge, "catalog.agents", params),
      optionalEntry("skillCatalog", bridge, "catalog.skills", params),
      optionalEntry("usage", bridge, "usage.get", params),
      optionalEntry("config", bridge, "config.get", params),
      ...(sharedConfigSupported
        ? ([optionalEntry("effectiveConfig", bridge, "config.effective.get", params)] as const)
        : []),
    ];
    const entries = await Promise.all(requests);
    const values: Record<string, unknown> = {};
    const notices: Record<string, string> = {};
    for (const [key, result] of entries) {
      if (result.error) notices[key] = result.error;
      else values[key] = result.value;
    }
    const trustResult = await optionalInvoke(bridge, "workspace.trustStatus", params);
    if (!isCurrentLoad()) return;
    if (trustResult.error) notices.trust = trustResult.error;
    setData((current) => {
      if (current.notices.providers) notices.providers = current.notices.providers;
      else delete notices.providers;
      if (current.notices.desktopPreferences)
        notices.desktopPreferences = current.notices.desktopPreferences;
      const trusted = booleanValue(trustResult.value?.trusted);
      const switchingWorkspace = current.workspacePath !== workspacePath;
      const workspaceMode = parseWorkspaceMode(
        isRecord(values.workspace) ? values.workspace.mode : undefined,
        "folder",
      );
      const temporary = isRecord(values.workspace) && values.workspace.temporary === true;
      const selectedWorkspace: WorkspaceView = {
        path: workspacePath,
        name: temporary ? TEMPORARY_WORKSPACE_LABEL : workspaceName(workspacePath),
        mode: workspaceMode ?? "folder",
        registered: true,
        trusted,
        ...(temporary ? { temporary: true as const } : {}),
      };
      const workspaces = [
        selectedWorkspace,
        ...current.workspaces.filter((workspace) => workspace.path !== workspacePath),
      ];
      return mergeLoadedData(
        {
          ...current,
          workspaces,
          workspacePath,
          trusted,
          notices,
          memory:
            trusted && !switchingWorkspace
              ? current.memory
              : { workspacePath, facts: [], status: "idle" },
          ...(switchingWorkspace
            ? {
                timeline: [],
                approvals: [],
                prompts: [],
                changes: [],
                changeFingerprint: undefined,
                modelRoutes: [],
              }
            : {}),
        },
        workspacePath,
        values,
      );
    });
  }, []);

  const loadConversation = useCallback(
    async (bridge: DesktopBridge, workspacePath: string, sessionId: string) => {
      if (preview) return;
      const conversationKey = workspaceSessionKey({ workspacePath, sessionId });
      // D12 收编：过期响应护栏在 ConversationLoadTracker（分页/游标算法只在
      // daemon 服务层一处，本层仅丢弃迟到的旧加载）。
      const load = conversationLoadTracker.current.begin(conversationKey);
      const isCurrentLoad = () => conversationLoadTracker.current.isCurrent(load);
      let continuity: DesktopSessionContinuity;
      let value: unknown;
      try {
        continuity = ensureDesktopContinuity(bridge);
        const view = await continuity.open(workspacePath, sessionId);
        value = {
          items: [
            ...view.records.map((record) => record.item),
            ...view.activeOverlay.map(overlayRuntimeItem),
          ],
          queuedInputs: view.queuedInputs,
          ...(view.activeRun ? { activeRun: view.activeRun } : {}),
        };
      } catch (error) {
        if (!isCurrentLoad()) return;
        setData((current) => ({
          ...current,
          conversations: {
            ...current.conversations,
            [conversationKey]: {
              workspacePath,
              sessionId,
              items: [],
              queuedCount: 0,
              loadError: errorMessage(error),
            },
          },
        }));
        throw error;
      }
      if (!isCurrentLoad()) return;
      const record = isRecord(value) ? value : {};
      const hydratedPlanApproval = approvalFromPlanControlSnapshot(
        continuity.planControl(workspacePath, sessionId),
        sessionId,
      );
      const activeRun = isRecord(record.activeRun) ? record.activeRun : undefined;
      const activeRunId = stringValue(activeRun?.runId) || undefined;
      const changeRunId =
        activeRunId ||
        dataRef.current.runs.find(
          (run) =>
            run.workspacePath === workspacePath &&
            run.sessionId === sessionId &&
            isTerminalRunStatus(run.status),
        )?.id;
      const [sessionUsage, contextResult, settingsResult, goalResult] = await Promise.all([
        optionalInvoke(bridge, "usage.get", { workspacePath, sessionId }),
        optionalInvoke(bridge, "session.context.get", { workspacePath, sessionId }),
        optionalInvoke(bridge, "session.settings.get", { workspacePath, sessionId }),
        optionalInvoke(bridge, "goal.get", { workspacePath, sessionId }),
      ]);
      if (!isCurrentLoad()) return;
      const fragments = new Map<string, RuntimeTranscriptFragment[]>();
      transcriptFragmentsByConversation.current.set(conversationKey, fragments);
      const parsedConversation = parseConversation(record, workspacePath, sessionId, fragments);
      if (parsedConversation.nextCursor) {
        transcriptCursorByConversation.current.set(conversationKey, parsedConversation.nextCursor);
      } else {
        transcriptCursorByConversation.current.delete(conversationKey);
      }
      let conversation: ConversationView = {
        ...parsedConversation,
        ...(activeRunId ? { runId: activeRunId } : {}),
        ...(!sessionUsage.error ? { usage: parseUsage(sessionUsage.value) } : {}),
        ...(!contextResult.error ? { context: parseSessionContext(contextResult.value) } : {}),
        ...(!settingsResult.error ? { settings: parseSessionSettings(settingsResult.value) } : {}),
        ...(!goalResult.error ? { goalItem: parseGoalItem(goalResult.value) } : {}),
      };
      if (changeRunId) {
        const changeList = await optionalInvoke(bridge, "changes.list", {
          workspacePath,
          runId: changeRunId,
        });
        if (!isCurrentLoad()) return;
        if (!changeList.error && changeList.value) {
          const parsed = parseChanges(changeList.value);
          conversation = {
            ...conversation,
            changes: parsed.changes,
            changeFingerprint: parsed.fingerprint,
          };
        }
      }
      if (!isCurrentLoad()) return;
      const latestReplicaView = continuity?.view(workspacePath, sessionId);
      setData((current) => ({
        ...current,
        approvals: [
          ...current.approvals.filter(
            (approval) => approval.kind !== "plan" || approval.sessionId !== sessionId,
          ),
          ...(hydratedPlanApproval ? [hydratedPlanApproval] : []),
        ],
        conversations: {
          ...current.conversations,
          [conversationKey]: {
            ...conversation,
            ...(latestReplicaView
              ? {
                  items: conversationItemsFromReplica(latestReplicaView),
                  queuedCount: latestReplicaView.queuedInputs.length,
                }
              : {
                  items: mergeHydratedConversationItems(
                    conversation.items,
                    current.conversations[conversationKey]?.items ?? [],
                    activeRunId,
                  ),
                }),
          },
        },
        runs: activeRun
          ? [
              {
                id: stringValue(activeRun.runId),
                workspacePath,
                sessionId: stringValue(activeRun.sessionId, sessionId),
                description: stringValue(activeRun.description, "会话运行"),
                status: stringValue(activeRun.status, "running"),
                startedAt: numberValue(activeRun.startedAt, Date.now()),
                updatedAt: numberValue(activeRun.updatedAt, Date.now()),
              },
              ...current.runs.filter(
                (run) =>
                  run.workspacePath !== workspacePath || run.id !== stringValue(activeRun.runId),
              ),
            ]
          : current.runs.filter(
              (run) =>
                run.workspacePath !== workspacePath ||
                run.sessionId !== sessionId ||
                isTerminalRunStatus(run.status),
            ),
      }));
    },
    [ensureDesktopContinuity, preview],
  );

  const bootstrap = useCallback(async () => {
    if (preview) return;
    setConnection({ kind: "loading" });
    setMessage(undefined);
    const bridge = getBridge();
    if (!bridge) {
      setConnection({
        kind: "error",
        detail: "安全桥接未加载。请从 Pico 桌面应用启动，而不是直接打开页面。",
        retryable: false,
      });
      return;
    }
    try {
      const pingValue = await invoke(bridge, "runtime.ping", {});
      const capabilities = pingValue.capabilities.map((capability) => stringValue(capability));
      runtimeCapabilitiesRef.current = new Set(capabilities);
      if (!capabilities.includes("session-conversation-v1")) {
        throw new Error("当前 Runtime 缺少会话能力。请完全退出并重新启动 Pico。");
      }
      await loadWorkspaceIndex(bridge, true);
      await Promise.all([
        loadUserCapabilities(bridge),
        loadGlobalProviderConfig(bridge),
        loadDesktopPreferences(bridge),
      ]);
      setConnection({ kind: "ready" });
    } catch (error) {
      setConnection({ kind: "error", detail: errorMessage(error), retryable: true });
    }
  }, [
    loadDesktopPreferences,
    loadGlobalProviderConfig,
    loadUserCapabilities,
    loadWorkspaceIndex,
    preview,
  ]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 主进程监督器判定 Runtime 不可达（连续探活失败）时降级到恢复屏；降级后重新
  // 探活成功则广播 recovered，自动 re-bootstrap 回到就绪（3-C：消除 fail-stuck，
  // 渲染层只消费推送相位，不自建重试循环）。
  useEffect(() => {
    if (preview) return;
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.onUnavailable(() => {
      setConnection((current) =>
        current.kind === "error"
          ? current
          : {
              kind: "error",
              detail: "本地 Runtime 已断开，正在自动恢复连接…",
              retryable: true,
            },
      );
    });
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.onRecovered(() => {
      // 恢复路径与手动"立即重试"同源：重新引导（能力/工作区索引/配置）后重载
      // 当前工作区数据；会话 transcript 由路由树重挂载时的 loadSession 效应
      // 重取（error 相位下路由整体卸载，回 ready 后自然重挂）。失败则留在
      // 恢复屏等待下一轮 recovered。
      void bootstrap()
        .then(async () => {
          const workspacePath = dataRef.current.workspacePath;
          const recoveredBridge = getBridge();
          if (!workspacePath || !recoveredBridge) return;
          await loadWorkspace(recoveredBridge, workspacePath);
        })
        .catch(() => undefined);
    });
  }, [bootstrap, loadWorkspace, preview]);

  useEffect(() => {
    if (preview || connection.kind !== "ready") return;
    const bridge = getBridge();
    if (!bridge) return;
    const refreshOnFocus = () => {
      const workspacePath = dataRef.current.workspacePath;
      void loadWorkspaceIndex(bridge)
        .then(() =>
          Promise.all([
            loadUserCapabilities(bridge),
            loadGlobalProviderConfig(bridge),
            loadDesktopPreferences(bridge),
          ]),
        )
        .then(() =>
          workspacePath &&
          dataRef.current.workspacePath === workspacePath &&
          workspaceLoadIntentRef.current === workspacePath
            ? loadWorkspace(bridge, workspacePath)
            : undefined,
        )
        .catch(reportFailure);
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [
    connection.kind,
    loadDesktopPreferences,
    loadGlobalProviderConfig,
    loadUserCapabilities,
    loadWorkspace,
    loadWorkspaceIndex,
    preview,
    reportFailure,
  ]);

  useEffect(() => {
    if (preview || connection.kind !== "ready" || !data.workspacePath) return;
    const bridge = getBridge();
    if (!bridge) return;
    seenEventIdsRef.current.clear();
    const workspacePath = data.workspacePath;
    let disposed = false;
    let subscription: ReturnType<DesktopBridge["events"]["subscribe"]> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let memoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const dirtySessions = new Set<string>();
    const scheduleHydration = (sessionId?: string) => {
      if (sessionId) dirtySessions.add(sessionId);
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (disposed) return;
        const currentWorkspace = dataRef.current.workspacePath;
        if (!currentWorkspace) return;
        const sessions = [...dirtySessions];
        dirtySessions.clear();
        void loadWorkspace(bridge, currentWorkspace)
          .then(() =>
            Promise.all(
              sessions.map((candidate) => loadConversation(bridge, currentWorkspace, candidate)),
            ),
          )
          .catch(reportFailure);
      }, 25);
    };
    const scheduleMemoryRefresh = () => {
      if (memoryRefreshTimer) return;
      memoryRefreshTimer = setTimeout(() => {
        memoryRefreshTimer = undefined;
        if (disposed || dataRef.current.workspacePath !== workspacePath) return;
        void loadMemory(bridge, workspacePath).catch(reportFailure);
      }, 25);
    };
    const handleEvent = (event: RuntimeNotification) => {
      const scope = event.scope;
      const scopedWorkspacePath = stringValue(scope.workspacePath);
      if (scopedWorkspacePath && scopedWorkspacePath !== dataRef.current.workspacePath) return;
      const eventId = stringValue(event.eventId);
      if (eventId && seenEventIdsRef.current.has(eventId)) return;
      if (eventId) {
        seenEventIdsRef.current.add(eventId);
        if (seenEventIdsRef.current.size > MAX_RENDERER_SEEN_EVENT_IDS) {
          const oldest = seenEventIdsRef.current.values().next().value;
          if (oldest !== undefined) seenEventIdsRef.current.delete(oldest);
        }
      }
      const payload = isRecord(event.payload) ? event.payload : {};
      const topic = stringValue(event.topic);
      if (isMemoryNotificationTopic(topic)) {
        scheduleMemoryRefresh();
      } else if (topic === "approval.requested") {
        // wire 语义读取经 @pico/protocol parseApprovalRequestedPayload（与 TUI
        // 客户端同源；planId 不回退 approvalId 的兜底语义由此回流）。
        const approval = parseApprovalRequestedPayload(payload);
        // Plan cards are recovery-capable controls, so only the durable PlanControl
        // snapshot/projection may create them. Generic approval replay remains display
        // authority for non-Plan approvals only.
        if (approval && approval.kind !== "plan") {
          setData((current) => ({
            ...current,
            approvals: [
              ...current.approvals.filter((item) => item.id !== approval.approvalId),
              {
                id: approval.approvalId,
                runId: approval.runId ?? stringValue(scope.runId),
                sessionId: stringValue(scope.sessionId) || undefined,
                title: approval.title ?? "需要你的批准",
                detail: approval.detail ?? "Runtime 请求执行受保护操作。",
                command: approval.command,
                risk: approval.risk,
                kind: approval.kind,
              },
            ],
          }));
        }
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
              runId: stringValue(payload.runId ?? scope.runId),
              question: stringValue(prompt.question ?? prompt.message, "Pico 需要你的选择"),
              options,
            },
          ],
        }));
      } else if (topic === "approval.resolved") {
        const approvalId = stringValue(payload.approvalId);
        setData((current) =>
          resolveApprovalState(current, {
            approvalId,
            decision: stringValue(payload.decision),
            workspacePath,
            sessionId: stringValue(scope.sessionId),
            runId: stringValue(scope.runId ?? payload.runId),
          }),
        );
      } else if (topic === "prompt.resolved") {
        const promptId = stringValue(payload.promptId);
        setData((current) =>
          resolvePromptState(current, {
            promptId,
            workspacePath,
            sessionId: stringValue(scope.sessionId),
            runId: stringValue(scope.runId ?? payload.runId),
          }),
        );
      } else if (topic === "run.started") {
        const run = isRecord(payload.run) ? payload.run : {};
        const runId = stringValue(scope.runId ?? run.runId);
        const sessionId = stringValue(scope.sessionId ?? run.sessionId);
        const conversationKey = sessionId
          ? workspaceSessionKey({ workspacePath, sessionId })
          : undefined;
        if (runId) {
          setData((current) => ({
            ...current,
            runs: [
              {
                id: runId,
                workspacePath,
                sessionId: sessionId || undefined,
                description: stringValue(run.description, "会话运行"),
                status: stringValue(run.status, "running"),
                startedAt: numberValue(run.startedAt, event.at),
                updatedAt: numberValue(run.updatedAt, event.at),
              },
              ...current.runs.filter(
                (candidate) => candidate.workspacePath !== workspacePath || candidate.id !== runId,
              ),
            ],
            ...(sessionId && conversationKey
              ? {
                  conversations: {
                    ...current.conversations,
                    [conversationKey]: {
                      ...(current.conversations[conversationKey] ?? {
                        workspacePath,
                        sessionId,
                        items: [],
                        queuedCount: 0,
                      }),
                      runId,
                      items: (current.conversations[conversationKey]?.items ?? []).filter(
                        (candidate) =>
                          (candidate.kind !== "thinking" &&
                            candidate.kind !== "assistantMessage") ||
                          candidate.streaming !== true,
                      ),
                    },
                  },
                }
              : {}),
          }));
        }
        scheduleHydration(sessionId || undefined);
      } else if (topic === "run.timeline") {
        setData((current) => ({
          ...current,
          timeline: applyTimelineNotification(current.timeline, event),
        }));
      } else if (topic === "config.updated") {
        const changedCapabilities = Array.isArray(payload.capabilities)
          ? payload.capabilities.map((item) => stringValue(item))
          : [];
        if (changedCapabilities.includes("skills") || changedCapabilities.includes("mcp")) {
          void loadUserCapabilities(bridge)
            .then(async () => {
              const current = dataRef.current;
              await Promise.all([
                changedCapabilities.includes("skills") && current.skillScope.workspacePath
                  ? loadScopedCapabilities(bridge, "skills", current.skillScope.workspacePath)
                  : undefined,
                changedCapabilities.includes("mcp") && current.mcpScope.workspacePath
                  ? loadScopedCapabilities(bridge, "mcp", current.mcpScope.workspacePath)
                  : undefined,
              ]);
            })
            .catch(reportFailure);
        }
        if (Array.isArray(payload.providerIds)) {
          void loadGlobalProviderConfig(bridge).catch(reportFailure);
        }
        scheduleHydration();
      } else if (shouldBatchHydrateRuntimeNotification(topic)) {
        scheduleHydration(stringValue(scope.sessionId) || undefined);
      }
    };
    void (async () => {
      // Capture the durable boundary first, hydrate current state once, then only
      // subscribe after that high-watermark. Historical events never enter the
      // Main/preload pending buffers or trigger one refresh per old event.
      const boundary = await bridge.runtime["events.replay"]({ workspacePath, limit: 1 });
      if (!boundary.ok) throw new Error(boundary.error.message);
      if (
        disposed ||
        dataRef.current.workspacePath !== workspacePath ||
        workspaceLoadIntentRef.current !== workspacePath
      ) {
        return;
      }
      await loadWorkspace(bridge, workspacePath);
      if (disposed) return;
      const highWatermarkEventId = boundary.value.highWatermarkEventId;
      subscription = bridge.events.subscribe(
        {
          workspacePath,
          ...(highWatermarkEventId ? { afterEventId: highWatermarkEventId } : {}),
        },
        handleEvent,
      );
      const result = await subscription.ready;
      if (!result.ok && !disposed) setMessage(`事件订阅失败：${result.error.message}`);
    })().catch((error: unknown) => {
      if (!disposed) reportFailure(error);
    });
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (memoryRefreshTimer) clearTimeout(memoryRefreshTimer);
      subscription?.dispose();
      desktopContinuityRef.current?.dispose();
      desktopContinuityRef.current = undefined;
      desktopContinuityBridgeRef.current = undefined;
    };
  }, [
    connection.kind,
    data.workspacePath,
    loadConversation,
    loadGlobalProviderConfig,
    loadMemory,
    loadScopedCapabilities,
    loadUserCapabilities,
    loadWorkspace,
    preview,
    reportFailure,
  ]);

  const perform = useCallback(
    async (
      label: string,
      operation: (bridge: DesktopBridge) => Promise<void>,
    ): Promise<boolean> => {
      setBusy(label);
      // 不在此处清空上一条 message：错误反馈若被新动作开始即抹去，用户来不及看清。
      // 新动作完成（成功或失败）会自行设置 message 覆盖；进行中的 busy 态另有指示。
      try {
        if (preview) {
          await operation(createPreviewBridge());
          return true;
        }
        const bridge = getBridge();
        if (!bridge) throw new Error("桌面安全桥接不可用。");
        await operation(bridge);
        return true;
      } catch (error) {
        if (!preview && label.startsWith("memory-") && isMemoryConflict(error)) {
          const bridge = getBridge();
          const workspacePath = dataRef.current.workspacePath;
          if (bridge && workspacePath) {
            try {
              await loadMemory(bridge, workspacePath);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage("记忆已在另一处更新，已重新加载最新内容。请检查后重试本次操作。");
          return false;
        }
        if (
          !preview &&
          label.startsWith("mcp-user-") &&
          error instanceof RuntimeInvocationError &&
          (error.code === "CONFIG_REVISION_CONFLICT" || error.code === "CONFLICT")
        ) {
          const bridge = getBridge();
          if (bridge) {
            try {
              await loadUserCapabilities(bridge);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage("MCP 配置已在另一处更新，已刷新用户级列表。请检查后重试。");
          return false;
        }
        if (
          !preview &&
          label.startsWith("provider-") &&
          error instanceof RuntimeInvocationError &&
          (error.code === "CONFIG_REVISION_CONFLICT" || error.code === "CONFLICT")
        ) {
          const bridge = getBridge();
          if (bridge) {
            try {
              await loadGlobalProviderConfig(bridge);
              const workspacePath = dataRef.current.workspacePath;
              if (workspacePath) await loadWorkspace(bridge, workspacePath);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage(
            "Provider 配置已被 App 或 TUI 的另一处更新，已重新加载最新内容。请检查后重新应用本次修改。",
          );
          return false;
        }
        reportFailure(error);
        return false;
      } finally {
        setBusy(undefined);
      }
    },
    [
      loadGlobalProviderConfig,
      loadMemory,
      loadUserCapabilities,
      loadWorkspace,
      preview,
      reportFailure,
    ],
  );

  const actions = useMemo<RuntimeActions>(
    () => ({
      dismissMessage() {
        setMessage(undefined);
      },
      showMessage(text) {
        setMessage(text);
      },
      async chooseWorkspace() {
        let selectedWorkspacePath: string | undefined;
        await perform("choose-workspace", async (bridge) => {
          const result = await bridge.platform.chooseWorkspace();
          if (!result.ok) throw new Error(result.error.message);
          if (!result.value) return;
          if (preview) {
            selectedWorkspacePath = result.value;
            setData(previewData);
            return;
          }
          const registeredValue = await invoke(bridge, "workspace.register", {
            workspacePath: result.value,
          });
          const workspacePath = stringValue(registeredValue.workspacePath, result.value);
          selectedWorkspacePath = workspacePath;
          await loadWorkspaceIndex(bridge);
          await loadWorkspace(bridge, workspacePath);
        });
        return selectedWorkspacePath;
      },
      async registerWorkspace() {
        let registeredWorkspacePath: string | undefined;
        await perform("register-workspace", async (bridge) => {
          const result = await bridge.platform.chooseWorkspace();
          if (!result.ok) throw new Error(result.error.message);
          if (!result.value) return;
          if (preview) {
            registeredWorkspacePath = result.value;
            return;
          }
          const registeredValue = await invoke(bridge, "workspace.register", {
            workspacePath: result.value,
          });
          registeredWorkspacePath = stringValue(registeredValue.workspacePath, result.value);
          await loadWorkspaceIndex(bridge);
          setMessage("项目已添加；当前会话和新任务选择保持不变。");
        });
        return registeredWorkspacePath;
      },
      async ensureTemporaryWorkspace() {
        return temporaryWorkspaceRequest.current.run(async () => {
          let temporaryWorkspacePath: string | undefined;
          await perform("ensure-temporary-workspace", async (bridge) => {
            if (preview) {
              temporaryWorkspacePath = previewData.workspacePath;
              setData(previewData);
              return;
            }
            const status = await invoke(bridge, "workspace.temporary.ensure", {});
            temporaryWorkspacePath = status.workspacePath;
            await loadWorkspace(bridge, status.workspacePath);
          });
          return temporaryWorkspacePath;
        });
      },
      async selectWorkspace(workspacePath) {
        if (!workspacePath) return;
        if (preview) {
          setData(previewData);
          return;
        }
        await perform("select-workspace", async (bridge) => {
          await loadWorkspace(bridge, workspacePath);
        });
      },
      async trustWorkspace(workspacePath, trusted) {
        if (!workspacePath) return;
        await perform("trust-workspace", async (bridge) => {
          if (!preview) await invoke(bridge, "workspace.trust", { workspacePath, trusted });
          if (!preview) {
            await loadWorkspaceIndex(bridge);
            if (dataRef.current.workspacePath === workspacePath) {
              setData((current) => ({ ...current, trusted }));
            }
            return;
          }
          setData((current) => ({
            ...current,
            trusted,
            workspaces: current.workspaces.map((workspace) =>
              workspace.path === workspacePath ? { ...workspace, trusted } : workspace,
            ),
          }));
        });
      },
      async unregisterWorkspace(workspacePath) {
        if (!workspacePath) return;
        await perform("unregister-workspace", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "workspace.unregister", { workspacePath });
            await loadWorkspaceIndex(bridge);
          } else {
            setData((current) => ({
              ...current,
              workspaces: current.workspaces.filter(
                (workspace) => workspace.path !== workspacePath,
              ),
            }));
          }
          setMessage("项目已从 Pico 列表移除，磁盘文件未被删除。");
        });
      },
      reload: bootstrap,
      async loadSession(ref) {
        if (!ref.workspacePath || !ref.sessionId) return;
        await perform("load-session", async (bridge) => {
          if (preview) return;
          if (dataRef.current.workspacePath !== ref.workspacePath) {
            await loadWorkspace(bridge, ref.workspacePath);
          }
          await loadConversation(bridge, ref.workspacePath, ref.sessionId);
        });
      },
      async loadEarlierSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath || !sessionId) return;
        await perform("load-earlier-session", async (bridge) => {
          if (preview) return;
          await loadConversation(bridge, workspacePath, sessionId);
        });
      },
      async readToolEvidence(input) {
        if (preview) return undefined;
        let page: ToolEvidencePage | undefined;
        await perform("read-tool-evidence", async (bridge) => {
          const value = await invoke(bridge, "session.evidence.read", {
            workspacePath: input.workspacePath,
            sessionId: input.sessionId,
            evidenceUri: input.evidenceUri,
            ...(input.offsetBytes !== undefined ? { offsetBytes: input.offsetBytes } : {}),
            ...(input.limitBytes !== undefined ? { limitBytes: input.limitBytes } : {}),
          });
          page = toolEvidencePage(value, input.evidenceUri);
        });
        return page;
      },
      async sendMessage(input) {
        const workspacePath = input.workspacePath;
        if (!workspacePath || !input.text.trim()) return { succeeded: false };
        const swarmCommand = !input.activation ? parseSwarmCommand(input.text) : undefined;
        let resolvedSessionId = input.sessionId;
        const sendIdentity = JSON.stringify({
          workspacePath,
          sessionId: input.sessionId,
          text: input.text.trim(),
          initialSettings: input.initialSettings,
          behavior: input.behavior ?? "auto",
          expectedRunId: input.expectedRunId,
          activation: input.activation,
        });
        const idempotencyKey =
          pendingSendRef.current?.identity === sendIdentity
            ? pendingSendRef.current.idempotencyKey
            : crypto.randomUUID();
        pendingSendRef.current = { identity: sendIdentity, idempotencyKey };
        const succeeded = await perform("send-message", async (bridge) => {
          if (preview) {
            resolvedSessionId ??= "session-atlas";
            const sessionId = resolvedSessionId;
            if (!sessionId) return;
            const conversationKey = workspaceSessionKey({ workspacePath, sessionId });
            setData((current) => {
              const conversation = current.conversations[conversationKey] ?? {
                workspacePath,
                sessionId,
                items: [],
                queuedCount: 0,
              };
              return {
                ...current,
                conversations: {
                  ...current.conversations,
                  [conversationKey]: {
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
            input:
              input.activation?.kind === "skill"
                ? { kind: "skill", name: input.activation.name, args: input.text.trim() }
                : input.activation?.kind === "agent"
                  ? { kind: "agent", name: input.activation.name, task: input.text.trim() }
                  : swarmCommand?.kind === "run_once"
                    ? {
                        kind: "text",
                        text: swarmCommand.task,
                        orchestrationMode: "swarm",
                      }
                    : { kind: "text", text: input.text.trim() },
            ...(input.initialSettings ? { initialSettings: input.initialSettings } : {}),
            behavior: input.behavior ?? "auto",
            ...(input.expectedRunId ? { expectedRunId: input.expectedRunId } : {}),
            idempotencyKey,
          });
          const session = value.session;
          resolvedSessionId = stringValue(session.sessionId, input.sessionId);
          await loadWorkspace(bridge, workspacePath);
          if (resolvedSessionId) {
            await loadConversation(bridge, workspacePath, resolvedSessionId);
          }
        });
        if (succeeded && pendingSendRef.current?.identity === sendIdentity) {
          pendingSendRef.current = undefined;
        }
        return {
          succeeded,
          ...(succeeded ? { workspacePath } : {}),
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        };
      },
      async renameSession(ref, title) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath || !title.trim()) return;
        await perform("rename-session", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.rename", {
              workspacePath,
              sessionId,
              title: title.trim(),
            });
            await loadWorkspace(bridge, workspacePath);
            return;
          }
          setData((current) => ({
            ...current,
            sessions: current.sessions.map((session) =>
              session.workspacePath === workspacePath && session.id === sessionId
                ? { ...session, title: title.trim() }
                : session,
            ),
          }));
        });
      },
      async forkSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return undefined;
        let forkedSessionId: string | undefined;
        await perform("fork-session", async (bridge) => {
          if (preview) {
            forkedSessionId = `${sessionId}-fork`;
            return;
          }
          const value = await invoke(bridge, "session.fork", { workspacePath, sessionId });
          const session = value.session;
          forkedSessionId = stringValue(session.sessionId);
          await loadWorkspace(bridge, workspacePath);
          if (forkedSessionId) await loadConversation(bridge, workspacePath, forkedSessionId);
        });
        return forkedSessionId ? { workspacePath, sessionId: forkedSessionId } : undefined;
      },
      async compactSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("compact-session", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.compact", { workspacePath, sessionId });
            await loadConversation(bridge, workspacePath, sessionId);
          }
          setMessage("会话上下文已压缩，可见历史已从 Runtime 重新加载。");
        });
      },
      async updateSessionSettings(ref, patch) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("session-settings", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.settings.update", {
              workspacePath,
              sessionId,
              ...patch,
            });
            await loadConversation(bridge, workspacePath, sessionId);
          }
        });
      },
      async setSessionArchived(ref, archived) {
        const { workspacePath, sessionId } = ref;
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
              session.workspacePath === workspacePath && session.id === sessionId
                ? { ...session, status: archived ? "archived" : "active" }
                : session,
            ),
          }));
        });
      },
      async setSessionPinned(ref, pinned) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("session-state", async (bridge) => {
          if (!preview)
            await invoke(bridge, pinned ? "session.pin" : "session.unpin", {
              workspacePath,
              sessionId,
            });
          setData((current) => ({
            ...current,
            sessions: current.sessions
              .map((session) =>
                session.workspacePath === workspacePath && session.id === sessionId
                  ? { ...session, pinned }
                  : session,
              )
              .sort(compareSessions),
          }));
        });
      },
      async deleteSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return false;
        const key = workspaceSessionKey(ref);
        return await perform("session-state", async (bridge) => {
          if (!preview) await invoke(bridge, "session.delete", { workspacePath, sessionId });
          setData((current) => {
            const conversations = { ...current.conversations };
            delete conversations[key];
            return {
              ...current,
              sessions: current.sessions.filter(
                (session) => session.workspacePath !== workspacePath || session.id !== sessionId,
              ),
              runs: current.runs.filter(
                (run) => run.workspacePath !== workspacePath || run.sessionId !== sessionId,
              ),
              conversations,
            };
          });
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
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "pause_requested" }
                : run,
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
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "running" }
                : run,
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
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "cancelling" }
                : run,
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
          setData((current) =>
            resolveApprovalState(current, {
              approvalId: id,
              decision,
              workspacePath,
              sessionId: "",
              runId: current.approvals.find((approval) => approval.id === id)?.runId ?? "",
            }),
          );
        });
      },
      async respondPlan(input) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        if (input.action === "continue_editing" && !input.feedback?.trim()) {
          throw new Error("继续修改计划时必须填写反馈。");
        }
        await perform("plan-response", async (bridge) => {
          if (!preview) {
            try {
              await invoke(bridge, "plan.respond", {
                workspacePath,
                sessionId: input.sessionId,
                planId: input.planId,
                action: input.action,
                expectedRevision: input.expectedRevision,
                expectedSessionSequence: input.expectedSessionSequence,
                controlEpoch: input.controlEpoch,
                ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
              });
            } catch (error) {
              await loadConversation(bridge, workspacePath, input.sessionId);
              throw error;
            }
            await loadConversation(bridge, workspacePath, input.sessionId);
          }
          setData((current) => ({
            ...current,
            approvals: current.approvals.filter(
              (approval) =>
                approval.planId !== input.planId ||
                approval.expectedRevision !== input.expectedRevision,
            ),
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
          setData((current) =>
            resolvePromptState(current, {
              promptId: id,
              workspacePath,
              sessionId: "",
              runId: current.prompts.find((prompt) => prompt.id === id)?.runId ?? "",
            }),
          );
        });
      },
      async loadChangeDiff(input) {
        const { workspacePath, sessionId, runId, path } = input;
        if (!workspacePath || !runId || !path) return;
        await perform("change-diff", async (bridge) => {
          if (preview) return;
          const value = await invoke(bridge, "changes.diff", { workspacePath, runId, path });
          const patch = stringValue(value.patch) || "Runtime 未返回此文件的 diff 内容。";
          setData((current) => {
            if (!sessionId) {
              return {
                ...current,
                changes: current.changes.map((change) =>
                  change.path === path ? { ...change, patch } : change,
                ),
              };
            }
            const key = workspaceSessionKey({ workspacePath, sessionId });
            const conversation = current.conversations[key];
            if (!conversation) return current;
            return {
              ...current,
              conversations: {
                ...current.conversations,
                [key]: {
                  ...conversation,
                  changes: (conversation.changes ?? []).map((change) =>
                    change.path === path ? { ...change, patch } : change,
                  ),
                },
              },
            };
          });
        });
      },
      async reviewChanges(decision, reviewMessage, target) {
        const workspacePath = dataRef.current.workspacePath;
        const runId =
          target?.runId ??
          dataRef.current.runs.find((run) => run.workspacePath === workspacePath)?.id;
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
        const runId =
          target?.runId ??
          dataRef.current.runs.find((run) => run.workspacePath === workspacePath)?.id;
        const expectedFingerprint = target?.fingerprint ?? dataRef.current.changeFingerprint;
        if (!workspacePath || !runId || !expectedFingerprint) return;
        await perform("apply", async (bridge) => {
          if (!preview)
            await invoke(bridge, "changes.apply", { workspacePath, runId, expectedFingerprint });
          setMessage("更改已应用到工作区。");
        });
      },
      async previewRewind(ref) {
        const { workspacePath, sessionId } = ref;
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
          previewResult = {
            checkpointId,
            fingerprint: stringValue(value.fingerprint),
            changeCount: recordArray(value.changes).length,
          };
        });
        return previewResult;
      },
      async applyRewind(ref, checkpointId, fingerprint) {
        const { workspacePath, sessionId } = ref;
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
          if (!preview) {
            await loadWorkspace(bridge, workspacePath);
            await loadConversation(bridge, workspacePath, sessionId);
          }
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
      async loadCapabilityScope(kind, workspacePath) {
        await perform(`capability-${kind}`, async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              ...(kind === "skills"
                ? {
                    skills: current.skillScope.userItems,
                    skillScope: { ...current.skillScope, workspacePath },
                  }
                : {
                    mcpServers: current.mcpScope.userItems,
                    mcpScope: { ...current.mcpScope, workspacePath },
                  }),
            }));
            return;
          }
          await loadScopedCapabilities(bridge, kind, workspacePath);
        });
      },
      async addUserMcp(server) {
        const revision = dataRef.current.mcpScope.userRevision;
        if (!revision) {
          setMessage("MCP 用户级配置尚未加载，请刷新后再试。");
          return false;
        }
        if (dataRef.current.mcpScope.userItems.some((item) => item.name === server.name)) {
          setMessage(
            `MCP 服务 ${server.name} 已存在。Desktop v1 不会覆盖现有配置，以避免丢失密钥。`,
          );
          return false;
        }
        return perform("mcp-user-add", async (bridge) => {
          if (preview) {
            const item: CapabilityView = {
              id: `user:mcp:${server.name}`,
              name: server.name,
              description: `${server.transport.toUpperCase()} · ${server.transport === "stdio" ? server.command : server.url}`,
              state: server.enabled === false ? "disabled" : "ready",
              meta: server.transport,
              source: {
                scope: "user",
                sourceId: "user:mcp",
                sourceLabel: "~/.pico/config.json",
                readOnly: false,
                effective: true,
              },
            };
            setData((current) => {
              const userItems = [
                ...current.mcpScope.userItems.filter((candidate) => candidate.name !== server.name),
                item,
              ];
              return {
                ...current,
                mcpServers: [
                  ...current.mcpServers.filter(
                    (candidate) =>
                      candidate.name !== server.name || candidate.source?.scope !== "user",
                  ),
                  item,
                ],
                mcpScope: {
                  ...current.mcpScope,
                  userItems,
                  userRevision: `${current.mcpScope.userRevision}-next`,
                },
              };
            });
          } else {
            await invoke(bridge, "mcp.user.upsert", {
              server,
              expectedRevision: revision,
              idempotencyKey: globalThis.crypto.randomUUID(),
            });
            await loadUserCapabilities(bridge);
            const workspacePath = dataRef.current.mcpScope.workspacePath;
            if (workspacePath) await loadScopedCapabilities(bridge, "mcp", workspacePath);
          }
          setMessage(`MCP 服务 ${server.name} 已添加。`);
        });
      },
      async deleteUserMcp(serverName) {
        const revision = dataRef.current.mcpScope.userRevision;
        if (!revision) {
          setMessage("MCP 用户级配置尚未加载，请刷新后再试。");
          return false;
        }
        return perform("mcp-user-delete", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              mcpServers: current.mcpServers.filter(
                (candidate) => candidate.name !== serverName || candidate.source?.scope !== "user",
              ),
              mcpScope: {
                ...current.mcpScope,
                userItems: current.mcpScope.userItems.filter(
                  (candidate) => candidate.name !== serverName,
                ),
                userRevision: `${current.mcpScope.userRevision}-next`,
              },
            }));
          } else {
            await invoke(bridge, "mcp.user.delete", {
              serverName,
              expectedRevision: revision,
              idempotencyKey: globalThis.crypto.randomUUID(),
            });
            await loadUserCapabilities(bridge);
            const workspacePath = dataRef.current.mcpScope.workspacePath;
            if (workspacePath) await loadScopedCapabilities(bridge, "mcp", workspacePath);
          }
          setMessage(`MCP 服务 ${serverName} 已删除。`);
        });
      },
      async upsertProvider(provider, newConnectionSecret, createOnly = false) {
        const providerConfig = dataRef.current.providerConfig;
        if (
          (createOnly || newConnectionSecret !== undefined) &&
          ((provider.auth !== "none" && !newConnectionSecret?.trim()) ||
            providerConfig.providers.some((item) => item.id === provider.id))
        ) {
          setMessage("API Key 不能为空，且新连接 ID 不能与已有连接重复。");
          return false;
        }
        if (!providerConfig.writable) {
          setMessage(
            providerConfig.supported
              ? "Provider 配置尚未完整加载，请重新加载后再试。"
              : "当前 Runtime 不支持统一 Provider 配置。请完全退出并重新启动 Pico。",
          );
          return false;
        }
        return perform("provider-save", async (bridge) => {
          if (preview) {
            const previous = dataRef.current.providerConfig.providers.find(
              (item) => item.id === provider.id,
            );
            const next: ProviderView = {
              ...provider,
              origin: "user",
              fingerprint: previous?.fingerprint ?? `preview-${provider.id}-fingerprint`,
              credentialStatus:
                newConnectionSecret || provider.auth === "none"
                  ? "ready"
                  : (previous?.credentialStatus ?? "missing"),
              credentialSource: newConnectionSecret
                ? "config"
                : (previous?.credentialSource ?? "none"),
              storedCredentialPresent:
                Boolean(newConnectionSecret) || (previous?.storedCredentialPresent ?? false),
            };
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: [
                  ...current.providerConfig.providers.filter((item) => item.id !== provider.id),
                  next,
                ],
              },
            }));
            setMessage(`Provider ${provider.id} 已保存。`);
            return;
          }
          if (provider.modelCapabilities && !isJsonValue(provider.modelCapabilities)) {
            throw new Error("Provider modelCapabilities 必须是 JSON 对象。");
          }
          const runtimeProvider: RuntimeProviderInput = {
            id: provider.id,
            protocol: provider.protocol,
            ...(provider.modelProtocols ? { modelProtocols: provider.modelProtocols } : {}),
            ...(provider.auth ? { auth: provider.auth } : {}),
            baseURL: provider.baseURL,
            apiKeyEnv: provider.apiKeyEnv,
            models: provider.models,
            discoverModels: provider.discoverModels,
            ...(provider.modelCapabilities
              ? { modelCapabilities: provider.modelCapabilities }
              : {}),
          };
          try {
            const params = { provider: runtimeProvider, expectedRevision: providerConfig.revision };
            if (createOnly || newConnectionSecret !== undefined) {
              await saveProviderConnection(
                (method, input) => invoke(bridge, method, input),
                params,
                newConnectionSecret,
              );
            } else {
              await invoke(bridge, "provider.upsert", params);
            }
          } finally {
            // Reconcile partial writes and unknown transport outcomes before allowing a retry.
            await loadGlobalProviderConfig(bridge);
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          }
          setMessage(`Provider ${provider.id} 已保存。`);
        });
      },
      async deleteProvider(providerId) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        return perform("provider-delete", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.delete", {
              providerId,
              expectedRevision: providerConfig.revision,
            });
            await loadGlobalProviderConfig(bridge);
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.filter(
                  (provider) => provider.id !== providerId,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 已删除。`);
        });
      },
      async setDefaultModelRoute(modelRouteId) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        const defaults: RuntimeUserDefaults = {
          ...(modelRouteId ? { modelRouteId } : {}),
          ...(providerConfig.userDefaults.collaborationMode
            ? { collaborationMode: providerConfig.userDefaults.collaborationMode }
            : {}),
          ...(providerConfig.userDefaults.orchestrationMode
            ? { orchestrationMode: providerConfig.userDefaults.orchestrationMode }
            : {}),
          ...(providerConfig.userDefaults.permissionMode
            ? { permissionMode: providerConfig.userDefaults.permissionMode }
            : {}),
          ...(providerConfig.userDefaults.mode ? { mode: providerConfig.userDefaults.mode } : {}),
          ...(providerConfig.userDefaults.thinkingEffort
            ? { thinkingEffort: providerConfig.userDefaults.thinkingEffort }
            : {}),
        };
        return perform("provider-default", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "config.user.update", {
              defaults,
              expectedRevision: providerConfig.revision,
            });
            await loadGlobalProviderConfig(bridge);
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                userDefaults: {
                  ...current.providerConfig.userDefaults,
                  ...(modelRouteId ? { modelRouteId } : { modelRouteId: undefined }),
                },
              },
            }));
          }
          setMessage(modelRouteId ? "默认模型已更新。" : "已清除用户默认模型。");
        });
      },
      async queryUsage(input = {}) {
        let usage: UsageView | undefined;
        await perform("usage-query", async (bridge) => {
          if (preview) {
            usage = { ...previewData.usage, refreshedAt: Date.now() };
            return;
          }
          const params = {
            ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.to !== undefined ? { to: input.to } : {}),
          };
          usage = {
            ...parseUsage(await invoke(bridge, "usage.get", params)),
            refreshedAt: Date.now(),
          };
        });
        return usage;
      },
      async setProviderCredential(providerId, secret, expectedRevision) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable || !secret) return false;
        return perform("provider-credential", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.credential.set", {
              providerId,
              secret,
              expectedRevision,
            });
            await loadGlobalProviderConfig(bridge);
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.map((provider) =>
                  provider.id === providerId
                    ? {
                        ...provider,
                        credentialStatus: "ready",
                        credentialSource: "config",
                        storedCredentialPresent: true,
                      }
                    : provider,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 的 API Key 已保存到 ~/.pico/config.json。`);
        });
      },
      async deleteProviderCredential(providerId, expectedRevision) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        return perform("provider-credential-delete", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.credential.delete", {
              providerId,
              expectedRevision,
            });
            await loadGlobalProviderConfig(bridge);
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.map((provider) =>
                  provider.id === providerId
                    ? {
                        ...provider,
                        credentialStatus: "missing",
                        credentialSource: "none",
                        storedCredentialPresent: false,
                      }
                    : provider,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 在 ~/.pico/config.json 中的 API Key 已删除。`);
        });
      },
      async refreshMemory() {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return;
        await perform("memory-refresh", async (bridge) => {
          await loadMemory(bridge, workspacePath);
        });
      },
      async createMemoryFact(text) {
        const workspacePath = dataRef.current.workspacePath;
        const content = text.trim();
        if (!workspacePath || !dataRef.current.trusted || !content) return undefined;
        let created: RuntimeMemoryFact | undefined;
        setMessage(undefined);
        await perform("memory-create", async (bridge) => {
          if (preview) {
            const now = Date.now();
            const factId = crypto.randomUUID();
            created = {
              factId,
              kind: "reference",
              title: null,
              content,
              confidence: 1,
              state: "active",
              pinned: false,
              version: 1,
              createdAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString(),
              atomic: {
                itemId: factId,
                kind: "note",
                scopeType: "workspace",
                scopeKey: workspacePath,
                statementType: "fact",
                temporalType: "undated",
                observedAt: now,
                eventStartedAt: null,
                eventEndedAt: null,
                origin: "user_requested",
              },
            };
          } else {
            try {
              created = (await invoke(bridge, "memory.create", { workspacePath, text: content }))
                .fact;
            } catch (error) {
              if (
                error instanceof RuntimeInvocationError &&
                error.code === "INVALID_PARAMS" &&
                error.message.includes("安全扫描")
              )
                throw new Error(
                  "内容未通过记忆安全检查，尚未保存。请移除疑似密钥等敏感信息后重试。",
                  { cause: error },
                );
              throw error;
            }
          }
          if (dataRef.current.workspacePath !== workspacePath) return;
          const fact = created;
          // The write is already durable. Show its result even if the follow-up read fails.
          setData((current) =>
            current.workspacePath !== workspacePath
              ? current
              : {
                  ...current,
                  memory: {
                    ...current.memory,
                    workspacePath,
                    facts: [
                      fact,
                      ...(current.memory.workspacePath === workspacePath
                        ? current.memory.facts
                        : []
                      ).filter((item) => item.factId !== fact.factId),
                    ],
                  },
                },
          );
          if (!preview) {
            try {
              await loadMemory(bridge, workspacePath);
            } catch {
              if (dataRef.current.workspacePath === workspacePath)
                setMessage("记忆已保存，但列表刷新失败。请点击刷新重试。");
            }
          }
        });
        return created;
      },
      async updateMemoryFact(factId, expectedVersion, patch) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return undefined;
        let updated: RuntimeMemoryFact | undefined;
        await perform("memory-update", async (bridge) => {
          if (preview) {
            const fact = dataRef.current.memory.facts.find((item) => item.factId === factId);
            if (!fact || fact.version !== expectedVersion) return;
            const { expiresAt: oldExpiresAt, lastUsedAt: oldLastUsedAt, ...baseFact } = fact;
            const { expiresAt, lastUsedAt, ...basePatch } = patch;
            updated = {
              ...baseFact,
              ...basePatch,
              ...(expiresAt === undefined
                ? oldExpiresAt
                  ? { expiresAt: oldExpiresAt }
                  : {}
                : expiresAt === null
                  ? {}
                  : { expiresAt }),
              ...(lastUsedAt === undefined
                ? oldLastUsedAt
                  ? { lastUsedAt: oldLastUsedAt }
                  : {}
                : lastUsedAt === null
                  ? {}
                  : { lastUsedAt }),
              version: fact.version + 1,
              updatedAt: new Date().toISOString(),
            };
            const nextFact = updated;
            setData((current) => {
              return {
                ...current,
                memory: {
                  ...current.memory,
                  facts: current.memory.facts.map((item) =>
                    item.factId === factId ? nextFact : item,
                  ),
                },
              };
            });
          } else {
            const result = await invoke(bridge, "memory.update", {
              workspacePath,
              factId,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
              ...patch,
            });
            updated = result.fact;
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆已更新。");
        });
        return updated;
      },
      async forgetMemoryFact(factId, expectedVersion) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return false;
        return perform("memory-forget", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              memory: {
                ...current.memory,
                facts: current.memory.facts.filter((item) => item.factId !== factId),
              },
            }));
          } else {
            await invoke(bridge, "memory.forget", {
              workspacePath,
              factId,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
            });
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆已删除，无法撤销。");
        });
      },
      async updateMemorySettings(expectedVersion, patch) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return undefined;
        let updated: RuntimeMemorySettings | undefined;
        await perform("memory-settings", async (bridge) => {
          if (preview) {
            const settings = dataRef.current.memory.settings;
            if (!settings || settings.version !== expectedVersion) return;
            const nextSettings: RuntimeMemorySettings = {
              ...settings,
              ...patch,
              autoCommit: false,
              version: settings.version + 1,
              updatedAt: new Date().toISOString(),
            };
            updated = nextSettings;
            setData((current) => ({
              ...current,
              memory: {
                ...current.memory,
                settings: nextSettings,
              },
            }));
          } else {
            const result = await invoke(bridge, "memory.settings.update", {
              workspacePath,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
              ...patch,
            });
            updated = result.settings;
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆设置已更新。");
        });
        return updated;
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
          setData((current) => ({ ...current, backgroundMode: enabled }));
          setMessage(enabled ? "关闭窗口后 Pico 会继续运行。" : "关闭窗口时 Pico 将退出。");
        });
      },
      async openWorkspace(requestedWorkspacePath) {
        const workspacePath = requestedWorkspacePath ?? dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("open-workspace", async (bridge) => {
          const result = await bridge.platform.openDirectory(workspacePath);
          if (!result.ok) throw new Error(result.error.message);
        });
      },
      async initializeWorkspace(requestedWorkspacePath) {
        const workspacePath = requestedWorkspacePath ?? dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("workspace-init", async (bridge) => {
          if (!preview) await invoke(bridge, "workspace.init", { workspacePath });
          setMessage("Pico 项目入口已初始化；已存在的文件保持不变。");
        });
      },
      async runDiagnostics(kind, requestedWorkspacePath) {
        const workspacePath = requestedWorkspacePath ?? dataRef.current.workspacePath;
        if (!workspacePath) return undefined;
        let report: DesktopDiagnosticReport | undefined;
        await perform("diagnostics", async (bridge) => {
          if (preview) {
            report = {
              kind,
              healthy: true,
              checks: [
                {
                  id: "preview",
                  label: "Preview",
                  status: "unavailable",
                  summary: "预览模式不会读取本机状态",
                },
              ],
              output: "Preview 模式不运行本机诊断。",
            };
            return;
          }
          if (kind === "resources") {
            const value = await invoke(bridge, "diagnostics.resources", { workspacePath });
            const entryChecks: RuntimeDiagnosticCheck[] = value.entries.map((entry, index) => ({
              id: `resource:${entry.kind}:${index}`,
              label: entry.kind,
              status:
                entry.status === "unsafe" ? "error" : entry.status === "missing" ? "warning" : "ok",
              summary: entry.path,
              ...(entry.reason ? { recommendation: entry.reason } : {}),
            }));
            const findingChecks: RuntimeDiagnosticCheck[] = value.findings.map(
              (finding, index) => ({
                id: `finding:${index}`,
                label: "扫描发现",
                status: "warning",
                summary: finding,
              }),
            );
            const checks = [...entryChecks, ...findingChecks];
            report = {
              kind,
              healthy: checks.every((check) => check.status !== "error"),
              checks,
              output: value.output,
            };
            return;
          }
          const value = await invoke(bridge, "diagnostics.run", { workspacePath });
          report = {
            kind,
            healthy: value.healthy,
            checks: value.checks,
            output: value.output,
          };
        });
        return report;
      },
    }),
    [
      bootstrap,
      loadConversation,
      loadGlobalProviderConfig,
      loadMemory,
      loadScopedCapabilities,
      loadWorkspace,
      loadWorkspaceIndex,
      perform,
      preview,
    ],
  );

  return { preview, connection, data, busy, message, actions };
}

function createPreviewBridge(): DesktopBridge {
  const success = <T>(value: T): Promise<DesktopResult<T>> => Promise.resolve({ ok: true, value });
  return {
    runtime: new Proxy(
      {},
      {
        get: () => () => success({}),
      },
    ) as DesktopBridge["runtime"],
    events: {
      subscribe: () => ({
        ready: success({ subscribed: true, events: [], hasMore: false }),
        dispose: () => undefined,
      }),
    },
    sessionFrames: {
      subscribe: () => ({ dispose: () => undefined }),
    },
    onUnavailable: () => () => undefined,
    onRecovered: () => () => undefined,
    platform: {
      chooseWorkspace: () => success(previewData.workspacePath),
      showNotification: () => success(undefined),
      openDirectory: () => success(undefined),
      getLaunchAtLogin: () => success(false),
      setLaunchAtLogin: () => success(undefined),
    },
    lifecycle: {
      getBackgroundMode: () => success(false),
      setBackgroundMode: () => success(undefined),
      quit: () => success(undefined),
    },
    browser: {
      acquireViewport: () => success(1),
      setActiveSession: () => success(undefined),
      setViewport: (input) =>
        success({
          sessionId: input.sessionId,
          url: "",
          title: "",
          canGoBack: false,
          canGoForward: false,
          loading: false,
          secure: false,
          hasPage: false,
          visible: input.rect !== null,
          generation: input.generation,
        }),
      navigate: (sessionId, url) =>
        success({
          sessionId,
          url,
          title: url,
          canGoBack: false,
          canGoForward: false,
          loading: false,
          secure: url.startsWith("https://"),
          hasPage: true,
          visible: true,
          generation: 0,
        }),
      back: (sessionId) => success(emptyPreviewBrowserState(sessionId)),
      forward: (sessionId) => success(emptyPreviewBrowserState(sessionId)),
      reload: (sessionId) => success(emptyPreviewBrowserState(sessionId)),
      stop: (sessionId) => success(emptyPreviewBrowserState(sessionId)),
      getState: () => success(null),
      clearPage: (sessionId) => success({ ...emptyPreviewBrowserState(sessionId), visible: true }),
      close: () => success(undefined),
      clearData: () => success(undefined),
      click: (sessionId, selector) =>
        success({ state: emptyPreviewBrowserState(sessionId), selector, tagName: "button" }),
      type: (sessionId, selector) =>
        success({ state: emptyPreviewBrowserState(sessionId), selector, tagName: "input" }),
      onState: () => () => undefined,
    },
  };
}

function emptyPreviewBrowserState(sessionId: string) {
  return {
    sessionId,
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    secure: false,
    hasPage: false,
    visible: false,
    generation: 0,
  } as const;
}
