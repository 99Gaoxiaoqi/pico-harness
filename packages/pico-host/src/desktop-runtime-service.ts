import { requestContextForProvider } from "./runtime-assembly.js";
import { getLatestContextRequest, readLastRequestAnchor } from "./session-context-composition.js";
import { querySessionExecution, querySessionExecutionSummary } from "./session-execution-query.js";
import { projectDeepResearchProgress } from "@pico/core/deep-research";
import { SqliteDeepResearchStore } from "@pico/storage";
import {
  configuredSubagentParent,
  readConfiguredSubagentAdmission,
} from "@pico/runtime/configured-subagent-session";
import { DesktopProviderConfigService } from "./desktop-provider-config-service.js";
import {
  errorMessage,
  toJsonValue,
  requireJsonRecord,
  requireText,
  isJsonRecord,
  isNodeCode,
} from "./index.js";
import { coordinateReasoningLevel, type AtomicMemoryLifecycle } from "@pico/runtime";
import { usagePricing } from "./usage-pricing.js";
import { MODEL_PRICING } from "./catalog-pricing.js";
import type { HookTrustAuthority } from "./hooks/trust/store.js";
import { buildUsageDashboard, type UsageDashboardInput } from "./usage-dashboard.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkbarTerminalError } from "@pico/runtime-host";
import { listRewindPointSummaries } from "./file-history.js";
import {
  createCliSessionId,
  findCliSessionCatalogEntry,
  listCliSessionCatalogEntries,
  removeCliSessionFile,
} from "./session-resolver.js";
import { createContextBudget, estimateMessagesTokens } from "@pico/runtime/context-budget";
import { FullCompactor } from "@pico/runtime/full-compactor";
import { recordRuntimeCompactionCheckpoint } from "@pico/runtime/runtime-compaction-checkpoint";
import { SkillLoader } from "./skill-catalog.js";
import { createSqliteAgentGraphRuntimeEventQueryPort } from "./product-agent-graph-query-service.js";
import { AgentGraphReadOnlyQueryService } from "@pico/runtime";
import { findAgentProfile, loadAgentCatalog } from "./agent-catalog.js";
import { globalSessionPermissionGrants } from "./session-permissions.js";
import { globalClientCapabilityGrants } from "./client-capability-grants.js";
import {
  managedProcessLauncher,
  WindowsTaskNetworkAuthority,
  windowsTaskNetworkControlRoot,
} from "./process-sandbox/index.js";
import { ResourceDoctor, renderResourceDoctorReport } from "./resource-doctor.js";
import { workspaceConfigurationDiagnosticFromRuntime } from "./workspace-configuration-diagnostic.js";
import { runWorkspaceDoctor } from "./workspace-doctor.js";
import { StorageDoctor } from "./storage-doctor.js";
import { SessionForkService } from "./session-fork-service.js";
import { projectRuntimeSessionState } from "@pico/runtime/session-runtime-projection";
import { globalSessionManager, Session } from "./session.js";
import { canonicalResourceName, type PersistedSessionSettings } from "@pico/core";
import {
  getOrCreateSessionSettings,
  migrateSessionModelRoute,
  sessionReasoningCandidates,
  setSessionCollaborationMode,
  setSessionOrchestrationMode,
  setSessionPermissionMode,
  setSessionSideConversation,
  setSessionThinkingEffort,
  setSessionTitle,
  addSessionAdditionalDirectory,
  type SessionSettings,
} from "./input/session-settings.js";
import { loadPicoProjectConfig } from "./input/pico-config.js";
import type { EffectiveConfigResolver } from "./input/effective-config.js";
import type { UserConfigStore } from "./input/user-config-store.js";
import { renderAgentDispatchPrompt } from "./input/agent-activation.js";
import { renderSkillActivation } from "./input/skill-activation.js";
import { initializeProjectEntrypoints } from "./input/project-initializer.js";
import { CostTracker } from "./cost-tracker.js";
import { logger } from "./logger.js";
import { summarizeCacheEffectiveness } from "@pico/runtime/cache-effectiveness";
import { createProvider, type ProviderKind } from "./provider/factory.js";
import { type ModelRoute, type ModelRouter } from "./provider/model-router.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "./provider/effective-model-runtime.js";
import { type CredentialVault } from "./provider/credential-vault.js";
import { resolveProviderProfile } from "@pico/runtime";
import { GoalManager } from "@pico/runtime/goal-manager";
import { evaluateGoal } from "@pico/runtime/goal-evaluator";
import type {
  PersistedGoalState as GoalState,
  PersistedGoalContinuationIntent as GoalContinuationIntent,
  PersistedGoalExecutionRef as GoalExecutionRef,
  Message,
  LLMProvider,
} from "@pico/core";
import {
  GoalContinuationCoordinator,
  type GoalRunCompletion,
  type GoalAdmissionResult,
} from "./goal-continuation-coordinator.js";
import { WorkspaceRunBusyError } from "./workspace-task-runtime.js";
import type { ProviderOperationJournal } from "./provider/provider-operation-journal.js";
import { resolvePicoHome, resolvePicoPaths } from "./pico-paths.js";
import {
  readExistingSqliteSessionEventSlice,
  SqliteRuntimeEventStore,
  type SqliteSessionCatalogEntry,
} from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import {
  SqliteSessionWorkbarRepository,
  WorkbarConflictError,
  WorkbarForbiddenError,
  WorkbarNotFoundError,
  createExternalSessionAdapterRegistry,
  ExternalSessionUnreadableError,
  type ExternalSessionAdapterRegistry,
} from "@pico/storage";
import { RuntimeRun } from "./product-runtime-run.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "./session-fork-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "./workspace-trust.js";
import type { FileHistoryFilePatch, FileHistoryState } from "./file-history-runtime.js";
import {
  fileHistoryChanges,
  fileHistoryRestoreFile,
  type FileHistoryChanges,
} from "./file-history-runtime.js";
import type { ProviderCallRecord, UsageLedgerTotals } from "@pico/storage/runtime-control-types";
import {
  createRuntimeNotification,
  createRuntimeRequest,
  isSafeSubagentPresetId,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  parseRuntimeParams,
  parseRuntimeResult,
  type JsonValue,
  type JsonObject,
  type RuntimeNotification,
  type RuntimeNotificationMap,
  type RuntimeNotificationPage,
  type RuntimeNotificationTopic,
  parseStrictRuntimeParams,
  type RuntimeSkillReference,
  type RuntimeInputAttachment,
  type RuntimeRequest,
  type RuntimeQueuedInput,
  type RuntimeRun as RuntimeRunRecord,
  type RuntimeSession,
  type RuntimeUserDefaults,
  type RuntimeUserInput,
  type RuntimeParams,
} from "@pico/protocol";
import type {
  DisposableLocalRuntimeService,
  RuntimeNotificationCursor,
  ShutdownOwnershipFence,
} from "./local-runtime-service.js";
import type {
  DesktopConversationStateStoreLike,
  DesktopQueuedInput,
} from "./desktop-conversation-state.js";
import { SqliteDesktopConversationStateStore } from "./sqlite-desktop-conversation-state-store.js";
import type { PlanControlPort } from "./plan-control-port.js";
import { PlanCoordinator } from "@pico/runtime/plan-coordinator";
import {
  createConfiguredSubagentCatalog,
  type ConfiguredSubagentCatalog,
} from "./configured-subagent-catalog.js";
import { DesktopSubagentSettingsService } from "./product-desktop-subagent-settings-service.js";
import { listSubagentConnections } from "./subagent-connections.js";
import { createDesktopCatalogRequestHandlers } from "./desktop-catalog-request-handlers.js";
import { createDesktopAutomationRequestHandlers } from "./product-desktop-automation-request-handlers.js";
import { resolveGitBranch } from "./workspace-registry.js";
import { WorkspaceStorageRepairService } from "./workspace-storage-repair.js";

function unavailableWorkspaceStatus(workspacePath: string): WorkspaceStatusResult {
  return {
    workspacePath,
    registered: true,
    schedulerStatus: "unknown",
    mode: "folder",
    branch: "",
    capabilities: {
      foregroundRuns: false,
      fileHistory: false,
      isolatedWorktrees: false,
      branchMerge: false,
    },
    eventLog: null,
  };
}
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { agentGraphLaunchStateFromWorkspaceRun } from "./agent-graph-launch-state.js";
import {
  WorkspaceRuntimeService,
  workspaceStatusResult,
  type DaemonRunExecution,
} from "./workspace-runtime-service.js";
import type { WorkspaceStatusResult } from "@pico/protocol";
import { DesktopAutomationService } from "./desktop-automation-service.js";
import {
  assertDesktopChangesComplete,
  assertDesktopChangesFingerprint,
  projectDesktopCheckpoint,
  type DesktopCheckpointProjection,
} from "./desktop-review.js";
import {
  ingestDesktopRuntimeNotification,
  isDesktopRunBoundaryNotification,
  isDesktopTranscriptNotification,
} from "./desktop-transcript-persistence.js";
import { projectTranscriptEvents, type TranscriptEvent } from "./transcript-event-store.js";
import { PluginRuntimeSnapshotRegistry } from "./plugins/plugin-runtime-snapshot-registry.js";
import { PluginCapabilityActivationScope } from "./plugins/plugin-capability.js";
import { activatePluginProviderCapabilities } from "./plugins/plugin-provider-activation.js";
import { UserMcpConfigStore } from "./user-mcp-config-store.js";
import {
  createDesktopMemoryRequestHandlers,
  createDesktopProviderRequestHandlers,
  createDesktopSessionRequestHandlers,
  createDesktopWorkbarRequestHandlers,
  DesktopRequestRouter,
  type DesktopRequestHandlers,
} from "./index.js";
import { TemporaryWorkspaceAuthority } from "./temporary-workspace-authority.js";
import { DesktopWorkbarGitReviewService } from "./desktop-workbar-git-review-service.js";
import {
  DesktopWorkbarTerminalService,
  type TerminalClientContext,
  isRemoteTerminalContext,
} from "./desktop-workbar-terminal-service.js";
import { WorkbarGitReviewError } from "./workbar-git-review.js";
import { SideChatAuthority, SideChatNoSettledTurnError } from "./side-chat-authority.js";
import { DesktopAtomicMemoryService } from "./desktop-atomic-memory-service.js";
import { sessionMemoryLane } from "@pico/runtime/atomic-memory/session-lane";
import { memorySessionKey } from "@pico/core/atomic-memory-runtime-contracts";
import type { ImagePart } from "@pico/core";
import { readRuntimeModelHistorySnapshot } from "@pico/runtime/session-runtime-read-model";
import { createSessionHookRuntime } from "./hooks/runtime.js";
import { PluginManagementService } from "./plugins/plugin-management-service.js";
import {
  BrowserAgentBrokerError,
  BrowserAgentCommandBroker,
} from "./browser-agent-command-broker.js";
import { ClientCapabilityCommandBroker } from "./client-capability-command-broker.js";
import { loadDesktopClientToken } from "./desktop-client-token.js";
import { DesktopRewindService } from "./desktop-rewind-service.js";

const UNSUPPORTED_DESKTOP_METHODS: ReadonlySet<string> = new Set([
  "approval.respond",
  "prompt.respond",
  "config.update",
] as const);

interface ResolvedRuntimeUserInput {
  readonly input?: RuntimeUserInput;
  readonly prompt: string;
  readonly execution?: DaemonRunExecution;
  /** text 输入的图片附件（3-D 漏账补齐）：daemon 走 resumeExistingSession，
   * 用户消息由本层 commit——附件必须挂在本层而非 engine executor。 */
  readonly images?: ImagePart[];
}

export interface DesktopRuntimeServiceOptions {
  readonly memoryLifecycle?: AtomicMemoryLifecycle;
  readonly runtimeService: WorkspaceRuntimeService;
  readonly registrationStore?: WorkspaceRegistrationStore;
  readonly trustStore?: WorkspaceTrustStore;
  readonly conversationStateStore?: DesktopConversationStateStoreLike;
  readonly interactions?: DesktopRuntimeInteractions;
  readonly planControl?: PlanControlPort;
  readonly automations?: DesktopAutomationService;
  readonly userConfigStore?: UserConfigStore;
  readonly userMcpConfigStore?: UserMcpConfigStore;
  readonly effectiveConfigResolver?: EffectiveConfigResolver;
  readonly credentialVault?: CredentialVault;
  readonly providerOperationJournal?: ProviderOperationJournal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly providerFactory?: typeof createProvider;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  /** Shared immutable Plugin projection used by catalog and session activation. */
  readonly pluginRuntimeSnapshotRegistry?: PluginRuntimeSnapshotRegistry;
  /** Whether this service releases the injected registry after runtime shutdown. */
  readonly ownsPluginRuntimeSnapshotRegistry?: boolean;
  readonly memoryService?: DesktopAtomicMemoryService;
  readonly ownsMemoryService?: boolean;
  /** Commit 完成后通知 Dedicated Session Channel 读取已提交水位。 */
  readonly onTranscriptAdvanced?: (workspacePath: string, sessionId: string) => void;
  readonly reconcilePlanControl?: (workspacePath: string, sessionId: string) => Promise<void>;
  readonly browserAgentBroker?: BrowserAgentCommandBroker;
  readonly clientCapabilityBroker?: ClientCapabilityCommandBroker;
  readonly stopAgentGraph?: (
    workspacePath: string,
    rootSessionId: string,
    graph: { readonly graphId: string; readonly epoch: number },
  ) => Promise<boolean>;
  /** Production Graph lifecycle fence invoked before destructive root Session deletion. */
  readonly retireAgentGraphRootSession?: (
    workspacePath: string,
    rootSessionId: string,
    reason: string,
  ) => Promise<boolean>;
}

export interface DesktopRuntimeInteractions {
  respondApproval(input: {
    readonly workspacePath: string;
    readonly approvalId: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly decision: "allow_once" | "allow_session" | "deny";
    readonly reason?: string;
    readonly idempotencyKey?: string;
  }):
    | { readonly accepted: boolean; readonly alreadyResolved: boolean }
    | Promise<{ readonly accepted: boolean; readonly alreadyResolved: boolean }>;
  respondPrompt(input: {
    readonly workspacePath: string;
    readonly promptId: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly answer: JsonValue;
    readonly idempotencyKey?: string;
  }):
    | { readonly accepted: boolean; readonly alreadyResolved: boolean }
    | Promise<{ readonly accepted: boolean; readonly alreadyResolved: boolean }>;
  cancelPrompt(input: {
    readonly workspacePath: string;
    readonly promptId: string;
    readonly runId?: string;
    readonly sessionId?: string;
    readonly reason?: string;
  }): { readonly cancelled: boolean } | Promise<{ readonly cancelled: boolean }>;
}

/**
 * Desktop control-plane adapter. It composes existing CLI/daemon persistence instead
 * of creating a renderer-owned cache or a second Agent runtime.
 */
export class DesktopRuntimeService implements DisposableLocalRuntimeService {
  private readonly userConfigRevisionTokenKey = randomBytes(32);
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly trustStore: WorkspaceTrustStore;
  private readonly temporaryWorkspace: TemporaryWorkspaceAuthority;
  private readonly conversationStateStore: DesktopConversationStateStoreLike;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly picoHome: string;
  private readonly providerFactory: typeof createProvider;
  private readonly userMcpConfigStore: UserMcpConfigStore;
  private readonly providerConfig: DesktopProviderConfigService;
  private readonly subagentSettings: DesktopSubagentSettingsService;
  private readonly configuredSubagentCatalog: ConfiguredSubagentCatalog;
  private readonly createSessionId: () => string;
  private readonly now: () => number;
  private readonly pluginRuntimeSnapshotRegistry: PluginRuntimeSnapshotRegistry;
  private readonly ownsPluginRuntimeSnapshotRegistry: boolean;
  private readonly memoryService: DesktopAtomicMemoryService;
  private readonly ownsMemoryService: boolean;
  private readonly gitReviewService: DesktopWorkbarGitReviewService;
  private readonly terminalService: DesktopWorkbarTerminalService;
  private readonly rewindService: DesktopRewindService<
    FileHistoryState,
    ReturnType<typeof createSessionForkRuntimePort>
  >;
  private readonly requestRouter: DesktopRequestRouter;
  private readonly unsubscribeRuntimeEvents: () => void;
  private readonly pendingSends = new Map<
    string,
    { readonly requestFingerprint: string; readonly promise: Promise<JsonObject> }
  >();
  private readonly pendingReviews = new Map<
    string,
    { readonly payload: string; readonly promise: Promise<JsonValue> }
  >();
  private readonly agentGraphStores = new Map<string, SqliteAgentGraphControlStore>();
  private readonly inFlightHandles = new Set<Promise<JsonValue>>();
  private readonly goalCoordinator: GoalContinuationCoordinator;
  private readonly goalEvaluationCalls = new Set<Promise<unknown>>();
  private transcriptPersistenceTail: Promise<void> = Promise.resolve();
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private readonly sessionAdmissionTails = new Map<string, Promise<void>>();
  private goalRecoveryPromise: Promise<void> = Promise.resolve();
  private resourceVersion = 0;
  private readonly browserAgentBroker: BrowserAgentCommandBroker;
  private readonly clientCapabilityBroker: ClientCapabilityCommandBroker;
  private readonly storageRepair: WorkspaceStorageRepairService;
  private readonly externalSessionAdapters: ExternalSessionAdapterRegistry;

  constructor(private readonly options: DesktopRuntimeServiceOptions) {
    this.env = options.env ?? process.env;
    this.externalSessionAdapters = createExternalSessionAdapterRegistry(this.env);
    // Test embedders commonly inject only model credentials. Treat a missing PICO_HOME
    // as an overlay omission, while still freezing an explicitly supplied host state root.
    this.picoHome = resolvePicoHome(
      this.env["PICO_HOME"] === undefined ? {} : { picoHome: this.env["PICO_HOME"] },
    );
    this.storageRepair = new WorkspaceStorageRepairService(this.picoHome);
    this.gitReviewService = new DesktopWorkbarGitReviewService();
    this.terminalService = new DesktopWorkbarTerminalService({ picoHome: this.picoHome });
    this.browserAgentBroker = options.browserAgentBroker ?? new BrowserAgentCommandBroker();
    this.clientCapabilityBroker =
      options.clientCapabilityBroker ??
      new ClientCapabilityCommandBroker({
        loadClientToken: () => loadDesktopClientToken(this.picoHome),
      });
    this.registrationStore =
      options.registrationStore ??
      new WorkspaceRegistrationStore(join(this.picoHome, "daemon-workspaces.json"));
    this.trustStore =
      options.trustStore ?? new WorkspaceTrustStore({ userStateDirectory: this.picoHome });
    this.temporaryWorkspace = new TemporaryWorkspaceAuthority({
      picoHome: this.picoHome,
      register: async (workspacePath) => {
        if ((await this.registrationStore.list()).includes(workspacePath)) return workspacePath;
        const result = requireJsonRecord(
          await this.options.runtimeService.handle(
            createRuntimeRequest("workspace.register", { workspacePath }),
          ),
          "workspace.register result",
        );
        return String(result["workspacePath"]);
      },
      trust: async (workspacePath) => {
        if (await this.trustStore.isTrusted(workspacePath)) return;
        await this.setTrust(workspacePath, true);
      },
    });
    this.conversationStateStore =
      options.conversationStateStore ??
      new SqliteDesktopConversationStateStore({ picoHome: this.picoHome });
    this.providerFactory = options.providerFactory ?? createProvider;
    this.userMcpConfigStore =
      options.userMcpConfigStore ?? new UserMcpConfigStore({ picoHome: this.picoHome });
    this.createSessionId = options.createSessionId ?? createCliSessionId;
    this.now = options.now ?? Date.now;
    this.rewindService = new DesktopRewindService({
      picoHome: this.picoHome,
      conversationStateStore: this.conversationStateStore,
      createSessionId: this.createSessionId,
      requireIdleTrustedSession: this.requireIdleTrustedSession.bind(this),
      withSession: this.withSession.bind(this),
      forkRuntimePort: createSessionForkRuntimePort(),
      readChanges: fileHistoryChanges,
      logger,
      notifyCommitted: async ({ workspacePath, sessionId, sourceSessionId, checkpointId }) => {
        const session = await this.requireSession(workspacePath, sessionId);
        this.publishSession(session);
        this.publishTranscriptUpdate(workspacePath, sessionId, "reload");
        this.publish(
          createRuntimeNotification({
            topic: "rewind.completed",
            scope: { workspacePath, sessionId },
            resourceVersion: this.nextResourceVersion(),
            at: this.now(),
            payload: { sessionId, sourceSessionId, checkpointId },
          }),
        );
      },
    });
    this.pluginRuntimeSnapshotRegistry =
      options.pluginRuntimeSnapshotRegistry ??
      new PluginRuntimeSnapshotRegistry({ env: this.env, picoHome: this.picoHome });
    this.ownsPluginRuntimeSnapshotRegistry =
      options.ownsPluginRuntimeSnapshotRegistry ??
      options.pluginRuntimeSnapshotRegistry === undefined;
    this.memoryService =
      options.memoryService ??
      new DesktopAtomicMemoryService({
        picoHome: this.picoHome,
        publish: (workspacePath, topic, payload) =>
          this.publishMemoryNotification(workspacePath, topic, payload),
      });
    this.ownsMemoryService = options.ownsMemoryService ?? options.memoryService === undefined;
    this.providerConfig = new DesktopProviderConfigService({
      picoHome: this.picoHome,
      env: this.env,
      revisionTokenKey: this.userConfigRevisionTokenKey,
      ...(options.userConfigStore === undefined
        ? {}
        : { userConfigStore: options.userConfigStore }),
      ...(options.effectiveConfigResolver === undefined
        ? {}
        : { effectiveConfigResolver: options.effectiveConfigResolver }),
      ...(options.credentialVault === undefined
        ? {}
        : { credentialVault: options.credentialVault }),
      ...(options.providerOperationJournal === undefined
        ? {}
        : { providerOperationJournal: options.providerOperationJournal }),
      listWorkspacePaths: () => this.registrationStore.list(),
      requireTrustedWorkspace: this.requireTrustedWorkspace.bind(this),
      assertNoActiveRuns: this.assertNoActiveRuns.bind(this),
      providerReferences: (providerId, workspacePaths) =>
        this.options.automations?.providerReferences(providerId, workspacePaths) ?? [],
      publishUserConfigUpdated: this.publishUserConfigUpdated.bind(this),
    });
    const getSubagentConnections = () =>
      listSubagentConnections(this.providerConfig.userConfigStore);
    this.configuredSubagentCatalog = createConfiguredSubagentCatalog({
      getPresets: async () =>
        (await this.providerConfig.userConfigStore.read()).config.subagents?.presets ?? [],
      getConnections: getSubagentConnections,
    });
    this.subagentSettings = new DesktopSubagentSettingsService({
      userConfigStore: this.providerConfig.userConfigStore,
      revisionTokenKey: this.userConfigRevisionTokenKey,
      getConnections: getSubagentConnections,
      onUpdated: (revision) => this.publishCapabilityConfigUpdated("subagents", revision),
    });
    this.goalCoordinator = new GoalContinuationCoordinator({
      withSession: (workspace, sessionId, work) => this.withGoalSession(workspace, sessionId, work),
      evaluate: (workspace, session, goal, execution, messages, signal) =>
        this.evaluateGoalForSession(workspace, session, goal, execution, messages, signal),
      admit: (workspace, sessionId, intent) =>
        this.admitGoalContinuation(workspace, sessionId, intent),
      dispatchUser: (workspace) => this.consumeWorkspaceQueued(workspace),
      getRun: async (workspace, runId) => {
        const run = await this.options.runtimeService.getWorkspaceRun(workspace, runId);
        return run ? goalRunCompletion(run as unknown as JsonObject) : undefined;
      },
      changed: (workspace, sessionId, goal) => this.publishGoalChanged(workspace, sessionId, goal),
      report: (workspace, error) => this.publishConversationFailure(workspace, error),
      now: this.now,
    });
    this.unsubscribeRuntimeEvents = options.runtimeService.subscribe((event) => {
      const sessionId = event.scope.sessionId;
      if (!sessionId) return;

      if (isDesktopTranscriptNotification(event.topic)) {
        this.transcriptPersistenceTail = this.transcriptPersistenceTail.then(
          () => this.persistRuntimeNotification(event),
          () => this.persistRuntimeNotification(event),
        );
        void this.transcriptPersistenceTail.catch((error: unknown) =>
          this.publishConversationFailure(event.scope.workspacePath, error),
        );
      }
      if (event.topic !== "run.finished") return;
      if (this.lifecycleState !== "open") return;
      const run =
        isJsonRecord(event.payload) && isJsonRecord(event.payload["run"])
          ? event.payload["run"]
          : undefined;
      if (!run || typeof run["runId"] !== "string") return;
      void this.goalCoordinator.finish(
        event.scope.workspacePath,
        sessionId,
        goalRunCompletion(run),
      );
    });
    this.requestRouter = new DesktopRequestRouter({
      handlers: this.createRequestHandlers(),
      unsupportedMethods: UNSUPPORTED_DESKTOP_METHODS,
      fallback: (request) => this.options.runtimeService.handle(request),
      methodNotFound: (method) =>
        new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
          `${method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
        ),
    });
    this.goalRecoveryPromise = this.providerConfig.ready
      .then(() => this.reconcileGoalContinuations())
      .catch((error: unknown) =>
        logger.warn({ error: String(error) }, "[Goal] 启动时恢复续跑意图失败"),
      );
  }

  handle(request: RuntimeRequest, context?: TerminalClientContext): Promise<JsonValue> {
    try {
      this.assertAcceptingRequests();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.providerConfig.ready.then(() =>
      context && request.method.startsWith("terminal.")
        ? this.handleClientTerminalRequest(request, context)
        : context &&
            ["session.delete", "session.list", "sideChat.close", "sideChat.create"].includes(
              request.method,
            )
          ? this.handleClientSessionCleanupRequest(request, context)
          : this.dispatchRequest(request),
    );
    this.inFlightHandles.add(operation);
    void operation.then(
      () => {
        this.inFlightHandles.delete(operation);
      },
      () => {
        this.inFlightHandles.delete(operation);
      },
    );
    return operation;
  }

  releaseTerminalAttachment(attachmentId: string): void {
    this.terminalService.releaseAttachment(attachmentId);
  }

  private handleClientTerminalRequest(
    request: RuntimeRequest,
    context: TerminalClientContext,
  ): Promise<JsonValue> {
    // Terminal context is supplied by the trusted local IPC bridge, never by JSON params.
    return this.withHostWorkbarErrors(async () => {
      switch (request.method) {
        case "terminal.create":
          return this.terminalService.create(
            parseRuntimeParams("terminal.create", request.params),
            context,
          );
        case "terminal.list":
          return this.terminalService.list(
            parseRuntimeParams("terminal.list", request.params),
            context,
          );
        case "terminal.attach":
          return this.terminalService.attach(
            parseRuntimeParams("terminal.attach", request.params),
            context,
          );
        case "terminal.input":
          return this.terminalService.input(
            parseRuntimeParams("terminal.input", request.params),
            context,
          );
        case "terminal.resize":
          return this.terminalService.resize(
            parseRuntimeParams("terminal.resize", request.params),
            context,
          );
        case "terminal.stop":
          return this.terminalService.stop(
            parseRuntimeParams("terminal.stop", request.params),
            context,
          );
        case "terminal.detach":
          return this.terminalService.detach(
            parseRuntimeParams("terminal.detach", request.params),
            context,
          );
        case "terminal.stopOwned":
          return this.terminalService.stopOwned(context);
        case "terminal.resume":
          return this.terminalService.resume(context);
        default:
          return this.dispatchRequest(request);
      }
    });
  }

  private handleClientSessionCleanupRequest(
    request: RuntimeRequest,
    context: TerminalClientContext,
  ): Promise<JsonValue> {
    return this.withHostWorkbarErrors(async () => {
      switch (request.method) {
        case "session.delete": {
          const params = parseRuntimeParams("session.delete", request.params);
          return this.deleteSession(params.workspacePath, params.sessionId, context);
        }
        case "session.list": {
          const params = parseRuntimeParams("session.list", request.params);
          return this.listSessions(params.workspacePath, params.includeArchived, context);
        }
        case "sideChat.close":
          return this.closeSideChat(parseRuntimeParams("sideChat.close", request.params), context);
        case "sideChat.create":
          return this.createSideChat(
            parseRuntimeParams("sideChat.create", request.params),
            context,
          );
        default:
          return this.dispatchRequest(request);
      }
    });
  }

  private createRequestHandlers(): DesktopRequestHandlers {
    return {
      "externalSessions.sources": async () => ({
        sources: toJsonValue(await this.externalSessionAdapters.listSources()),
      }),
      "externalSessions.list": async (request) =>
        toJsonValue(
          await this.externalSessionAdapters.listPage(request.params.adapterId, {
            ...(request.params.text === undefined ? {} : { text: request.params.text }),
            ...(request.params.cursor === undefined ? {} : { cursor: request.params.cursor }),
          }),
        ),
      "externalSessions.import": (request) => this.importExternalSession(request.params),
      "workspace.storageRepair.prepare": (request) =>
        this.storageRepair.prepare(request.params.workspacePath),
      "workspace.storageRepair.respond": (request) => this.storageRepair.respond(request.params),
      "diagnostics.run": (request) => this.runDiagnostics(request.params.workspacePath),
      "diagnostics.resources": (request) =>
        this.runResourceDiagnostics(request.params.workspacePath),
      "subagents.get": async (request) =>
        toJsonValue(await this.subagentSettings.get(request.params)),
      "subagents.update": async (request) =>
        toJsonValue(await this.subagentSettings.update(request.params)),
      "catalog.models": (request) => this.providerConfig.listModels(request.params.workspacePath),
      "config.get": (request) => this.providerConfig.getConfig(request.params.workspacePath),
      "config.effective.get": (request) => this.providerConfig.getEffectiveConfig(request.params),
      "usage.get": (request) => this.getUsage(request.params),
      "changes.list": (request) =>
        this.listChanges(request.params.workspacePath, request.params.runId),
      "changes.diff": (request) =>
        this.getChangeDiff(request.params.workspacePath, request.params.runId, request.params.path),
      "changes.review": (request) => this.reviewChanges(request.params),
      "changes.apply": (request) =>
        this.applyChanges(
          request.params.workspacePath,
          request.params.runId,
          request.params.expectedFingerprint,
        ),
      "git.review.snapshot": (request) =>
        this.withHostWorkbarErrors(() => this.gitReviewService.snapshot(request.params)),
      "git.review.diff": (request) =>
        this.withHostWorkbarErrors(() => this.gitReviewService.diff(request.params)),
      "browser.agent.lease": (request) =>
        this.withBrowserAgentErrors(() => this.browserAgentBroker.acquireLease(request.params)),
      "browser.agent.next": (request) =>
        this.withBrowserAgentErrors(() => this.browserAgentBroker.nextCommand(request.params)),
      "browser.agent.resolve": (request) =>
        this.withBrowserAgentErrors(() => this.browserAgentBroker.resolveCommand(request.params)),
      "client.capability.next": (request) =>
        this.clientCapabilityBroker.nextCommand(request.params),
      "client.capability.resolve": (request) =>
        this.clientCapabilityBroker.resolveCommand(request.params),
      "client.capability.authorize": (request) =>
        this.clientCapabilityBroker.authorizeCommand(request.params),
      "client.capability.check": (request) =>
        this.clientCapabilityBroker.checkCommand(request.params),
      "terminal.create": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.create(request.params)),
      "terminal.list": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.list(request.params)),
      "terminal.attach": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.attach(request.params)),
      "terminal.input": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.input(request.params)),
      "terminal.resize": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.resize(request.params)),
      "terminal.stop": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.stop(request.params)),
      "terminal.detach": (request) =>
        this.withHostWorkbarErrors(() => this.terminalService.detach(request.params)),
      "terminal.ownershipCapabilities": async () => ({
        ownerIsolation: true as const,
        sessionCleanupIsolation: true as const,
      }),
      "terminal.stopOwned": () =>
        this.withHostWorkbarErrors(() => this.terminalService.stopOwned()),
      "terminal.stopAll": () => this.withHostWorkbarErrors(() => this.terminalService.stopAll()),
      "terminal.resume": () => this.withHostWorkbarErrors(() => this.terminalService.resume()),
      "sideChat.create": (request) => this.createSideChat(request.params),
      "sideChat.close": (request) => this.closeSideChat(request.params),
      "rewind.list": (request) =>
        this.listRewindPoints(request.params.workspacePath, request.params.sessionId),
      "rewind.preview": (request) =>
        this.previewRewind(
          request.params.workspacePath,
          request.params.sessionId,
          request.params.checkpointId,
        ),
      "rewind.apply": (request) => this.rewindService.apply(request.params),
      "rewind.changes": (request) =>
        this.listRewindFileChanges(
          request.params.workspacePath,
          request.params.sessionId,
          request.params.checkpointId,
        ),
      "rewind.restoreFile": (request) => this.restoreRewindFile(request.params),
      "hooks.manage": (request) => this.manageHooks(request.params),
      "operations.manage": (request) => this.manageOperations(request.params),
      "plugin.manage": (request) => this.managePlugins(request.params),
      "approval.respond": async (request) => {
        if (!this.options.interactions) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
          );
        }
        const result = await this.options.interactions.respondApproval(request.params);
        this.goalCoordinator.wakeWorkspace(request.params.workspacePath);
        return result;
      },
      "plan.respond": async (request) => {
        if (!this.options.planControl) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接持久化 PlanControlPort，本次请求未执行`,
          );
        }
        const result = await this.options.planControl.respond(request.params);
        this.goalCoordinator.wakeWorkspace(request.params.workspacePath);
        return {
          accepted: result.accepted,
          projection: toJsonValue(result.projection),
          ...(result.run ? { run: toJsonValue(result.run) } : {}),
        };
      },
      "prompt.respond": (request) => {
        if (!this.options.interactions) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
          );
        }
        return this.options.interactions.respondPrompt(request.params);
      },
      "prompt.cancel": (request) => {
        if (!this.options.interactions) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
          );
        }
        return this.options.interactions.cancelPrompt(request.params);
      },
      ...createDesktopProviderRequestHandlers({
        getUserConfig: this.providerConfig.getUserConfig.bind(this.providerConfig),
        updateUserConfig: this.providerConfig.updateUserConfig.bind(this.providerConfig),
        listUserProviders: this.providerConfig.listUserProviders.bind(this.providerConfig),
        testProviderConnection: this.providerConfig.testProviderConnection.bind(
          this.providerConfig,
        ),
        upsertUserProvider: this.providerConfig.upsertUserProvider.bind(this.providerConfig),
        importEnvironmentProvider: this.providerConfig.importEnvironmentProvider.bind(
          this.providerConfig,
        ),
        deleteUserProvider: this.providerConfig.deleteUserProvider.bind(this.providerConfig),
        getProviderCredentialStatus: this.providerConfig.getProviderCredentialStatus.bind(
          this.providerConfig,
        ),
        setProviderCredential: this.providerConfig.setProviderCredential.bind(this.providerConfig),
        deleteProviderCredential: this.providerConfig.deleteProviderCredential.bind(
          this.providerConfig,
        ),
        withProviderDependencyLock: (operation) =>
          this.providerConfig.withProviderDependencyLock(operation),
      }),
      ...createDesktopCatalogRequestHandlers({
        configuredSubagentCatalog: this.configuredSubagentCatalog,
        env: this.env,
        picoHome: this.picoHome,
        pluginRuntimeSnapshotRegistry: this.pluginRuntimeSnapshotRegistry,
        trustStore: this.trustStore,
        userMcpConfigStore: this.userMcpConfigStore,
        requireTrustedWorkspace: this.requireTrustedWorkspace.bind(this),
        projectCapabilityRevision: this.projectCapabilityRevision.bind(this),
        publishCapabilityConfigUpdated: this.publishCapabilityConfigUpdated.bind(this),
      }),
      ...createDesktopAutomationRequestHandlers({
        ...(this.options.automations === undefined
          ? {}
          : { automations: this.options.automations }),
        credentialVault: this.providerConfig.credentialVault,
        effectiveConfigResolver: this.providerConfig.effectiveConfigResolver,
        userConfigStore: this.providerConfig.userConfigStore,
        pluginRuntimeSnapshotRegistry: this.pluginRuntimeSnapshotRegistry,
        now: this.now,
        requireTrustedWorkspace: this.requireTrustedWorkspace.bind(this),
        publishJob: this.publishJob.bind(this),
        withProviderDependencyLock: (operation) =>
          this.providerConfig.withProviderDependencyLock(operation),
      }),
      ...createDesktopSessionRequestHandlers({
        initializeWorkspace: this.initializeWorkspace.bind(this),
        listWorkspaces: this.listWorkspaces.bind(this),
        getWorkspaceStatus: this.getWorkspaceStatus.bind(this),
        ensureTemporaryWorkspace: this.ensureTemporaryWorkspace.bind(this),
        trustStatus: this.trustStatus.bind(this),
        setTrust: this.setTrust.bind(this),
        unregisterWorkspace: this.unregisterWorkspace.bind(this),
        listSessions: this.listSessions.bind(this),
        getSession: this.getSession.bind(this),
        createSession: this.createSession.bind(this),
        setSessionArchived: this.setSessionArchived.bind(this),
        setSessionPinned: this.setSessionPinned.bind(this),
        deleteSession: this.deleteSession.bind(this),
        renameSession: this.renameSession.bind(this),
        forkSession: this.forkSession.bind(this),
        reviseSession: this.reviseSession.bind(this),
        updateQueuedInput: this.updateQueuedInput.bind(this),
        removeQueuedInput: this.removeQueuedInput.bind(this),
        reorderQueuedInputs: this.reorderQueuedInputs.bind(this),
        moveQueuedInputToNext: this.moveQueuedInputToNext.bind(this),
        compactSession: this.compactSession.bind(this),
        getRuntimeSessionSettings: this.getRuntimeSessionSettings.bind(this),
        getSessionContextReport: this.getSessionContextReport.bind(this),
        addSessionDirectory: this.addSessionDirectory.bind(this),
        updateRuntimeSessionSettings: this.updateRuntimeSessionSettings.bind(this),
        getGoal: this.getGoal.bind(this),
        controlGoal: this.controlGoal.bind(this),
        sendSession: this.sendSession.bind(this),
        cancelRun: this.cancelRun.bind(this),
        withProviderDependencyLock: (operation, kind) =>
          this.providerConfig.withProviderDependencyLock(operation, kind),
        runStart: (request) => this.options.runtimeService.handle(request),
      }),
      ...createDesktopWorkbarRequestHandlers({
        "session.research.query": this.querySessionResearch.bind(this),
        "session.tasks.query": this.querySessionTasks.bind(this),
        "session.tasks.command": this.commandSessionTasks.bind(this),
        "session.artifacts.query": this.querySessionArtifacts.bind(this),
        "session.artifacts.command": this.commandSessionArtifacts.bind(this),
        "session.trace.query": this.querySessionTrace.bind(this),
        "session.execution.query": this.querySessionExecution.bind(this),
        "session.execution.summary": this.querySessionExecutionSummary.bind(this),
        "session.graph.query": this.querySessionGraph.bind(this),
        "session.graph.retryWake": this.retrySessionGraphWake.bind(this),
        "session.graph.stop": this.stopSessionGraph.bind(this),
      }),
      ...createDesktopMemoryRequestHandlers({
        list: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.list(canonical, params),
          ),
        get: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.get(canonical, params.itemId),
          ),
        create: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.create(canonical, params.text),
          ),
        update: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.update(canonical, params),
          ),
        delete: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.delete(canonical, params),
          ),
        getSettings: (params) =>
          params.workspacePath
            ? this.withTrustedMemory(params.workspacePath, (canonical) =>
                this.memoryService.getSettings(canonical),
              )
            : this.memoryService.getSettings(this.picoHome),
        updateSettings: (params) =>
          params.workspacePath
            ? this.withTrustedMemory(params.workspacePath, (canonical) =>
                this.memoryService.updateSettings(canonical, params),
              )
            : this.memoryService.updateSettings(this.picoHome, params),
        previewContext: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.previewContext(canonical, params),
          ),
      }),
    };
  }

  private async importExternalSession(
    params: RuntimeParams<"externalSessions.import">,
  ): Promise<JsonValue> {
    const external = await this.externalSessionAdapters.readSession(
      params.adapterId,
      params.sourceSessionId,
    );
    if (!external.summary.cwd.trim()) {
      throw new ExternalSessionUnreadableError("外部会话没有记录工作区路径，无法安全导入");
    }
    const workspacePath = await this.requireTrustedWorkspace(external.summary.cwd);
    const messages = external.messages.filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    );
    if (messages.length === 0) {
      throw new ExternalSessionUnreadableError("外部会话中没有可导入的对话文本");
    }

    const sessionId = `cli-ext-${createHash("sha256")
      .update(workspacePath)
      .update("\0")
      .update(params.adapterId)
      .update("\0")
      .update(params.sourceSessionId)
      .digest("hex")
      .slice(0, 32)}`;
    return this.withSessionAdmission(workspacePath, sessionId, async () => {
      const existing = await findCliSessionCatalogEntry(workspacePath, sessionId, {
        picoHome: this.picoHome,
      });
      if (existing && (existing.summary.messageCount ?? 0) > 0) {
        await this.options.runtimeService.handle(
          createRuntimeRequest("workspace.register", { workspacePath }),
        );
        const created = await this.requireSession(workspacePath, sessionId);
        this.publishSession(created);
        return { session: created };
      }

      const session = new Session(sessionId, workspacePath, {
        persistence: true,
        picoHome: this.picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        await session.recover();
        const settings = await this.initializeSessionSettings(workspacePath, session);
        const title = setSessionTitle(settings, external.summary.title);
        if (!title.ok) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, title.message);
        }
        await session.flushPersistence();
        await session.importHistoryMessages(messages);
        await session.flushPersistence();
      } finally {
        await session.close();
      }

      await this.options.runtimeService.handle(
        createRuntimeRequest("workspace.register", { workspacePath }),
      );

      const created = await this.requireSession(workspacePath, sessionId);
      this.publishSession(created);
      return { session: created };
    });
  }

  private dispatchRequest(request: RuntimeRequest): Promise<JsonValue> {
    return this.requestRouter.dispatch(request);
  }

  replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage> {
    return this.options.runtimeService.replayEvents(cursor);
  }

  subscribe(listener: (notification: RuntimeNotification) => void): () => void {
    return this.options.runtimeService.subscribe(listener);
  }

  planControlAvailable(): boolean {
    return this.options.planControl !== undefined;
  }

  /** Metadata half of the atomic Runtime Host session subscription snapshot. */
  async readSessionContinuityMetadata(
    workspacePath: string,
    sessionId: string,
  ): Promise<{
    readonly session: RuntimeSession;
    readonly queuedInputs: readonly RuntimeQueuedInput[];
    readonly activeRun?: RuntimeRunRecord;
    readonly planIntents?: readonly {
      readonly runId: string;
      readonly operationId: string;
      readonly controlEpoch: string;
      readonly planId: string;
      readonly revision: number;
      readonly action: "execute" | "continue_editing" | "resume_execution" | "replan_execution";
      readonly runStatus?: RuntimeRunRecord["status"];
    }[];
  }> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    await this.options.reconcilePlanControl?.(canonical, sessionId);
    // The subscription reads a fixed durable watermark. Pending desktop entries
    // publish their own advance when committed; waiting for the writer queue here
    // can wait for an entire running Session (and block the live subscription lane).
    const session = (await this.requireSession(canonical, sessionId)) as unknown as RuntimeSession;
    const activeRun = (await this.findActiveSessionRun(canonical, sessionId)) as
      | RuntimeRunRecord
      | undefined;
    const queuedInputs = (await this.conversationStateStore.listQueued(canonical, sessionId)).map(
      (input) => ({
        queueId: input.queueId,
        sessionId: input.sessionId,
        input: input.input,
        createdAt: input.createdAt,
      }),
    );
    const planIntents = await Promise.all(
      (await this.options.runtimeService.listPlanReviewRunIntents(canonical, sessionId)).map(
        async (intent) => {
          const run = await this.options.runtimeService.getWorkspaceRun(canonical, intent.runId);
          return {
            runId: intent.runId,
            operationId: intent.input.operationId,
            controlEpoch: intent.input.controlEpoch,
            planId: intent.input.planId,
            revision: intent.input.revision,
            action: intent.input.action,
            ...(run ? { runStatus: run.status } : {}),
          };
        },
      ),
    );
    return {
      session,
      queuedInputs,
      ...(activeRun ? { activeRun } : {}),
      ...(planIntents.length ? { planIntents } : {}),
    };
  }

  beginDrain(): void {
    this.options.memoryLifecycle?.beginDrain();
  }

  close(): Promise<void> {
    this.beginDrain();
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  providerAdmissionMetrics(
    reset = false,
  ): ReturnType<DesktopProviderConfigService["providerAdmissionMetrics"]> {
    return this.providerConfig.providerAdmissionMetrics(reset);
  }

  shutdownOwnershipFence(): ShutdownOwnershipFence {
    return this.options.runtimeService.shutdownOwnershipFence();
  }

  private async closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    };
    // All accepted handles can still enter Provider admission; seal it after they drain.
    await Promise.allSettled([...this.inFlightHandles]);
    await this.providerConfig.close();
    await this.goalRecoveryPromise;
    await attempt(() => this.goalCoordinator.close());
    await Promise.allSettled([...this.goalEvaluationCalls]);
    await Promise.allSettled([...this.pendingSends.values()].map(({ promise }) => promise));
    await Promise.allSettled([...this.sessionAdmissionTails.values()]);
    await Promise.allSettled([...this.inFlightHandles]);
    // Workspace shutdown emits the terminal boundary for every active foreground Run.
    // Keep the projection subscriber and RuntimeStore alive until those events are projected.
    try {
      await attempt(() => this.options.runtimeService.closeRuntimes());
      await attempt(() => this.options.memoryLifecycle?.close());
      await attempt(() => this.transcriptPersistenceTail);
      for (const store of this.agentGraphStores.values()) await attempt(() => store.close());
      this.agentGraphStores.clear();
      this.unsubscribeRuntimeEvents();
      await attempt(() => this.options.runtimeService.close());
      if (this.ownsPluginRuntimeSnapshotRegistry) {
        await attempt(() => this.pluginRuntimeSnapshotRegistry.dispose());
      }
      if (this.ownsMemoryService) await attempt(() => this.memoryService.close());
      await attempt(() => this.terminalService.close());
      this.browserAgentBroker.close();
      this.clientCapabilityBroker.close();
    } finally {
      this.lifecycleState = "closed";
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop Runtime cleanup failed");
    }
  }

  private async listWorkspaces(): Promise<JsonValue> {
    const workspaces = await Promise.all(
      (await this.registrationStore.listRegistrations()).map(async (registration) => {
        const { workspacePath, projectId, projectName } = registration;
        const project = { projectId, projectName };
        // 注册项可能指向已删除的目录（崩溃的���试/客户端残留；注册表 list() 会
        // 过滤缺失目录，这里是过滤与物化之间的竞态护栏）。真机事故
        // （2026-08-16）：真 home 累积 54 个存活的 %TEMP% e2e 工作区，单次
        // workspace.list 物化全部 runtime 推过 kernel 操作 deadline，连接被
        // 整条拆断——根治在 e2e 隔离 daemon root，这里保证残留永不致命。
        if (!existsSync(workspacePath)) {
          return this.decorateWorkspaceStatus(
            {
              workspacePath,
              registered: true,
              schedulerStatus: "unknown",
              mode: "folder",
              branch: "",
              capabilities: {
                foregroundRuns: false,
                fileHistory: false,
                isolatedWorktrees: false,
                branchMerge: false,
              },
              eventLog: null,
            } satisfies WorkspaceStatusResult,
            project,
          );
        }
        try {
          const runtime = await this.options.runtimeService.getWorkspaceRuntime(workspacePath);
          return this.decorateWorkspaceStatus(
            workspaceStatusResult(
              runtime,
              true,
              runtime.mode === "git" ? await resolveGitBranch(runtime.workspace) : undefined,
            ),
            project,
          );
        } catch (error) {
          // A registered workspace may still contain storage from an unsupported era.
          // Listing is the Desktop bootstrap boundary: one unavailable workspace must
          // remain discoverable without preventing every other workspace from opening.
          logger.warn({ workspacePath, err: error }, "Workspace status materialization failed");
          return this.decorateWorkspaceStatus(unavailableWorkspaceStatus(workspacePath), project);
        }
      }),
    );
    return { workspaces };
  }

  private async getWorkspaceStatus(workspacePath: string): Promise<JsonValue> {
    const status = requireJsonRecord(
      await this.options.runtimeService.handle(
        createRuntimeRequest("workspace.status", { workspacePath }),
      ),
      "workspace.status result",
    ) as WorkspaceStatusResult;
    return this.decorateWorkspaceStatus(status);
  }

  private async ensureTemporaryWorkspace(): Promise<JsonValue> {
    return this.getWorkspaceStatus(await this.temporaryWorkspace.ensure());
  }

  private async decorateWorkspaceStatus(
    status: WorkspaceStatusResult,
    registeredProject?: { readonly projectId: string | null; readonly projectName: string | null },
  ): Promise<WorkspaceStatusResult> {
    const temporary = this.temporaryWorkspace.matches(status.workspacePath);
    const project = temporary
      ? { projectId: null, projectName: null }
      : (registeredProject ?? (await this.registrationStore.projectMetadata(status.workspacePath)));
    return {
      ...status,
      ...project,
      ...(temporary ? { temporary: true as const } : {}),
    };
  }

  private async initializeWorkspace(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const listed = requireJsonRecord(
      await this.options.runtimeService.handle(
        createRuntimeRequest("runs.list", { workspacePath: canonical }),
      ),
      "runs.list result",
    );
    const runs = Array.isArray(listed["runs"]) ? listed["runs"] : [];
    if (
      runs.filter(isJsonRecord).some((run) => !isTerminalRunStatus(String(run["status"] ?? "")))
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        "工作区仍有活动 Run，不能执行初始化",
      );
    }
    try {
      const result = await initializeProjectEntrypoints(canonical);
      this.publish(
        createRuntimeNotification({
          topic: "workspace.initialized",
          scope: { workspacePath: canonical },
          resourceVersion: this.nextResourceVersion(),
          at: this.now(),
          payload: toJsonValue(result),
        }),
      );
      return toJsonValue(result);
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async runDiagnostics(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const effective = await this.loadSessionModelRuntime(canonical);
    const defaults = effectiveSessionSettingDefaults(effective);
    return toJsonValue(
      await runWorkspaceDoctor({
        workDir: canonical,
        provider: defaults.provider,
        model: defaults.model,
        taskRuntimeAvailable: true,
        storageDoctor: new StorageDoctor({ workDir: canonical, picoHome: this.picoHome }),
        configuration: workspaceConfigurationDiagnosticFromRuntime(effective),
      }),
    );
  }

  private async runResourceDiagnostics(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const report = await new ResourceDoctor({
      workDir: canonical,
      picoHome: this.picoHome,
    }).scan();
    const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(canonical);
    const pluginDiagnostics = pluginSnapshot.diagnostics.map((diagnostic) => ({
      pluginId: diagnostic.pluginId,
      sourcePath: diagnostic.sourcePath,
      message: diagnostic.message,
      ...(diagnostic.code ? { code: diagnostic.code } : {}),
      ...(diagnostic.scope ? { scope: diagnostic.scope } : {}),
      ...(diagnostic.severity ? { severity: diagnostic.severity } : {}),
      ...(diagnostic.compatibility ? { compatibility: diagnostic.compatibility } : {}),
    }));
    return toJsonValue({
      ...report,
      ...(pluginDiagnostics.length > 0 ? { pluginDiagnostics } : {}),
      output: [
        ...renderResourceDoctorReport(report),
        ...(pluginDiagnostics.length > 0
          ? pluginDiagnostics.map(
              (diagnostic) =>
                `Plugin finding: ${diagnostic.pluginId}${diagnostic.scope ? ` [${diagnostic.scope}]` : ""}${diagnostic.code ? ` · ${diagnostic.code}` : ""} · ${diagnostic.sourcePath} · ${diagnostic.message}`,
            )
          : []),
      ].join("\n"),
    });
  }

  private async trustStatus(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.trustStore.canonicalize(workspacePath);
    return { workspacePath: canonical, trusted: await this.trustStore.isTrusted(canonical) };
  }

  private async setTrust(workspacePath: string, trusted: boolean): Promise<JsonValue> {
    const canonical = await this.trustStore.canonicalize(workspacePath);
    if (!trusted && this.temporaryWorkspace.matches(canonical)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        "Pico 临时工作区由 Runtime 管理，不能撤销信任",
      );
    }
    await this.trustStore.setTrusted(canonical, trusted);
    if (!trusted) this.pluginRuntimeSnapshotRegistry.invalidate(canonical);
    this.publish(
      createRuntimeNotification({
        topic: "workspace.trustChanged",
        scope: { workspacePath: canonical },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { trusted },
      }),
    );
    return { workspacePath: canonical, trusted };
  }

  private async listSessions(
    workspacePath: string,
    includeArchived = false,
    context?: TerminalClientContext,
  ): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    const sideChats = this.sideChatAuthority(canonical, context);
    if (!isRemoteTerminalContext(context)) await sideChats.recover();
    const hiddenSessionIds = new Set(sideChats.list().map((lease) => lease.targetSessionId));
    for (const childSessionId of this.agentGraphStore(canonical).listOperatorSessionIds()) {
      hiddenSessionIds.add(childSessionId);
    }
    // 归档/置顶已并入 sessions 表(catalog 投影行),desktop session-state.json 退役。
    const entries = await listCliSessionCatalogEntries(canonical, { picoHome: this.picoHome });
    await this.withWorkspaceSessionStore(canonical, async (store) => {
      for (const entry of entries) {
        if (await readConfiguredSubagentAdmission(store, entry.summary.id))
          hiddenSessionIds.add(entry.summary.id);
      }
    });
    const sessions = entries
      .filter(
        (entry) =>
          !hiddenSessionIds.has(entry.summary.id) && (includeArchived || !entry.isArchived),
      )
      .map((entry) => sessionPayload(entry));
    return { sessions };
  }

  private async getSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    return { session: await this.requireSession(canonical, sessionId) };
  }

  private async createSession(
    workspacePath: string,
    title?: string,
    sessionId = createCliSessionId(),
    modelRouteId?: string,
  ): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    const session = new Session(sessionId, canonical, {
      persistence: true,
      picoHome: this.picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      await session.recover();
      const settings = await this.initializeSessionSettings(canonical, session, modelRouteId);
      if (title !== undefined) {
        const result = setSessionTitle(settings, requireText(title, "title"));
        if (!result.ok) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, result.message);
        }
      }
      // recover() 已初始化 durable manifest；Usage 只由 model.call.settled 持久化。
      await session.flushPersistence();
    } finally {
      await session.close();
    }
    const created = await this.requireSession(canonical, sessionId);
    this.publishSession(created);
    return { session: created };
  }

  private async setSessionArchived(
    workspacePath: string,
    sessionId: string,
    archived: boolean,
  ): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    await this.requireSession(canonical, sessionId);
    await sessionMemoryLane.run(
      this.memoryLaneKey(canonical, sessionId),
      "foreground",
      async () => {
        if (archived) await this.revokeWindowsTaskNetwork(sessionId);
        await this.withWorkspaceSessionStore(canonical, (store) =>
          store.setSessionArchived(sessionId, archived, this.now),
        );
      },
    );
    if (archived) {
      this.browserAgentBroker.invalidateSession(sessionId, "浏览器 Session 已归档");
      this.clientCapabilityBroker.invalidateSession(sessionId, "Desktop 能力 Session 已归档");
      globalSessionPermissionGrants.clear(sessionId, canonical, this.picoHome);
      await globalClientCapabilityGrants.revokeSession(
        sessionId,
        resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
      );
    }
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private async setSessionPinned(
    workspacePath: string,
    sessionId: string,
    pinned: boolean,
  ): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    await this.requireSession(canonical, sessionId);
    await this.withWorkspaceSessionStore(canonical, (store) =>
      store.setSessionPinned(sessionId, pinned, this.now),
    );
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private memoryLaneKey(workspacePath: string, sessionId: string): string {
    const paths = resolvePicoPaths(workspacePath, { picoHome: this.picoHome });
    return `${this.picoHome}:${memorySessionKey(paths.workspace.id, sessionId)}`;
  }

  private async revokeWindowsTaskNetwork(sessionId: string): Promise<void> {
    if (process.platform !== "win32") return;
    const controlRoot = windowsTaskNetworkControlRoot(this.picoHome, sessionId);
    const authority = new WindowsTaskNetworkAuthority(sessionId, controlRoot);
    managedProcessLauncher.blockWindowsNetworkTask(controlRoot);
    if (!(await authority.hasPreparationState())) {
      managedProcessLauncher.unblockWindowsNetworkTask(controlRoot);
      return;
    }
    await authority.blockNewLaunches();
    await managedProcessLauncher.terminateWindowsNetworkProcesses(controlRoot);
    await authority.revoke();
    managedProcessLauncher.unblockWindowsNetworkTask(controlRoot);
  }

  private async deleteSession(
    workspacePath: string,
    sessionId: string,
    context?: TerminalClientContext,
  ): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "删除");
    const sideChats = this.sideChatAuthority(canonical, context);
    // Recovery can remove unrelated stale side conversations. Remote requests cannot trigger it.
    if (!isRemoteTerminalContext(context)) await sideChats.recover();
    const leases = sideChats.list();
    const targets = new Set([sessionId]);
    for (const target of targets) {
      for (const lease of leases) {
        if (lease.sourceSessionId === target) targets.add(lease.targetSessionId);
      }
    }
    return this.terminalService.withSessionCleanup(canonical, [...targets], context, async () => {
      await this.revokeWindowsTaskNetwork(sessionId);
      await this.options.retireAgentGraphRootSession?.(
        canonical,
        sessionId,
        "Root Session deleted",
      );
      const childLeases = [...targets]
        .filter((target) => target !== sessionId)
        .reverse()
        .flatMap((target) => leases.filter((lease) => lease.targetSessionId === target));
      for (const lease of childLeases) {
        this.browserAgentBroker.invalidateSession(lease.targetSessionId);
        this.clientCapabilityBroker.invalidateSession(lease.targetSessionId);
        await sideChats.cleanup(lease.targetSessionId);
      }
      if (leases.some((lease) => lease.targetSessionId === sessionId)) {
        this.browserAgentBroker.invalidateSession(sessionId);
        this.clientCapabilityBroker.invalidateSession(sessionId);
        await sideChats.cleanup(sessionId);
        return { sessionId, deleted: true };
      }
      this.browserAgentBroker.invalidateSession(sessionId);
      this.clientCapabilityBroker.invalidateSession(sessionId);
      globalSessionPermissionGrants.clear(sessionId, canonical, this.picoHome);
      await globalClientCapabilityGrants.revokeSession(
        sessionId,
        resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
      );
      await this.terminalService.stopSession({ workspacePath: canonical, sessionId }, context);
      await sessionMemoryLane.run(
        this.memoryLaneKey(canonical, sessionId),
        "foreground",
        async () => {
          const managed = globalSessionManager.delete(sessionId, canonical, {
            picoHome: this.picoHome,
          });
          await managed?.close();
          await Promise.all([
            removeCliSessionFile(canonical, sessionId, { picoHome: this.picoHome }),
            this.conversationStateStore.clearQueued(canonical, sessionId),
          ]);
          this.workbarRepository(canonical).purgeOrphanArtifactBlobs();
        },
      );
      return {
        sessionId,
        deleted: true,
        ...(childLeases.length > 0
          ? { closedSessionIds: childLeases.map((lease) => lease.targetSessionId) }
          : {}),
      };
    });
  }

  private async renameSession(
    workspacePath: string,
    sessionId: string,
    title: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "重命名");
    const normalizedTitle = requireText(title, "title");
    await this.withSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session);
      const result = setSessionTitle(settings, normalizedTitle);
      if (!result.ok) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, result.message);
      }
      await session.flushPersistence();
    });
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private async forkSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "分叉");
    const sourceLease = await globalSessionManager.getOrCreatePinned(sessionId, canonical, {
      persistence: true,
      picoHome: this.picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    const targetSessionId = this.createSessionId();
    try {
      await this.getForkSourceSettings(canonical, sourceLease.session);
      await sourceLease.session.flushPersistence();
      const forkService = new SessionForkService({
        workDir: canonical,
        picoHome: this.picoHome,
        runtimePort: createSessionForkRuntimePort(),
      });
      try {
        await forkService.fork({ sourceSessionId: sessionId, targetSessionId });
      } finally {
        forkService.close();
      }
    } finally {
      sourceLease.release();
    }
    try {
      this.workbarRepository(canonical).forkSessionData(sessionId, targetSessionId);
    } catch (error) {
      await removeCliSessionFile(canonical, targetSessionId, { picoHome: this.picoHome }).catch(
        () => undefined,
      );
      throw error;
    }
    // Fork creates a new sessionId; the source session's Memory Sources and Facts
    // remain valid (source RuntimeEvents unchanged). The target session starts with
    // no Memory Sources of its own — extraction will create new Sources as the
    // target session accumulates completed turns. No lifecycle Job is needed.
    const session = await this.requireSession(canonical, targetSessionId);
    this.publishSession(session);
    this.publishTranscriptUpdate(canonical, targetSessionId, "reload");
    return { session, sourceSessionId: sessionId };
  }

  private async reviseSession(
    params: RuntimeRequest<"session.revise">["params"],
  ): Promise<JsonValue> {
    const sourceSessionId = requireText(params.sourceSessionId, "sourceSessionId");
    const canonical = await this.requireTrustedSession(params.workspacePath, sourceSessionId);
    const targetEventId = requireText(params.targetEventId, "targetEventId");
    const replacementText = requireText(params.replacementText, "replacementText");
    const idempotencyKey = `session.revise:${requireText(params.idempotencyKey, "idempotencyKey")}`;
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ canonical, sourceSessionId, targetEventId, replacementText }))
      .digest("hex");
    const stored = await this.conversationStateStore.getIdempotent(canonical, idempotencyKey);
    if (stored) {
      if (stored.requestFingerprint !== requestFingerprint) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "修订幂等键已绑定不同的请求");
      }
      return stored.result;
    }

    const existingClaim = await this.conversationStateStore.getRewindClaim(canonical, idempotencyKey);
    const operationId = `revise-${createHash("sha256").update(`${canonical}\0${idempotencyKey}`).digest("hex")}`;
    const claim = await this.conversationStateStore.claimRewind(
      canonical,
      idempotencyKey,
      sourceSessionId,
      existingClaim?.targetSessionId ?? this.createSessionId(),
      operationId,
      requestFingerprint,
    );
    if (
      claim.requestFingerprint !== requestFingerprint ||
      claim.sourceSessionId !== sourceSessionId ||
      claim.operationId !== operationId
    ) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "修订幂等键已绑定不同的请求");
    }

    const targetSessionId = claim.targetSessionId;
    const trustedPath = await this.withWorkspaceAdmission(canonical, async () => {
      const idlePath = await this.requireIdleTrustedSession(canonical, sourceSessionId, "编辑旧消息");
      const sourceLease = await globalSessionManager.getOrCreatePinned(sourceSessionId, idlePath, {
        persistence: true,
        picoHome: this.picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        await this.getForkSourceSettings(idlePath, sourceLease.session);
        await sourceLease.session.flushPersistence();
        const entries = await sourceLease.session.runtimeEventStore?.readSessionEntries(sourceSessionId);
        if (!entries) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.RESET_REQUIRED, "会话历史尚未持久化，无法编辑");
        }
        const targetIndex = entries.findIndex(
          ({ event }) => event.eventId === targetEventId &&
            event.kind === "message.committed" && event.data.message.role === "user",
        );
        if (targetIndex < 0) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "目标消息不是当前会话中的用户消息");
        }
        const previousEventId = entries[targetIndex - 1]?.event.eventId;
        if (!previousEventId) {
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "目标消息位于会话历史开头，无法安全创建修订分支");
        }
        const forkService = new SessionForkService({
          workDir: idlePath,
          picoHome: this.picoHome,
          runtimePort: createSessionForkRuntimePort(),
        });
        try {
          await forkService.fork({ sourceSessionId, targetSessionId, throughEventId: previousEventId, operationId });
        } finally {
          forkService.close();
        }
      } finally {
        sourceLease.release();
      }
      this.workbarRepository(idlePath).forkSessionData(sourceSessionId, targetSessionId);
      return idlePath;
    });
    const sent = parseRuntimeResult(
      "session.send",
      await this.sendSession({
        workspacePath: trustedPath,
        sessionId: targetSessionId,
        input: { kind: "text", text: replacementText },
        idempotencyKey: `revise-send:${createHash("sha256").update(`${idempotencyKey}\0${requestFingerprint}`).digest("hex")}`,
        behavior: "auto",
      }),
    );
    const result = {
      session: sent.session,
      sourceSessionId,
      targetEventId,
      disposition: sent.disposition,
      ...(sent.run ? { run: sent.run } : {}),
    };

    try {
      await this.conversationStateStore.rememberIdempotent(
        canonical,
        idempotencyKey,
        requestFingerprint,
        result,
      );
    } catch (error) {
      logger.warn({ error, sourceSessionId, targetSessionId }, "会话修订已启动，但幂等结果保存失败");
    }
    this.publishSession(result.session as RuntimeSession);
    this.publishTranscriptUpdate(canonical, targetSessionId, "reload");
    return result;
  }

  private async createSideChat(
    params: RuntimeRequest<"sideChat.create">["params"],
    context?: TerminalClientContext,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(
      params.workspacePath,
      params.sourceSessionId,
    );
    // A completed Run can precede the Desktop interaction facts queued by its
    // final callbacks. Freeze the fork only after those facts reach the ledger.
    await this.transcriptPersistenceTail;
    const store = new SqliteRuntimeEventStore({
      warningLogger: logger,
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
    });
    let sourceEvents;
    try {
      sourceEvents = await store.readSession(params.sourceSessionId);
    } finally {
      store.close();
    }
    const authority = this.sideChatAuthority(canonical, context);
    if (!isRemoteTerminalContext(context)) await authority.recover();
    let lease;
    try {
      lease = await authority.create({
        panelId: params.panelId,
        sourceSessionId: params.sourceSessionId,
        targetSessionId: this.createSessionId(),
        sourceEvents,
      });
    } catch (error) {
      if (error instanceof SideChatNoSettledTurnError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          "侧边对话只能从父会话最近一个成功完成的回合创建",
        );
      }
      throw error;
    }
    const session = await this.requireSession(canonical, lease.targetSessionId);
    this.publishTranscriptUpdate(canonical, lease.targetSessionId, "reload");
    return {
      session,
      sourceSessionId: params.sourceSessionId,
      throughEventId: lease.throughEventId,
    };
  }

  private async closeSideChat(
    params: RuntimeRequest<"sideChat.close">["params"],
    context?: TerminalClientContext,
  ): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(
      params.workspacePath,
    );
    const authority = this.sideChatAuthority(canonical, context);
    const leases = authority.list();
    const targets = new Set([params.sessionId]);
    for (const target of targets) {
      for (const lease of leases) {
        if (lease.sourceSessionId === target) targets.add(lease.targetSessionId);
      }
    }
    return this.terminalService.withSessionCleanup(canonical, [...targets], context, async () => {
      for (const target of [...targets].reverse()) {
        this.browserAgentBroker.invalidateSession(target);
        this.clientCapabilityBroker.invalidateSession(target);
        await authority.cleanup(target);
      }
      return { cleanupScheduled: true };
    });
  }

  private async getRuntimeSessionSettings(
    workspacePath: string,
    sessionId: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withPinnedSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session, { persist: false });
      const router = await this.getSessionModelRouter(canonical, settings.modelRouteId);
      return { settings: runtimeSessionSettings(settings, router) };
    });
  }

  private async updateRuntimeSessionSettings(params: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly modelRouteId?: string;
    readonly collaborationMode?: string;
    readonly orchestrationMode?: string;
    readonly permissionMode?: string;
    readonly thinkingEffort?: string;
  }): Promise<JsonValue> {
    validateRequestedSessionSettings(params);
    const requestedCollaborationMode = params.collaborationMode;
    const requestedPermissionMode = params.permissionMode;
    const requestedOrchestrationMode = params.orchestrationMode;

    const canonical = await this.requireIdleTrustedSession(
      params.workspacePath,
      params.sessionId,
      "修改会话设置",
    );
    const settings = await this.withSession(canonical, params.sessionId, async (session) => {
      const current = await this.getSessionSettings(canonical, session);
      if (
        (requestedCollaborationMode ?? current.collaborationMode) === "research" &&
        (requestedOrchestrationMode ?? current.orchestrationMode) !== "default"
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "研究模式只支持只读线性研究，请先关闭 Graph/Swarm。",
        );
      }
      const permissionModeChanging =
        requestedPermissionMode !== undefined && requestedPermissionMode !== current.permissionMode;
      // A new authority epoch must not inherit process-local approvals from an
      // earlier one. In particular, a network grant from before Full Access
      // must not reappear when the durable boundary becomes managed again.
      const revokeSessionGrants =
        (permissionModeChanging &&
          (current.permissionMode === "full-access" ||
            requestedPermissionMode === "full-access" ||
            (current.permissionMode === "auto" && requestedPermissionMode === "ask"))) ||
        (requestedCollaborationMode !== undefined &&
          requestedCollaborationMode !== current.collaborationMode &&
          requestedCollaborationMode !== "agent");
      const orchestrationModeChanging =
        requestedOrchestrationMode !== undefined &&
        requestedOrchestrationMode !== current.orchestrationMode &&
        current.orchestrationMode !== "default";
      if (permissionModeChanging || orchestrationModeChanging) {
        const graphStore = new SqliteAgentGraphControlStore({
          storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
          now: this.now,
        });
        try {
          const openGraph = graphStore.getOpenRootEpoch(params.sessionId);
          if (permissionModeChanging) {
            const hasOperatorAuthority = graphStore
              .listGraphs()
              .some((graph) =>
                graphStore
                  .listOperatorProvisions(graph.graphId)
                  .some(
                    (provision) =>
                      provision.state !== "stopped" &&
                      (graph.rootSessionId === params.sessionId ||
                        provision.childSessionId === params.sessionId),
                  ),
              );
            if (openGraph || hasOperatorAuthority) {
              throw new RuntimeProtocolError(
                RUNTIME_ERROR_CODES.CONFLICT,
                "当前 Graph 周期或 Operator 权限仍未结束，请先结束 Graph 调度后再切换权限模式",
              );
            }
          }
          if (orchestrationModeChanging && openGraph) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.CONFLICT,
              "当前 Graph 周期仍未结束，请先让根 Agent 完成调度后再切换为线性模式",
            );
          }
        } finally {
          graphStore.close();
        }
      }
      if (
        requestedCollaborationMode !== undefined &&
        requestedCollaborationMode !== "plan" &&
        current.collaborationMode === "plan" &&
        session.runtimeEventStore
      ) {
        const projection = await new PlanCoordinator(session.runtimeEventStore, {
          sessionId: params.sessionId,
          invocationId: "desktop:settings",
          runId: "desktop:settings",
          turnId: "desktop:settings",
        }).project();
        if (projection.pendingProposal) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            "当前计划仍待审批，请先确认“拒绝并退出”以记录放弃事实",
          );
        }
      }
      const router = await this.getSessionModelRouter(
        canonical,
        params.modelRouteId ?? current.modelRouteId,
      );
      const selectedRoute = resolveRequestedModelRoute(router, params.modelRouteId);
      if (params.thinkingEffort !== undefined) {
        validateRequestedThinkingEffort(
          selectedRoute ?? resolveCurrentModelRoute(router, current),
          params.thinkingEffort,
        );
      }

      if (revokeSessionGrants) await this.revokeWindowsTaskNetwork(params.sessionId);

      if (selectedRoute) migrateSessionModelRoute(current, selectedRoute);
      if (requestedCollaborationMode) {
        const result = setSessionCollaborationMode(current, requestedCollaborationMode);
        if (!result.ok) throw invalidSessionSetting(result.message);
      }
      if (requestedOrchestrationMode) {
        const result = setSessionOrchestrationMode(
          current,
          requestedOrchestrationMode as "default" | "graph" | "swarm",
        );
        if (!result.ok) throw invalidSessionSetting(result.message);
      }
      if (requestedPermissionMode) {
        const result = setSessionPermissionMode(current, requestedPermissionMode);
        if (!result.ok) throw invalidSessionSetting(result.message);
      }
      if (params.thinkingEffort !== undefined) {
        const result = setSessionThinkingEffort(current, params.thinkingEffort, router);
        if (!result.ok) throw invalidSessionSetting(result.message);
      }
      await session.flushPersistence();
      if (revokeSessionGrants) {
        globalSessionPermissionGrants.clear(params.sessionId, canonical, this.picoHome);
        await globalClientCapabilityGrants.revokeSession(
          params.sessionId,
          resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
        );
      }
      return runtimeSessionSettings(current, router);
    });
    if (requestedPermissionMode || requestedCollaborationMode) {
      this.clientCapabilityBroker.invalidateSession(params.sessionId, "任务权限模式已变化");
    }
    this.publish(
      createRuntimeNotification({
        topic: "session.settingsUpdated",
        scope: { workspacePath: canonical, sessionId: params.sessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { sessionId: params.sessionId, settings },
      }),
    );
    return { settings };
  }

  private async addSessionDirectory(
    workspacePath: string,
    sessionId: string,
    path: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    // 校验与规范化对齐旧 in-process AdditionalDirectoryManager：绝对化 →
    // 存在且为目录 → realpath 归一。
    const absolute = resolve(path);
    let real: string;
    try {
      const stats = await stat(absolute);
      if (!stats.isDirectory()) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          `目录不存在或不是文件夹: ${path}`,
        );
      }
      real = await realpath(absolute);
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `目录不可访问: ${path}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const result = await this.withSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session);
      const before = settings.additionalDirectories.length;
      const directories = addSessionAdditionalDirectory(settings, real);
      await session.flushPersistence();
      return { directories, added: directories.length > before };
    });
    return toJsonValue(result);
  }

  private async getSessionContextReport(
    workspacePath: string,
    sessionId: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withSession(canonical, sessionId, async (session) => {
      const settings = session.getRuntimeStateSnapshot().settings;
      if (!settings)
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.RESET_REQUIRED,
          `Session ${sessionId} 缺少当前版本 settings，请新建 Session`,
        );
      const runtime = await this.loadSessionModelRuntime(canonical, settings.modelRouteId);
      const route = runtime.router.require(settings.modelRouteId);
      const store = session.runtimeEventStore;
      if (!store) throw new Error("上下文历史缺少持久化事件源");
      // No run, prompt assembly, tool discovery or provider request is created for inspection.
      const history = await readRuntimeModelHistorySnapshot(store, sessionId);
      const latestRequest = getLatestContextRequest(
        resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
        sessionId,
      );
      return toJsonValue({
        context: {
          version: 3,
          sessionId,
          generatedAt: this.now(),
          selectedRoute: {
            routeId: route.id,
            providerId: route.provider,
            modelId: route.model,
            connectionId: route.providerId,
            contextWindow: route.capabilities.contextWindowTokens,
            ...(route.capabilities.contextSource === "config"
              ? { declaredContextWindow: route.capabilities.contextWindowTokens }
              : {}),
          },
          latestRequest,
          ...(readLastRequestAnchor(session.getHistory())
            ? { lastRequestAnchor: readLastRequestAnchor(session.getHistory()) }
            : {}),
          modelHistory: {
            throughSequence: history.throughSequence,
            messageCount: history.messages.length,
            estimatedTokens: estimateMessagesTokens(history.messages),
            estimationAlgorithm: "chars_v1",
            projection: "effective_model_history",
            compactedCount: history.compactedCount,
            ...(history.latestCompaction ? { latestCompaction: history.latestCompaction } : {}),
          },
        },
      });
    });
  }

  private async querySessionTasks(
    params: RuntimeRequest<"session.tasks.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    return this.withWorkbarErrors(() =>
      toJsonValue(
        this.workbarRepository(canonical).queryTasks({
          sessionId: params.sessionId,
          ...(params.taskId ? { taskId: params.taskId } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.revision !== undefined ? { revision: params.revision } : {}),
        }),
      ),
    );
  }

  private async commandSessionTasks(
    params: RuntimeRequest<"session.tasks.command">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const result = this.withWorkbarErrors(() => {
      const repository = this.workbarRepository(canonical);
      if (params.action === "create") {
        if (!params.title || params.detail === null) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "task create 需要 title，detail 不能为 null",
          );
        }
        return repository.createTask({
          sessionId: params.sessionId,
          title: params.title,
          ...(params.detail ? { detail: params.detail } : {}),
          expectedRevision: params.expectedRevision,
          idempotencyKey: params.idempotencyKey,
          ...(params.taskId ? { taskId: params.taskId } : {}),
        });
      }
      if (
        !params.taskId ||
        (params.title === undefined && params.detail === undefined && params.status === undefined)
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          "task update 需要 taskId 和至少一个更新字段",
        );
      }
      return repository.updateTask({
        sessionId: params.sessionId,
        taskId: params.taskId,
        expectedRevision: params.expectedRevision,
        idempotencyKey: params.idempotencyKey,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.detail !== undefined ? { detail: params.detail } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      });
    });
    this.publishWorkbarResource(canonical, params.sessionId, "tasks", {
      revision: result.revision,
    });
    return toJsonValue(result);
  }

  private async querySessionResearch(
    params: RuntimeRequest<"session.research.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const store = new SqliteDeepResearchStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
    });
    const run = store.read(params.sessionId);
    return toJsonValue({ run: run ? projectDeepResearchProgress(run) : null });
  }

  private async querySessionArtifacts(
    params: RuntimeRequest<"session.artifacts.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    return this.withWorkbarErrors(() => {
      const repository = this.workbarRepository(canonical);
      if (params.action === "read_chunk") {
        if (!params.artifactId) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "read_chunk 需要 artifactId",
          );
        }
        return toJsonValue(
          repository.readArtifactChunk({
            sessionId: params.sessionId,
            artifactId: params.artifactId,
            ...(params.offsetBytes !== undefined ? { offsetBytes: params.offsetBytes } : {}),
            ...(params.limitBytes !== undefined ? { limitBytes: params.limitBytes } : {}),
          }),
        );
      }
      if (params.action === "get" && !params.artifactId) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          "artifact get 需要 artifactId",
        );
      }
      return toJsonValue(
        repository.queryArtifacts({
          sessionId: params.sessionId,
          ...(params.artifactId ? { artifactId: params.artifactId } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.revision !== undefined ? { revision: params.revision } : {}),
        }),
      );
    });
  }

  private async commandSessionArtifacts(
    params: RuntimeRequest<"session.artifacts.command">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const repository = this.workbarRepository(canonical);
    const requiredRevision = (): number => {
      if (params.expectedRevision === undefined) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          `${params.action} 需要 expectedRevision`,
        );
      }
      return params.expectedRevision;
    };
    const requiredKey = (): string => {
      if (!params.idempotencyKey) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          `${params.action} 需要 idempotencyKey`,
        );
      }
      return params.idempotencyKey;
    };
    const result = this.withWorkbarErrors(() => {
      switch (params.action) {
        case "begin":
          if (!params.title || !params.mimeType) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "begin 需要 title 和 mimeType",
            );
          }
          return repository.beginArtifact({
            sessionId: params.sessionId,
            title: params.title,
            mimeType: params.mimeType,
            expectedRevision: requiredRevision(),
            idempotencyKey: requiredKey(),
            ...(params.artifactId ? { artifactId: params.artifactId } : {}),
          });
        case "append":
          if (!params.ingestId || params.offsetBytes === undefined || !params.contentBase64) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "append 需要 ingestId、offsetBytes 和 contentBase64",
            );
          }
          return repository.appendArtifactChunk({
            sessionId: params.sessionId,
            ingestId: params.ingestId,
            offsetBytes: params.offsetBytes,
            content: decodeCanonicalBase64(params.contentBase64),
          });
        case "commit":
          if (!params.ingestId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "commit 需要 ingestId",
            );
          }
          return repository.commitArtifact({
            sessionId: params.sessionId,
            ingestId: params.ingestId,
            expectedRevision: requiredRevision(),
            idempotencyKey: requiredKey(),
            ...(params.expectedDigest ? { expectedDigest: params.expectedDigest } : {}),
            ...(params.expectedSizeBytes !== undefined
              ? { expectedSizeBytes: params.expectedSizeBytes }
              : {}),
          });
        case "abort":
          if (!params.ingestId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "abort 需要 ingestId",
            );
          }
          return repository.abortArtifact({
            sessionId: params.sessionId,
            ingestId: params.ingestId,
          });
        case "delete":
          if (!params.artifactId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "delete 需要 artifactId",
            );
          }
          return repository.deleteArtifact({
            sessionId: params.sessionId,
            artifactId: params.artifactId,
            expectedRevision: requiredRevision(),
            idempotencyKey: requiredKey(),
          });
      }
    });
    if ("revision" in result) {
      this.publishWorkbarResource(
        canonical,
        params.sessionId,
        "artifacts",
        typeof result.revision === "number" ? { revision: result.revision } : {},
      );
    }
    return toJsonValue(result);
  }

  private async querySessionExecutionSummary(
    params: RuntimeRequest<"session.execution.summary">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const storageRoot = resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root;
    return this.withWorkbarErrors(() =>
      toJsonValue(querySessionExecutionSummary(storageRoot, { sessionId: params.sessionId })),
    );
  }

  private async querySessionExecution(
    params: RuntimeRequest<"session.execution.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const storageRoot = resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root;
    return this.withWorkbarErrors(() =>
      toJsonValue(
        querySessionExecution(storageRoot, {
          sessionId: params.sessionId,
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.runId === undefined ? {} : { runId: params.runId }),
        }),
      ),
    );
  }

  private async querySessionTrace(
    params: RuntimeRequest<"session.trace.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    return this.withWorkbarErrors(() =>
      toJsonValue(
        this.workbarRepository(canonical).queryTrace({
          sessionId: params.sessionId,
          ...(params.throughSequence !== undefined
            ? { throughSequence: params.throughSequence }
            : {}),
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }),
      ),
    );
  }

  private async querySessionGraph(
    params: RuntimeRequest<"session.graph.query">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const storageRoot = resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root;
    const store = new SqliteAgentGraphControlStore({
      storageRoot,
      now: this.now,
    });
    const runtimeStore = new SqliteRuntimeEventStore({ warningLogger: logger, storageRoot });
    try {
      const query = new AgentGraphReadOnlyQueryService(store);
      const result = query.query({
        rootSessionId: params.sessionId,
        action: params.action,
        ...(params.graphId === undefined ? {} : { graphId: params.graphId }),
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      });
      if (params.action !== "get" || !params.graphId) return toJsonValue(result);
      return toJsonValue({
        ...requireJsonRecord(result, "Graph detail"),
        ...(await query.queryRuntimeFacts(
          params.graphId,
          createSqliteAgentGraphRuntimeEventQueryPort(runtimeStore),
          {
            inspect: async ({ sessionId, runId }) =>
              agentGraphLaunchStateFromWorkspaceRun(
                await this.options.runtimeService.peekWorkspaceRun(canonical, runId),
                sessionId,
              ),
          },
        )),
      });
    } catch (error) {
      throw new RuntimeProtocolError(
        error instanceof Error && /does not belong/u.test(error.message)
          ? RUNTIME_ERROR_CODES.NOT_FOUND
          : RUNTIME_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      runtimeStore.close();
      store.close();
    }
  }

  private async stopSessionGraph(
    params: RuntimeRequest<"session.graph.stop">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const store = new SqliteAgentGraphControlStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
      now: this.now,
    });
    let graph;
    try {
      graph = store.getGraph(params.graphId);
      if (!graph || graph.rootSessionId !== params.sessionId) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "Graph 不属于当前任务");
      }
    } finally {
      store.close();
    }
    if (!this.options.stopAgentGraph) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Graph 停止服务尚未就绪");
    }
    await this.options.runtimeService.getWorkspaceRuntime(canonical);
    return {
      stopped: await this.options.stopAgentGraph(canonical, params.sessionId, {
        graphId: graph.graphId,
        epoch: graph.epoch,
      }),
    };
  }

  private async retrySessionGraphWake(
    params: RuntimeRequest<"session.graph.retryWake">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const storageRoot = resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root;
    const store = new SqliteAgentGraphControlStore({ storageRoot, now: this.now });
    try {
      const graph = store.getGraph(params.graphId);
      const wake = store.getSupervisorWake(params.wakeId);
      if (
        !graph ||
        graph.rootSessionId !== params.sessionId ||
        !wake ||
        wake.graphId !== graph.graphId
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.NOT_FOUND,
          "Graph 或根唤醒不存在，或不属于当前 Session",
        );
      }
      if (graph.phase !== "open") {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "Graph 已完成，不能重试根唤醒",
        );
      }
    } finally {
      store.close();
    }
    await this.options.runtimeService.getWorkspaceRuntime(canonical);
    const application =
      await this.options.runtimeService.getWorkspaceAgentGraphApplicationService(canonical);
    if (!application) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        "Graph Supervisor 尚未就绪，无法重试根唤醒",
      );
    }
    return toJsonValue({ retried: await application.retryRootWake(params.wakeId) });
  }

  private async withGoalSession<T>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session, manager: GoalManager) => Promise<T>,
  ): Promise<T> {
    return this.withPinnedSession(workspacePath, sessionId, async (session) => {
      const manager = session.getGoalManager();
      this.goalCoordinator.observe(workspacePath, sessionId, manager);
      return operation(session, manager);
    });
  }

  private async getGoal(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withGoalSession(canonical, sessionId, async (session, manager) => {
      await session.flushPersistence();
      return { goal: toJsonValue(manager.snapshot()) };
    });
  }

  private async controlGoal(params: RuntimeRequest<"goal.control">["params"]): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const snapshot = await this.withSessionAdmission(canonical, params.sessionId, () =>
      this.withGoalSession(canonical, params.sessionId, async (session, manager) => {
        const current = manager.getCurrent();
        if (
          (current?.revision ?? 0) !== params.expectedRevision ||
          (params.action !== "arm" && params.goalId !== current?.id)
        )
          throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Goal 已变化，请刷新后重试");
        try {
          if (params.action === "arm") {
            manager.create(
              {
                condition: params.condition!,
                awaitingUserTurn: true,
                ...(params.maxIterations === undefined
                  ? {}
                  : { maxIterations: params.maxIterations }),
                ...(params.blockCap === undefined ? {} : { blockCap: params.blockCap }),
                ...(params.tokenBudget === undefined ? {} : { tokenBudget: params.tokenBudget }),
              },
              params.expectedRevision,
            );
          } else {
            const accepted =
              params.action === "pause"
                ? manager.pause(current!.id, "用户暂停了 Goal", params.expectedRevision)
                : params.action === "resume"
                  ? manager.resume(current!.id, params.expectedRevision)
                  : manager.clear(current!.id, params.expectedRevision);
            if (!accepted)
              throw new RuntimeProtocolError(
                RUNTIME_ERROR_CODES.CONFLICT,
                "当前 Goal 状态不支持该操作",
              );
          }
        } catch (error) {
          if (error instanceof RuntimeProtocolError) throw error;
          throw new RuntimeProtocolError(
            current &&
              ![
                "achieved",
                "impossible",
                "stalled",
                "budget_limited",
                "max_iterations",
                "cleared",
              ].includes(current.status)
              ? RUNTIME_ERROR_CODES.CONFLICT
              : RUNTIME_ERROR_CODES.INVALID_PARAMS,
            errorMessage(error),
          );
        }
        await session.flushPersistence();
        return manager.snapshot();
      }),
    );
    if (params.action === "resume") this.goalCoordinator.wakeWorkspace(canonical);
    return { goal: toJsonValue(snapshot) };
  }

  private publishGoalChanged(
    workspacePath: string,
    sessionId: string,
    goal: GoalState | null,
  ): void {
    this.publishWorkbarResource(workspacePath, sessionId, "goal", {
      revision: goal?.revision ?? 0,
    });
    if (!goal || ["active", "waiting", "paused"].includes(goal.status)) return;
    const terminal = structuredClone(goal);
    this.transcriptPersistenceTail = this.transcriptPersistenceTail
      .then(async () => {
        await this.withPinnedSession(workspacePath, sessionId, async (session) => {
          const eventId = `goal-terminal:${terminal.id}:${terminal.revision}`;
          await session.recordTranscriptEvent(
            {
              eventId,
              entryId: eventId,
              sequence: 1,
              createdAt: terminal.lastEvaluation?.at ?? terminal.achievedAt ?? terminal.createdAt,
              type: "entry.appended",
              entry: {
                kind: "goal",
                title: terminal.condition,
                state: terminal.status,
                ...(terminal.lastReason ? { detail: terminal.lastReason } : {}),
                data: {
                  goalId: terminal.id,
                  goalRevision: terminal.revision,
                  iterations: terminal.iterations,
                  maxIterations: terminal.maxIterations,
                  tokensUsed: Math.max(0, terminal.tokensNow - terminal.tokensAtStart),
                  ...(terminal.tokenBudget === undefined
                    ? {}
                    : { tokenBudget: terminal.tokenBudget }),
                },
              },
            },
            { eventId },
          );
        });
        this.publishTranscriptUpdate(workspacePath, sessionId, "reload");
      })
      .catch((error: unknown) => this.publishConversationFailure(workspacePath, error));
  }

  private async evaluateGoalForSession(
    workspacePath: string,
    session: Session,
    goal: GoalState,
    execution: GoalExecutionRef,
    messages: readonly Message[],
    signal: AbortSignal,
  ) {
    const settings = await this.getSessionSettings(workspacePath, session);
    const effective = await this.loadSessionModelRuntime(workspacePath, settings.modelRouteId);
    const active = effective.router.providerConfig(settings.modelRouteId);
    active.config.sessionId = session.id;
    const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(workspacePath);
    const activation = new PluginCapabilityActivationScope();
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
      now: this.now,
    });
    let dispatched = false;
    const cleanup = async () => {
      ledger.close();
      await activation.dispose();
    };
    try {
      signal.throwIfAborted();
      const raw = activatePluginProviderCapabilities(
        pluginSnapshot,
        this.pluginRuntimeSnapshotRegistry.capabilityRegistry,
        this.providerFactory(active.provider, active.config),
        activation,
      );
      const tracker = new CostTracker(
        raw,
        { provider: active.provider, model: active.config.model, baseUrl: active.config.baseURL },
        undefined,
        {
          ledger,
          recordRuntimeEvents: false,
          contextFacts: requestContextForProvider(active.provider, active.config),
          context: {
            purpose: "goal_evaluation",
            sessionId: session.id,
            conversationId: session.conversationId,
            goalId: goal.id,
            runId: execution.runId,
            turnId: execution.turnId,
            workspacePath,
          },
          onAccountingChanged: (_record, revision) =>
            this.publishWorkbarResource(workspacePath, session.id, "trace", { revision }),
        },
      );
      const provider: LLMProvider = {
        generate: (input, tools, options) => {
          dispatched = true;
          const physical = tracker.generate(input, tools, options);
          const tracked = physical.finally(cleanup);
          this.goalEvaluationCalls.add(tracked);
          void tracked.then(
            () => this.goalEvaluationCalls.delete(tracked),
            () => this.goalEvaluationCalls.delete(tracked),
          );
          return tracked;
        },
      };
      return await evaluateGoal(provider, goal.condition, messages, { signal });
    } finally {
      if (!dispatched) await cleanup();
    }
  }

  private async compactSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "压缩");
    const result = await this.withSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session);
      const effective = await this.loadSessionModelRuntime(canonical, settings.modelRouteId);
      const active = effective.router.providerConfig(settings.modelRouteId);
      active.config.sessionId = session.id;
      const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(canonical);
      const pluginActivationScope = new PluginCapabilityActivationScope();
      let ledger: SqliteRuntimeControlStore | undefined;
      let compactResult:
        | { readonly beforeMessageCount: number; readonly afterMessageCount: number }
        | undefined;
      let operationError: unknown;
      try {
        const rawProvider = activatePluginProviderCapabilities(
          pluginSnapshot,
          this.pluginRuntimeSnapshotRegistry.capabilityRegistry,
          this.providerFactory(active.provider, active.config),
          pluginActivationScope,
        );
        ledger = new SqliteRuntimeControlStore({
          storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
          now: this.now,
        });
        const runtimeCapability = session.runtimeEventCapability;
        if (!runtimeCapability) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            "当前会话没有 durable RuntimeEvent store，无法压缩",
          );
        }
        await RuntimeRun.reconcileIncompleteRuns({
          capability: runtimeCapability,
        });
        await RuntimeRun.repairSessionProjection(session, {
          capability: runtimeCapability,
        });
        const provider = new CostTracker(
          rawProvider,
          {
            provider: active.provider,
            model: active.config.model,
            baseUrl: active.config.baseURL,
          },
          session,
          {
            ledger,
            contextFacts: requestContextForProvider(active.provider, active.config),
            context: {
              purpose: "compaction",
              sessionId: session.id,
              conversationId: session.conversationId,
            },
          },
        );
        const profile = resolveProviderProfile(active.provider, active.config.model);
        const budget = createContextBudget(profile);
        const runtimeRun = await RuntimeRun.start({
          capability: runtimeCapability,
          agentSwarmAuthorization: "none",
        });
        const checkpoint = await runtimeRun.run(async () => {
          const result = await recordRuntimeCompactionCheckpoint({
            logger,
            session,
            runtimeRun,
            compactor: new FullCompactor({ provider, logger }),
            request: {
              inputBudgetTokens: budget.inputBudgetTokens,
              phase: "standalone",
              targetRetainedTokens: 0,
              trigger: "manual",
            },
          });
          if (!result) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.CONFLICT,
              "当前会话没有可安全压缩的历史边界，或摘要模型未返回有效结果",
            );
          }
          return result;
        });
        compactResult = {
          beforeMessageCount: checkpoint.beforeMessageCount,
          afterMessageCount: checkpoint.afterMessageCount,
        };
      } catch (error) {
        operationError = error;
      }
      const cleanupFailures: unknown[] = [];
      try {
        ledger?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await pluginActivationScope.dispose();
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (operationError !== undefined && cleanupFailures.length > 0) {
        throw new AggregateError(
          [operationError, ...cleanupFailures],
          "Desktop compaction and cleanup failed",
          { cause: operationError },
        );
      }
      if (operationError !== undefined) throw operationError;
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "Desktop compaction cleanup failed");
      }
      if (!compactResult) throw new Error("Desktop compaction completed without a result");
      return compactResult;
    });
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    this.publishTranscriptUpdate(canonical, sessionId, "truncate");
    return { session, compacted: true, ...result };
  }

  private async sendSession(params: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly input: RuntimeUserInput;
    readonly initialSettings?: RuntimeUserDefaults;
    readonly behavior?: "auto" | "steer" | "queue" | "replace";
    readonly expectedRunId?: string;
    readonly idempotencyKey: string;
    readonly replayOnly?: true;
  }): Promise<JsonValue> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(
      params.workspacePath,
    );
    const input = normalizeRuntimeUserInput(params.input);
    const idempotencyKey = requireText(params.idempotencyKey, "idempotencyKey");
    const requestFingerprint = firstSendRequestFingerprint({ ...params, input });
    const stored = await this.conversationStateStore.getIdempotent(canonical, idempotencyKey);
    if (stored) {
      if (stored.requestFingerprint !== requestFingerprint) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `idempotencyKey ${idempotencyKey} 已绑定不同的发送请求`,
        );
      }
      return stored.result;
    }

    const pendingKey = `${canonical}\0${idempotencyKey}`;
    const pending = this.pendingSends.get(pendingKey);
    if (pending) {
      if (pending.requestFingerprint !== requestFingerprint) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `idempotencyKey ${idempotencyKey} 正在处理不同的发送请求`,
        );
      }
      return pending.promise;
    }
    if (params.replayOnly) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.SEND_RECOVERY_UNAVAILABLE,
        "发送结果已不可恢复，请刷新会话状态后决定是否重新发送",
      );
    }
    const operation = this.withWorkspaceAdmission(canonical, () =>
      this.sendSessionOnce({ ...params, workspacePath: canonical, input }),
    )
      .then(async (result) => {
        await this.conversationStateStore.rememberIdempotent(
          canonical,
          idempotencyKey,
          requestFingerprint,
          result,
        );
        return result;
      })
      .finally(() => this.pendingSends.delete(pendingKey));
    this.pendingSends.set(pendingKey, { requestFingerprint, promise: operation });
    return operation;
  }

  private async sendSessionOnce(params: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly input: RuntimeUserInput;
    readonly initialSettings?: RuntimeUserDefaults;
    readonly behavior?: "auto" | "steer" | "queue" | "replace";
    readonly expectedRunId?: string;
    readonly idempotencyKey: string;
  }): Promise<JsonObject> {
    const behavior = params.behavior ?? "auto";
    if (params.sessionId && params.initialSettings) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "initialSettings 只允许用于首次发送创建 Session",
      );
    }
    // Resolve a first-message activation before creating durable session metadata. Invalid
    // catalog selections must not leave behind an empty session.
    const initialResolution = params.sessionId
      ? undefined
      : await this.resolveRuntimeUserInput(params.workspacePath, params.input);
    const existingFirstSendClaim = await this.conversationStateStore.getFirstSendClaim(
      params.workspacePath,
      params.idempotencyKey,
    );
    const firstSendFingerprint = firstSendRequestFingerprint(params);
    if (
      existingFirstSendClaim &&
      params.sessionId &&
      existingFirstSendClaim.sessionId !== params.sessionId
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `idempotencyKey ${params.idempotencyKey} 已绑定 Session ${existingFirstSendClaim.sessionId}`,
      );
    }
    if (
      existingFirstSendClaim &&
      existingFirstSendClaim.requestFingerprint !== firstSendFingerprint
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `idempotencyKey ${params.idempotencyKey} 已绑定不同的首次发送请求`,
      );
    }
    let firstSendClaim = params.sessionId ? undefined : existingFirstSendClaim;
    if (!params.sessionId) {
      const activeWorkspaceRun = await this.findActiveWorkspaceRun(params.workspacePath);
      if (activeWorkspaceRun) {
        if (firstSendClaim && activeWorkspaceRun["sessionId"] === firstSendClaim.sessionId) {
          return {
            session: requireJsonRecord(
              await this.requireSession(params.workspacePath, firstSendClaim.sessionId),
              "session",
            ),
            run: activeWorkspaceRun,
            disposition: "started",
          };
        }
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `当前工作区已有活动 Run ${String(activeWorkspaceRun["runId"])}，未创建空 Session`,
        );
      }
      if (!firstSendClaim) {
        // Reject invalid initial settings before claiming an ID or persisting an empty
        // session. Explicit values remain strict; inherited defaults are reconciled below.
        if (params.initialSettings) {
          validateRequestedSessionSettings(params.initialSettings);
          const runtime = await this.loadSessionModelRuntime(
            params.workspacePath,
            params.initialSettings.modelRouteId,
          );
          const route =
            resolveRequestedModelRoute(runtime.router, params.initialSettings.modelRouteId) ??
            runtime.router.require(runtime.config.defaultModelRouteId);
          if (params.initialSettings.thinkingEffort !== undefined) {
            validateRequestedThinkingEffort(route, params.initialSettings.thinkingEffort);
          }
        }
        firstSendClaim = await this.conversationStateStore.claimFirstSend(
          params.workspacePath,
          params.idempotencyKey,
          this.createSessionId(),
          firstSendFingerprint,
        );
        if (firstSendClaim.requestFingerprint !== firstSendFingerprint) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            `idempotencyKey ${params.idempotencyKey} 已绑定不同的首次发送请求`,
          );
        }
      }
    }
    let session: JsonValue;
    if (params.sessionId) {
      session = await this.requireSession(params.workspacePath, params.sessionId);
    } else {
      if (!firstSendClaim) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INTERNAL_ERROR,
          "首次发送未能建立可恢复的 Session 关联",
        );
      }
      session = await this.ensureSessionForMessage(
        params.workspacePath,
        runtimeInputTitle(params.input),
        firstSendClaim.sessionId,
        params.initialSettings?.modelRouteId,
      );
    }
    const sessionRecord = requireJsonRecord(session, "session");
    const sessionId = requireText(sessionRecord["sessionId"], "session.sessionId");
    return this.withSessionAdmission(params.workspacePath, sessionId, async () => {
      const activeRun = await this.findActiveSessionRun(params.workspacePath, sessionId);

      if (!params.sessionId && params.initialSettings && !activeRun) {
        await this.updateRuntimeSessionSettings({
          workspacePath: params.workspacePath,
          sessionId,
          ...params.initialSettings,
        });
      }

      const admittedSettings = await this.getRuntimeSessionSettings(
        params.workspacePath,
        sessionId,
      );
      const collaboration = (admittedSettings as { settings?: { collaborationMode?: string } })
        .settings?.collaborationMode;
      if (
        collaboration === "research" &&
        (isRuntimeActivation(params.input) ||
          (params.input.kind === "text" && params.input.orchestrationMode))
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "研究模式不能激活 Skill、子代理或 Graph/Swarm；请使用普通研究消息。",
        );
      }
      if (params.expectedRunId !== undefined && activeRun?.["runId"] !== params.expectedRunId) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `当前活动 Run 已变化，期望 ${params.expectedRunId}，实际 ${String(activeRun?.["runId"] ?? "none")}`,
        );
      }

      const activation = isRuntimeActivation(params.input);
      const resolution =
        initialResolution ??
        (activation
          ? await this.resolveRuntimeUserInput(params.workspacePath, params.input)
          : undefined);
      const admittedInput = resolution?.input ?? params.input;
      if (activeRun) {
        const runId = requireText(activeRun["runId"], "run.runId");
        if (activation && behavior === "steer") {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            "Agent/Skill 激活必须在新 Run 中应用；请选择 Queue 或 Replace",
          );
        }
        if (behavior === "queue" || behavior === "replace" || activation) {
          await this.conversationStateStore.enqueue(params.workspacePath, sessionId, admittedInput);
          const run =
            behavior === "replace"
              ? await this.options.runtimeService.handle(
                  createRuntimeRequest("run.cancel", {
                    workspacePath: params.workspacePath,
                    runId,
                    reason: "replaced by a newer user message",
                  }),
                )
              : activeRun;
          return {
            session: sessionRecord,
            run: requireJsonRecord(run, "run"),
            disposition: behavior === "replace" ? "replaced" : "queued",
          };
        }
        if (params.input.kind !== "text") {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "无法 Steer 非文本输入",
          );
        }
        const run = await this.options.runtimeService.handle(
          createRuntimeRequest("run.steer", {
            workspacePath: params.workspacePath,
            runId,
            message: params.input.text,
          }),
        );
        return {
          session: sessionRecord,
          run: requireJsonRecord(run, "run"),
          disposition: "steered",
        };
      }

      if (
        this.goalCoordinator.isSettling(params.workspacePath, sessionId) ||
        (await this.findActiveWorkspaceRun(params.workspacePath))
      ) {
        await this.conversationStateStore.enqueue(params.workspacePath, sessionId, admittedInput);
        return { session: sessionRecord, disposition: "queued" };
      }

      if (behavior === "steer" && params.expectedRunId !== undefined) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "目标 Run 已结束，无法继续 Steer；请作为下一轮发送",
        );
      }
      const run = await this.startSessionRun(
        params.workspacePath,
        sessionId,
        admittedInput,
        resolution,
        {
          inputKey: params.idempotencyKey,
          runStartKey: desktopRunStartIdempotencyKey("send", params.idempotencyKey),
        },
      );
      return { session: sessionRecord, run, disposition: "started" };
    });
  }

  private async cancelRun(
    workspacePath: string,
    runId: string,
    reason?: string,
  ): Promise<JsonValue> {
    const result = requireJsonRecord(
      await this.options.runtimeService.handle(
        createRuntimeRequest("run.cancel", {
          workspacePath,
          runId,
          ...(reason ? { reason } : {}),
        }),
      ),
      "run.cancel result",
    );
    const sessionId = typeof result["sessionId"] === "string" ? result["sessionId"] : undefined;
    if (sessionId) {
      const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
      await this.conversationStateStore.clearQueued(canonical, sessionId);
    }
    return result;
  }

  private async ensureSessionForMessage(
    workspacePath: string,
    message: string,
    sessionId: string,
    modelRouteId?: string,
  ): Promise<JsonValue> {
    try {
      return await this.requireSession(workspacePath, sessionId);
    } catch (error) {
      if (
        !(error instanceof RuntimeProtocolError) ||
        error.code !== RUNTIME_ERROR_CODES.NOT_FOUND
      ) {
        throw error;
      }
    }
    const title = message.replace(/\s+/gu, " ").trim().slice(0, 80);
    const created = requireJsonRecord(
      await this.createSession(workspacePath, title, sessionId, modelRouteId),
      "session.create result",
    );
    return requireJsonRecord(created["session"], "session.create session");
  }

  private async findActiveSessionRun(
    workspacePath: string,
    sessionId: string,
  ): Promise<JsonObject | undefined> {
    const value = requireJsonRecord(
      await this.options.runtimeService.handle(
        createRuntimeRequest("runs.list", { workspacePath, sessionId }),
      ),
      "runs.list result",
    );
    const runs = Array.isArray(value["runs"]) ? value["runs"] : [];
    return runs
      .filter(isJsonRecord)
      .find((run) => !isTerminalRunStatus(String(run["status"] ?? "")));
  }

  private async findActiveWorkspaceRun(workspacePath: string): Promise<JsonObject | undefined> {
    const value = requireJsonRecord(
      await this.options.runtimeService.handle(
        createRuntimeRequest("runs.list", { workspacePath }),
      ),
      "runs.list result",
    );
    const runs = Array.isArray(value["runs"]) ? value["runs"] : [];
    return runs
      .filter(isJsonRecord)
      .find((run) => !isTerminalRunStatus(String(run["status"] ?? "")));
  }

  private async startSessionRun(
    workspacePath: string,
    sessionId: string,
    input: RuntimeUserInput,
    resolvedInput: ResolvedRuntimeUserInput | undefined,
    identity: {
      readonly inputKey: string;
      readonly runStartKey: string;
    },
  ): Promise<JsonObject> {
    try {
      const resolved = resolvedInput ?? (await this.resolveRuntimeUserInput(workspacePath, input));
      // A conversation-first client is allowed to send its first message without opening the
      // settings screen. Materialize the effective user/project defaults before run.start so the
      // production host observes the same durable Session settings as an explicit settings.get.
      await this.withSession(workspacePath, sessionId, async (session) => {
        await this.getSessionSettings(workspacePath, session);
        await session.flushPersistence();
      });
      const canonicalInput = resolved.input ?? input;
      const checkpointId = await this.commitSessionInputOnce(
        workspacePath,
        sessionId,
        resolved.prompt,
        runtimeInputDisplay(canonicalInput),
        canonicalInput,
        identity.inputKey,
        resolved.images,
      );
      return requireJsonRecord(
        await this.options.runtimeService.startForegroundRun({
          workspacePath,
          sessionId,
          prompt: resolved.prompt,
          execution: { ...(resolved.execution ?? {}), resumeExistingSession: true, checkpointId },
          idempotencyKey: identity.runStartKey,
        }),
        "run.start result",
      );
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async commitSessionInputOnce(
    workspacePath: string,
    sessionId: string,
    prompt: string,
    displayText: string,
    input: RuntimeUserInput,
    idempotencyKey: string,
    images?: ImagePart[],
  ): Promise<string> {
    const digest = createHash("sha256")
      .update(`${workspacePath}\0${sessionId}\0${idempotencyKey}`)
      .digest("hex");
    const messageId = `desktop-input:${digest}`;
    await this.withSession(workspacePath, sessionId, async (session) => {
      // Close abandoned tool batches before a new user message can separate a
      // call from its recovery result. Keep recovery and input in the same lane.
      const capability = session.runtimeEventCapability;
      if (!capability) throw new Error("Desktop input requires a durable RuntimeEvent store");
      await RuntimeRun.reconcileIncompleteRuns({ capability });
      await RuntimeRun.repairSessionProjection(session, { capability });
      const hasMessage = session
        .getHistory()
        .some(
          (message) =>
            message.role === "user" && message.providerData?.["picoDesktopInputId"] === messageId,
        );
      if (!hasMessage) {
        if (!session.fileHistory.snapshots.some((snapshot) => snapshot.messageId === messageId)) {
          await session.beginRewindPoint({ userPrompt: displayText, messageId });
        }
        const receipt = await session.commitMessageOnce(`user-message:${messageId}`, {
          role: "user",
          content: prompt,
          providerData: {
            picoKind: "desktop_user_input",
            picoDesktopInputId: messageId,
            displayText,
            ...(input.kind === "text" && input.skills ? { skills: input.skills } : {}),
          },
          ...(images && images.length > 0 ? { images } : {}),
        });
        await session.bindRewindPointSource(messageId, receipt);
      }
      if (input.kind === "skill") {
        await ensureDesktopSkillTranscriptEntry(session, input, messageId);
      }
      await session.flushPersistence();
    });
    this.publishTranscriptUpdate(workspacePath, sessionId, "reload");
    return messageId;
  }

  private async consumeNextQueued(workspacePath: string, sessionId: string): Promise<boolean> {
    if (this.lifecycleState !== "open") return false;
    const [next] = await this.conversationStateStore.listQueued(workspacePath, sessionId);
    if (!next) return false;
    if (await this.findActiveSessionRun(workspacePath, sessionId)) return true;
    // Session admission lane prevents a Goal continuation racing a queued user Run.
    if (this.lifecycleState !== "open") return true;
    await this.startSessionRun(workspacePath, sessionId, next.input, undefined, {
      inputKey: next.queueId,
      runStartKey: desktopRunStartIdempotencyKey("queue", next.queueId),
    });
    await this.conversationStateStore.removeQueued(workspacePath, next.queueId);
    return true;
  }

  private async updateQueuedInput(
    params: RuntimeRequest<"session.queue.update">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const queueId = requireText(params.queueId, "queueId");
    const input = normalizeRuntimeUserInput(params.input);
    const queuedInput = await this.withSessionAdmission(canonical, params.sessionId, async () => {
      const updated = await this.conversationStateStore.updateQueued(
        canonical,
        params.sessionId,
        queueId,
        input,
      );
      if (!updated) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "该队列输入已被消费或移除，请刷新队列。");
      }
      this.publishTranscriptUpdate(canonical, params.sessionId, "reload");
      return updated;
    });
    return { queuedInput: queuedInputResult(queuedInput) };
  }

  private async removeQueuedInput(
    params: RuntimeRequest<"session.queue.remove">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const removed = await this.withSessionAdmission(canonical, params.sessionId, async () => {
      const deleted = await this.conversationStateStore.removeQueuedForSession(
        canonical,
        params.sessionId,
        requireText(params.queueId, "queueId"),
      );
      if (!deleted) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "该队列输入已被消费或移除，请刷新队列。");
      }
      this.publishTranscriptUpdate(canonical, params.sessionId, "reload");
      return true;
    });
    return { removed };
  }

  private async reorderQueuedInputs(
    params: RuntimeRequest<"session.queue.reorder">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const queuedInputs = await this.withSessionAdmission(canonical, params.sessionId, async () => {
      const ordered = await this.conversationStateStore.reorderQueued(
        canonical,
        params.sessionId,
        params.queueIds,
      );
      if (!ordered) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "队列已变化，请刷新后重新排序。");
      }
      this.publishTranscriptUpdate(canonical, params.sessionId, "reload");
      return ordered;
    });
    return { queuedInputs: queuedInputs.map(queuedInputResult) };
  }

  private async moveQueuedInputToNext(
    params: RuntimeRequest<"session.queue.moveToNext">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    const queuedInputs = await this.withSessionAdmission(canonical, params.sessionId, async () => {
      const ordered = await this.conversationStateStore.moveQueuedToNext(
        canonical,
        params.sessionId,
        requireText(params.queueId, "queueId"),
      );
      if (!ordered) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "该队列输入已被消费或移除，请刷新队列。");
      }
      this.publishTranscriptUpdate(canonical, params.sessionId, "reload");
      return ordered;
    });
    return { queuedInputs: queuedInputs.map(queuedInputResult) };
  }

  private async withSessionAdmission<Result>(
    workspacePath: string,
    sessionId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const key = `${workspacePath}\0${sessionId}`;
    const previous = this.sessionAdmissionTails.get(key) ?? Promise.resolve();
    const admitted = previous.then(operation, operation);
    const tail = admitted.then(
      () => undefined,
      () => undefined,
    );
    this.sessionAdmissionTails.set(key, tail);
    try {
      return await admitted;
    } finally {
      if (this.sessionAdmissionTails.get(key) === tail) this.sessionAdmissionTails.delete(key);
    }
  }

  private async consumeWorkspaceQueued(workspacePath: string): Promise<boolean> {
    return this.withWorkspaceAdmission(workspacePath, () =>
      this.consumeWorkspaceQueuedOnce(workspacePath),
    );
  }

  private withWorkspaceAdmission<Result>(
    workspacePath: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.withSessionAdmission(workspacePath, "\0workspace-admission", operation);
  }

  private async consumeWorkspaceQueuedOnce(workspacePath: string): Promise<boolean> {
    if (this.lifecycleState !== "open" || (await this.findActiveWorkspaceRun(workspacePath)))
      return true;
    let queued;
    if (this.conversationStateStore.listWorkspaceQueued)
      queued = await this.conversationStateStore.listWorkspaceQueued(workspacePath);
    else {
      const listed = requireJsonRecord(await this.listSessions(workspacePath), "session.list");
      const sessions = Array.isArray(listed["sessions"])
        ? listed["sessions"].filter(isJsonRecord)
        : [];
      queued = (
        await Promise.all(
          sessions.map((session) =>
            this.conversationStateStore.listQueued(workspacePath, String(session["sessionId"])),
          ),
        )
      )
        .flat()
        .sort((a, b) => a.createdAt - b.createdAt);
    }
    const next = queued[0];
    if (!next) return false;
    if (this.goalCoordinator.isSettling(workspacePath, next.sessionId)) return true;
    return this.withSessionAdmission(workspacePath, next.sessionId, () =>
      this.consumeNextQueued(workspacePath, next.sessionId),
    );
  }

  private async reconcileGoalContinuations(): Promise<void> {
    for (const workspacePath of await this.registrationStore.list()) {
      if (this.lifecycleState !== "open") return;
      const listed = requireJsonRecord(await this.listSessions(workspacePath), "session.list");
      const sessions = Array.isArray(listed["sessions"])
        ? listed["sessions"].filter(isJsonRecord)
        : [];
      for (const session of sessions) {
        if (typeof session["sessionId"] !== "string") continue;
        try {
          await this.goalCoordinator.recover(workspacePath, session["sessionId"]);
        } catch (error) {
          logger.warn(
            { workspacePath, sessionId: session["sessionId"], error: String(error) },
            "[Goal] 恢复失败",
          );
        }
      }
    }
  }

  private async admitGoalContinuation(
    workspacePath: string,
    sessionId: string,
    intent: GoalContinuationIntent,
  ): Promise<GoalAdmissionResult> {
    return this.withWorkspaceAdmission(workspacePath, () =>
      this.admitGoalContinuationOnce(workspacePath, sessionId, intent),
    );
  }

  private async admitGoalContinuationOnce(
    workspacePath: string,
    sessionId: string,
    intent: GoalContinuationIntent,
  ): Promise<GoalAdmissionResult> {
    return this.withSessionAdmission(workspacePath, sessionId, async () => {
      if (this.lifecycleState !== "open") return { kind: "busy" };
      if (!(await this.trustStore.isTrusted(workspacePath)))
        return { kind: "unavailable", reason: "工作区信任已撤销" };
      if (await this.findActiveWorkspaceRun(workspacePath)) return { kind: "busy" };
      if (
        this.conversationStateStore.listWorkspaceQueued &&
        (await this.conversationStateStore.listWorkspaceQueued(workspacePath)).length
      )
        return { kind: "busy" };
      try {
        return await this.withGoalSession(workspacePath, sessionId, async (session, manager) => {
          const stillCurrent = () => {
            const state = manager.snapshot();
            return (
              state.currentGoal?.id === intent.goalId &&
              state.currentGoal.status === "active" &&
              state.controlLease?.generation === intent.generation &&
              (state.coordinator.pendingContinuation?.runId === intent.runId ||
                state.coordinator.currentExecution?.runId === intent.runId)
            );
          };
          if (!stillCurrent()) return { kind: "busy" };
          const capability = session.runtimeEventCapability;
          if (!capability || !session.runtimeEventStore)
            return { kind: "unavailable", reason: "会话缺少持久化运行能力" };
          const plan = await new PlanCoordinator(session.runtimeEventStore, {
            sessionId,
            invocationId: `goal-gate:${intent.runId}`,
            runId: intent.runId,
            turnId: intent.turnId,
            writeGuard: session,
          }).project();
          if (
            plan.pendingProposal ||
            plan.reviewClaim ||
            plan.execution?.status === "active" ||
            plan.execution?.status === "interrupted"
          )
            return { kind: "busy" };
          const pendingApprovals = new Set<string>();
          for (const event of await session.runtimeEventStore.readSession(sessionId)) {
            if (event.kind === "approval.requested") pendingApprovals.add(event.data.approvalId);
            if (event.kind === "approval.settled") pendingApprovals.delete(event.data.approvalId);
          }
          if (pendingApprovals.size > 0) return { kind: "busy" };
          const settings = await this.getSessionSettings(workspacePath, session);
          if (!stillCurrent()) return { kind: "busy" };
          manager.setCoordinator({
            pendingContinuation: null,
            currentExecution: { ...intent, origin: "goal", started: false },
          });
          await session.flushPersistence();
          if (!stillCurrent()) return { kind: "busy" };
          const authorization =
            settings.orchestrationMode === "swarm" ? ("session_mode" as const) : ("none" as const);
          await RuntimeRun.start({
            capability,
            runId: intent.runId,
            turnId: intent.turnId,
            invocationId: intent.invocationId,
            runStartedEventId: intent.runStartedEventId,
            agentSwarmAuthorization: authorization,
            now: () => new Date(intent.runStartedAt),
          });
          await session.commitMessageOnce(`goal-continuation-input:${intent.runId}`, {
            role: "user",
            content: intent.prompt,
            providerData: {
              picoKind: "goal_continuation",
              picoHiddenFromTranscript: true,
              picoGoalId: intent.goalId,
            },
          });
          await session.flushPersistence();
          if (!stillCurrent()) return { kind: "busy" };
          await this.options.runtimeService.startForegroundRun({
            workspacePath,
            sessionId,
            prompt: intent.prompt,
            execution: {
              resumeExistingSession: true,
              origin: "goal",
              goalTitle: manager.getCurrent()!.condition,
              goalPreparedRun: {
                runId: intent.runId,
                turnId: intent.turnId,
                invocationId: intent.invocationId,
                runStartedEventId: intent.runStartedEventId,
                runStartedAt: new Date(intent.runStartedAt).toISOString(),
                agentSwarmAuthorization: authorization,
              },
            },
            idempotencyKey: `goal:${intent.runId}`,
          });
          return { kind: "started" };
        });
      } catch (error) {
        if (error instanceof WorkspaceRunBusyError) return { kind: "busy" };
        return { kind: "unavailable", reason: errorMessage(error) };
      }
    });
  }

  private async persistRuntimeNotification(event: RuntimeNotification): Promise<void> {
    const sessionId = event.scope.sessionId;
    if (!sessionId) return;
    const runId = event.scope.runId;
    if (
      runId &&
      isDesktopRunBoundaryNotification(event.topic) &&
      (await this.isInternalAgentGraphRun(event.scope.workspacePath, sessionId, runId))
    ) {
      // Graph messages already live in the Runtime ledger. Hide the internal Run
      // boundary, but publish its final durable watermark so clients can advance.
      if (event.topic === "run.finished") {
        this.publishTranscriptUpdate(event.scope.workspacePath, sessionId, "reload");
      }
      return;
    }
    // These facts only touch the durable transcript, whose append queue owns
    // sequence allocation, deduplication and fencing. Waiting for engine.run's
    // execution lock would delay external interaction resolutions until Run end.
    const persisted = await this.withPinnedSession(
      event.scope.workspacePath,
      sessionId,
      (session) => ingestDesktopRuntimeNotification(session, event, projectTranscriptEvents),
    );
    if (persisted) this.publishTranscriptUpdate(event.scope.workspacePath, sessionId, "reload");
  }

  private async isInternalAgentGraphRun(
    workspacePath: string,
    rootSessionId: string,
    runId: string,
  ): Promise<boolean> {
    const canonical = await this.options.runtimeService.canonicalizeWorkspacePath(workspacePath);
    const graphMode = ["graph", "swarm"].includes(
      (await this.readPersistedSessionSettings(canonical, rootSessionId))?.orchestrationMode ??
        "default",
    );
    // Session orchestration mode is persisted before the host admits a foreground Run, so it is
    // available for run.started as well as terminal notifications. Yield/wake facts are created
    // later and remain only a recovery fallback for runs admitted by older hosts.
    if (graphMode) return true;
    return this.agentGraphStore(canonical).isInternalRun(rootSessionId, runId);
  }

  private async resolveRuntimeUserInput(
    workspacePath: string,
    input: RuntimeUserInput,
  ): Promise<ResolvedRuntimeUserInput> {
    if (input.kind === "text" && !input.skills) {
      const images = inputAttachmentsToImages(input.attachments);
      return {
        prompt: input.text,
        ...(images ? { images } : {}),
        ...(input.orchestrationMode
          ? { execution: { orchestrationMode: input.orchestrationMode } }
          : {}),
      };
    }
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(canonical);
    const config = await loadPicoProjectConfig(canonical);
    const compatibility = config.compatibility.claude;
    if (input.kind === "agent") {
      if (input.subagentId !== undefined) {
        const preset = await this.configuredSubagentCatalog.resolve(input.subagentId);
        return {
          prompt: [
            "请用指定子 Agent 执行下面任务。必须调用 agent_spawn。",
            JSON.stringify({ subagent_id: preset.id, task: input.task }, null, 2),
          ].join("\n"),
          execution: { allowedTools: ["agent_spawn", "agent_output"] },
        };
      }
      const profiles = await loadAgentCatalog<HookTrustAuthority>({
        logger,
        workDir: canonical,
        includeBuiltins: true,
        includeClaudeProjectResources: compatibility.enabled && compatibility.projectResources,
        includeClaudeUserResources: compatibility.enabled && compatibility.userResources,
        ...(pluginSnapshot.agentSources ? { externalSources: pluginSnapshot.agentSources } : {}),
        env: this.env,
        picoHome: this.picoHome,
      });
      const profile = findAgentProfile(profiles, input.name);
      if (!profile) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.NOT_FOUND,
          `未找到 Agent: ${input.name}。可用 Agents: ${profiles.map((item) => item.name).join(", ") || "none"}`,
        );
      }
      return {
        prompt: renderAgentDispatchPrompt(profile, input.task),
        execution: {
          orchestrationMode: "swarm",
          allowedTools: ["update_agent_graph", "yield_agent_graph", "agent_output"],
        },
      };
    }
    const references: readonly RuntimeSkillReference[] =
      input.kind === "text" ? input.skills! : [{ name: input.name }];
    const loader = new SkillLoader<HookTrustAuthority>(canonical, {
      logger,
      includeUserResources: true,
      includeClaudeProjectResources: compatibility.enabled && compatibility.projectResources,
      includeClaudeUserResources: compatibility.enabled && compatibility.userResources,
      ...(pluginSnapshot.skillSources ? { externalSources: pluginSnapshot.skillSources } : {}),
      env: this.env,
      picoHome: this.picoHome,
    });
    // Resolve the entire effective catalog before producing any durable input or Run.
    const catalog = await loader.list();
    const skills: typeof catalog = [];
    const canonicalReferences: RuntimeSkillReference[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const skill = catalog.find(
        (candidate) =>
          canonicalResourceName(candidate.name) === canonicalResourceName(reference.name),
      );
      if (!skill)
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.NOT_FOUND,
          `未找到 Skill: ${reference.name}`,
        );
      if (
        (reference.sourceId !== undefined && reference.sourceId !== skill.source?.id) ||
        (reference.sourcePath !== undefined &&
          resolve(reference.sourcePath).normalize("NFC") !== skill.sourcePath?.normalize("NFC"))
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Skill ${reference.name} 来源已变化，请重新选择`,
        );
      }
      const identity = `${canonicalResourceName(skill.name)}\0${skill.source?.id ?? ""}\0${skill.sourcePath ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      skills.push(skill);
      canonicalReferences.push({
        name: skill.name,
        ...(skill.source?.id ? { sourceId: skill.source.id } : {}),
        ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
      });
    }
    const models = [...new Set(skills.flatMap((skill) => (skill.model ? [skill.model] : [])))];
    if (models.length > 1)
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `技能声明的模型冲突: ${models.join(", ")}`,
      );
    const toolDeclarations = skills.flatMap((skill) =>
      skill.allowedTools ? [skill.allowedTools] : [],
    );
    const allowedTools =
      toolDeclarations.length === 0
        ? undefined
        : toolDeclarations[0]!.filter((tool) =>
            toolDeclarations.every((tools) => tools.includes(tool)),
          );
    const activations = skills
      .filter((skill) => skill.sourcePath && skill.hooks !== undefined)
      .map((skill) => ({
        name: skill.name,
        sourcePath: skill.sourcePath!,
        hooks: skill.hooks,
        ...(skill.source?.id ? { sourceId: skill.source.id } : {}),
      }));
    const execution: DaemonRunExecution = {
      ...(input.kind === "text" && input.orchestrationMode
        ? { orchestrationMode: input.orchestrationMode }
        : {}),
      ...(models[0] ? { requestedModel: models[0] } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(input.kind === "text" && activations.length ? { skillActivations: activations } : {}),
      ...(input.kind === "skill" && activations[0] ? { skillActivation: activations[0] } : {}),
    };
    const prompts = skills.map(
      (skill) =>
        renderSkillActivation({
          name: skill.name,
          args: input.kind === "skill" ? (input.args ?? "") : input.text,
          body: skill.body,
          ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
          trigger: "user-slash",
        }).prompt,
    );
    if (input.kind === "text") prompts.push(`用户任务：\n${input.text}`);
    const images = input.kind === "text" ? inputAttachmentsToImages(input.attachments) : undefined;
    return {
      prompt: prompts.join("\n\n"),
      ...(input.kind === "text" ? { input: { ...input, skills: canonicalReferences } } : {}),
      ...(images ? { images } : {}),
      ...(Object.keys(execution).length > 0 ? { execution } : {}),
    };
  }

  private publishConversationFailure(workspacePath: string, error: unknown): void {
    this.publish(
      createRuntimeNotification({
        topic: "runtime.error",
        scope: { workspacePath },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: {
          code: RUNTIME_ERROR_CODES.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      }),
    );
  }

  private async requireSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const entry = await findCliSessionCatalogEntry(workspacePath, sessionId, {
      picoHome: this.picoHome,
    });
    if (!entry) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Session ${sessionId} 不存在于工作区 ${workspacePath}`,
      );
    }
    if ((await this.readPersistedSessionSettings(workspacePath, sessionId)) === undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.RESET_REQUIRED,
        `Session ${sessionId} 缺少当前版本 settings，请新建 Session`,
      );
    }
    const parentSession = await this.withWorkspaceSessionStore(workspacePath, (store) =>
      configuredSubagentParent(store, sessionId),
    );
    return { ...sessionPayload(entry), ...(parentSession ? { parentSession } : {}) };
  }

  private async readPersistedSessionSettings(
    workspacePath: string,
    sessionId: string,
  ): Promise<PersistedSessionSettings | undefined> {
    const existing = await readExistingSqliteSessionEventSlice({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
      sessionId,
      kinds: ["session.state.committed"],
    });
    return existing
      ? projectRuntimeSessionState(existing.slice.entries.map(({ event }) => event)).settings
      : undefined;
  }

  /** 归档/置顶等 sessions 表级写:短生命周期打开 workspace 级 SqliteRuntimeEventStore。 */
  private async withWorkspaceSessionStore<Result>(
    workspacePath: string,
    write: (store: SqliteRuntimeEventStore) => Result | Promise<Result>,
  ): Promise<Result> {
    const store = new SqliteRuntimeEventStore({
      warningLogger: logger,
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
    });
    try {
      return await write(store);
    } finally {
      store.close();
    }
  }

  private async unregisterWorkspace(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.registrationStore.resolveRegisteredPath(workspacePath);
    if (this.temporaryWorkspace.matches(canonical)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        "Pico 临时工作区由 Runtime 管理，不能注销",
      );
    }
    const workspaceExists = await access(canonical).then(
      () => true,
      (error: unknown) => {
        if (isNodeCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (workspaceExists) await this.assertNoActiveRuns([canonical], "注销工作区");
    const activeAutomationRuns = this.options.automations?.activeRunReferences([canonical]) ?? [];
    if (activeAutomationRuns.length > 0) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `工作区仍有活动 Automation Run ${activeAutomationRuns[0]!.runId}，拒绝注销`,
      );
    }
    const automationReferences = this.options.automations?.enabledReferences([canonical]) ?? [];
    if (automationReferences.length > 0) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `工作区仍有已启用 Automation ${automationReferences[0]!.jobId}，拒绝注销`,
      );
    }
    const result = await this.options.runtimeService.handle(
      createRuntimeRequest("workspace.unregister", { workspacePath: canonical }),
    );
    this.pluginRuntimeSnapshotRegistry.invalidate(canonical);
    this.releaseAgentGraphStore(canonical);
    return result;
  }

  private async assertNoActiveRuns(
    workspacePaths: readonly string[],
    operation: string,
  ): Promise<void> {
    for (const workspacePath of workspacePaths) {
      let result: JsonObject;
      try {
        result = requireJsonRecord(
          await this.options.runtimeService.handle(
            createRuntimeRequest("runs.list", { workspacePath }),
          ),
          "runs.list result",
        );
      } catch (error) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `无法确认工作区是否有活动 Run，已拒绝${operation}: ${errorMessage(error)}`,
        );
      }
      const runs = Array.isArray(result["runs"]) ? result["runs"] : [];
      if (
        runs.filter(isJsonRecord).some((run) => !isTerminalRunStatus(String(run["status"] ?? "")))
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `工作区 ${workspacePath} 仍有活动 Run，拒绝${operation}`,
        );
      }
    }
  }

  private assertAcceptingRequests(): void {
    if (this.lifecycleState === "open") return;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      this.lifecycleState === "closing" ? "Runtime daemon 正在关闭" : "Runtime daemon 已关闭",
    );
  }

  private projectCapabilityRevision(
    capability: "skills" | "mcp",
    scope: "user" | "project",
    revision: string,
    workspacePath = "",
  ): string {
    return createHmac("sha256", this.userConfigRevisionTokenKey)
      .update(`pico.desktop.capability-revision.v1\0${capability}\0${scope}\0`, "utf8")
      .update(workspacePath, "utf8")
      .update("\0", "utf8")
      .update(revision, "utf8")
      .digest("hex");
  }

  private async publishUserConfigUpdated(
    revision: string,
    providerIds: readonly string[],
  ): Promise<void> {
    for (const workspacePath of await this.registrationStore.list()) {
      this.publish(
        createRuntimeNotification({
          topic: "config.updated",
          scope: { workspacePath },
          resourceVersion: this.nextResourceVersion(),
          at: this.now(),
          payload: {
            scope: "user",
            revision,
            providerIds: [...providerIds],
          },
        }),
      );
    }
  }

  private async publishCapabilityConfigUpdated(
    capability: "skills" | "mcp" | "subagents",
    revision: string,
  ): Promise<void> {
    for (const workspacePath of await this.registrationStore.list()) {
      try {
        this.publish(
          createRuntimeNotification({
            topic: "config.updated",
            scope: { workspacePath },
            resourceVersion: this.nextResourceVersion(),
            at: this.now(),
            payload: {
              scope: "user",
              revision,
              capabilities: [capability],
            },
          }),
        );
      } catch (error) {
        // A refused workspace stays untouched; unrelated workspaces still receive the refresh.
        logger.warn(
          { err: error, workspacePath, capability },
          "Capability config committed but workspace refresh notification failed",
        );
      }
    }
  }

  private async getUsage(params: {
    readonly workspacePath?: string;
    readonly sessionId?: string;
    readonly from?: number;
    readonly to?: number;
  }): Promise<JsonValue> {
    const from = optionalTimestamp(params.from, "from");
    const to = optionalTimestamp(params.to, "to");
    if (from !== undefined && to !== undefined && from > to) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "usage.get 的 from 不能晚于 to",
      );
    }
    if (params.sessionId && !params.workspacePath) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "按会话查询用量时必须指定 workspacePath",
      );
    }
    const workspacePaths = params.workspacePath
      ? [await this.requireTrustedWorkspace(params.workspacePath)]
      : await this.registrationStore.list();
    const allCalls: ProviderCallRecord[] = [];
    const workspaces: JsonValue[] = [];
    const unavailableWorkspaces: { workspacePath: string; error: string }[] = [];
    const sources: Array<UsageDashboardInput["sources"][number]> = [];
    for (const workspacePath of workspacePaths) {
      let store: SqliteRuntimeControlStore | undefined;
      try {
        if (!params.workspacePath && !(await this.trustStore.isTrusted(workspacePath))) {
          unavailableWorkspaces.push({ workspacePath, error: "项目尚未信任" });
          continue;
        }
        store = new SqliteRuntimeControlStore({
          storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
        });
        const filter = params.sessionId ? { sessionId: params.sessionId } : {};
        const calls = store
          .listAccountingProviderCalls(filter)
          .filter((record) => inTimeRange(record.createdAt, from, to));
        sources.push({ workspacePath, storageRoot: store.storageRoot, calls });
        allCalls.push(...calls);
        workspaces.push(
          toJsonValue({
            workspacePath,
            ...summarizeUsageRecords(calls),
          }),
        );
      } catch (error) {
        if (params.workspacePath) throw error;
        unavailableWorkspaces.push({
          workspacePath,
          error: errorMessage(error),
        });
      } finally {
        store?.close();
      }
    }
    const summary = summarizeUsageRecords(allCalls);
    const userConfig = await this.providerConfig.userConfigStore.read();
    const pricing = usagePricing(userConfig.config.providers, MODEL_PRICING);
    const dashboard = await buildUsageDashboard({
      createRuntimeEventReader: (storageRoot) =>
        new SqliteRuntimeEventStore({ warningLogger: logger, storageRoot }),
      sources,
      pricing,
      unavailableWorkspaces,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    });
    return toJsonValue({
      usage: {
        scope: params.workspacePath ? (params.sessionId ? "session" : "workspace") : "all",
        ...(params.workspacePath ? { workspacePath: workspacePaths[0] } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...summary,
        cache: summarizeCacheEffectiveness(allCalls),
        details: dashboard,
        workspaces,
        ...(unavailableWorkspaces.length > 0 ? { unavailableWorkspaces } : {}),
        rangeAccuracy: "provider_calls_only",
      },
    });
  }

  private async listChanges(workspacePath: string, runId: string): Promise<JsonValue> {
    const projection = await this.projectRunChanges(workspacePath, runId);
    return {
      changes: projection.changes.files.map((file) =>
        runtimeChange(file, projection.workspacePath),
      ),
      fingerprint: projection.fingerprint,
    };
  }

  private async getChangeDiff(
    workspacePath: string,
    runId: string,
    requestedPath: string,
  ): Promise<JsonValue> {
    const projection = await this.projectRunChanges(workspacePath, runId);
    const file = projection.changes.files.find(
      (candidate) =>
        displayChangePath(candidate.filePath, projection.workspacePath) === requestedPath,
    );
    if (!file) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Run ${runId} 的 Changes 中不存在 ${requestedPath}`,
      );
    }
    const truncated = truncateUtf8(file.patch, MAX_DESKTOP_PATCH_BYTES);
    return {
      path: requestedPath,
      patch: truncated.value,
      truncated: truncated.truncated,
      fingerprint: projection.fingerprint,
    };
  }

  private async reviewChanges(params: {
    readonly workspacePath: string;
    readonly runId: string;
    readonly decision: "approve" | "request_changes";
    readonly message?: string;
    readonly expectedFingerprint: string;
    readonly idempotencyKey?: string;
  }): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const message = params.message?.trim();
    const request = {
      workspacePath: canonical,
      runId: params.runId,
      decision: params.decision,
      ...(message !== undefined ? { message } : {}),
      expectedFingerprint: params.expectedFingerprint,
    };
    const idempotencyKey = params.idempotencyKey?.trim();
    if (params.idempotencyKey !== undefined && !idempotencyKey)
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "idempotencyKey 不能为空");
    const command = idempotencyKey
      ? { commandType: "changes.review", idempotencyKey, request }
      : undefined;
    if (command) {
      const replay = await this.options.runtimeService.replayIdempotentDaemonCommand(
        canonical,
        command,
      );
      if (replay) return toJsonValue(replay.result);
    }
    const pendingKey = command ? `${canonical}\0${idempotencyKey}` : undefined;
    const payload = JSON.stringify(request);
    const pending = pendingKey ? this.pendingReviews.get(pendingKey) : undefined;
    if (pending) {
      if (pending.payload !== payload)
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "审阅幂等键正在处理不同的参数",
        );
      return pending.promise;
    }
    // Own the operation before the first asynchronous projection; concurrent retransmissions join it.
    const operation = this.withWorkspaceAdmission(canonical, async () => {
      const revisionPrompt =
        params.decision === "request_changes" ? requireRevisionPrompt(message) : undefined;
      const projection = await this.projectRunChanges(canonical, params.runId);
      assertDesktopChangesComplete(projection.changes, "Changes 审阅");
      assertDesktopChangesFingerprint(
        params.expectedFingerprint,
        projection.fingerprint,
        "Changes",
      );
      const prepared = revisionPrompt
        ? await this.options.runtimeService.prepareForegroundRun({
            workspacePath: canonical,
            sessionId: projection.sessionId,
            prompt: revisionPrompt,
          })
        : undefined;
      let startedRunId: string | undefined;
      const accept = () => {
        if (prepared) startedRunId = prepared.start().resourceId;
        this.publish(
          createRuntimeNotification({
            topic: "changes.updated",
            scope: {
              workspacePath: canonical,
              sessionId: projection.sessionId,
              runId: params.runId,
            },
            resourceVersion: this.nextResourceVersion(),
            at: this.now(),
            payload: { runId: params.runId, fingerprint: projection.fingerprint },
          }),
        );
        return {
          result: { accepted: true, fingerprint: projection.fingerprint },
          ...(startedRunId ? { resourceId: startedRunId } : {}),
        };
      };
      if (!command) return accept().result;
      // run.started, its daemon_runs projection, review receipt and changes.updated commit together.
      const outcome = await this.options.runtimeService.executeIdempotentDaemonCommand(
        canonical,
        command,
        accept,
        () => {
          if (startedRunId) prepared?.abort(startedRunId);
        },
      );
      return outcome.result;
    }).finally(() => {
      if (pendingKey) this.pendingReviews.delete(pendingKey);
    });
    if (pendingKey) this.pendingReviews.set(pendingKey, { payload, promise: operation });
    return operation;
  }

  private async applyChanges(
    workspacePath: string,
    runId: string,
    expectedFingerprint: string,
  ): Promise<JsonValue> {
    const projection = await this.projectRunChanges(workspacePath, runId);
    assertDesktopChangesComplete(projection.changes, "Changes 应用");
    assertDesktopChangesFingerprint(expectedFingerprint, projection.fingerprint, "Changes");
    // Foreground Agent tools already commit directly into the trusted workspace. This call
    // revalidates that the reviewed bytes are still current and records that fact;
    // it never stages or copies renderer-owned content into the workspace.
    this.publish(
      createRuntimeNotification({
        topic: "changes.applied",
        scope: {
          workspacePath: projection.workspacePath,
          sessionId: projection.sessionId,
          runId,
        },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { runId, fingerprint: projection.fingerprint },
      }),
    );
    return { applied: true, fingerprint: projection.fingerprint };
  }

  private async listRewindPoints(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    // Read-only previews must not wait for the active run's execution lease.
    return this.withPinnedSession(canonical, sessionId, async (session) => ({
      checkpoints: (await listRewindPointSummaries(session)).map((checkpoint) => ({
        checkpointId: checkpoint.messageId,
        label: checkpoint.userPrompt,
        createdAt: Date.parse(checkpoint.timestamp),
        changedFileCount: checkpoint.changedFileCount,
        additions: checkpoint.addedLines ?? 0,
        deletions: checkpoint.removedLines ?? 0,
        ...(checkpoint.incomplete ? { incomplete: true } : {}),
      })),
    }));
  }

  private async previewRewind(
    workspacePath: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<JsonValue> {
    const projection = await this.projectSessionCheckpoint(workspacePath, sessionId, checkpointId);
    return {
      checkpointId,
      changes: projection.changes.files.map((file) =>
        runtimeChange(file, projection.workspacePath),
      ),
      fingerprint: projection.fingerprint,
    };
  }

  /** /changes 单文件恢复（3-D tier2 收口）：checkpoint 维度逐文件 diff + 当前指纹。 */
  private async listRewindFileChanges(
    workspacePath: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withPinnedSession(canonical, sessionId, async (session) => {
      const changes = await fileHistoryChanges(
        session.fileHistory,
        checkpointId,
        sessionId,
        session.fileHistoryBaseDir,
      );
      const meta = changes as FileHistoryChanges & {
        incomplete?: boolean;
        warnings?: readonly string[];
      };
      return {
        checkpointId,
        files: changes.files.map((file) => {
          const truncated = truncateUtf8(file.patch ?? "", MAX_DESKTOP_PATCH_BYTES);
          return {
            path: displayChangePath(file.filePath, canonical),
            status: file.status,
            additions: file.addedLines,
            deletions: file.removedLines,
            fingerprint: file.currentFingerprint,
            patch: truncated.value,
            truncated: truncated.truncated,
          };
        }),
        addedLines: changes.addedLines,
        removedLines: changes.removedLines,
        ...(meta.incomplete ? { partial: true } : {}),
        ...(meta.warnings && meta.warnings.length > 0 ? { warnings: meta.warnings } : {}),
      };
    });
  }

  /** /changes 单文件恢复：只还原一个文件到 checkpoint 之前（指纹守卫 + idle 门）。 */
  private async restoreRewindFile(params: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly checkpointId: string;
    readonly path: string;
    readonly expectedFingerprint: string;
  }): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(
      params.workspacePath,
      params.sessionId,
      "单文件恢复",
    );
    // wire 的 path 是 displayChangePath 的产物（工作区内正斜杠相对路径，或绝对
    // 路径）；恢复侧必须还原成快照记录的绝对路径。
    const absolute = isAbsolute(params.path) ? params.path : resolve(canonical, params.path);
    return this.withSession(canonical, params.sessionId, async (session) => {
      const result = await fileHistoryRestoreFile(
        session.fileHistory,
        params.checkpointId,
        absolute,
        params.expectedFingerprint,
        params.sessionId,
        session.fileHistoryBaseDir,
      );
      return { restored: true, path: params.path, status: result.status };
    });
  }

  private async projectRunChanges(
    workspacePath: string,
    runId: string,
  ): Promise<DesktopChangesProjection> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const run = await this.options.runtimeService.getWorkspaceRun(canonical, runId);
    if (!run) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, `Run ${runId} 不存在`);
    }
    if (
      run.status === "running" ||
      run.status === "pause_requested" ||
      run.status === "paused" ||
      run.status === "cancelling"
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Run ${runId} 尚未结束，Changes 还未固化`,
      );
    }
    if (!run.sessionId || !run.checkpointId) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Run ${runId} 没有可验证的 Session/Checkpoint 关联`,
      );
    }
    const projection = await this.projectSessionCheckpoint(
      canonical,
      run.sessionId,
      run.checkpointId,
    );
    return { ...projection, runId };
  }

  private async projectSessionCheckpoint(
    workspacePath: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<DesktopChangesProjection> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withPinnedSession(canonical, sessionId, async (session) => ({
      workspacePath: canonical,
      ...(await projectDesktopCheckpoint(session, checkpointId, fileHistoryChanges)),
    }));
  }

  private async requireTrustedSession(workspacePath: string, sessionId: string): Promise<string> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    await this.requireSession(canonical, sessionId);
    return canonical;
  }

  private async requireIdleTrustedSession(
    workspacePath: string,
    sessionId: string,
    operation: string,
  ): Promise<string> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    const activeRun = await this.findActiveSessionRun(canonical, sessionId);
    if (activeRun) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Session ${sessionId} 仍有活动 Run，不能${operation}`,
      );
    }
    return canonical;
  }

  private async getSessionSettings(
    workspacePath: string,
    session: Session,
    options: { readonly persist?: boolean } = {},
  ) {
    const persisted = session.getRuntimeStateSnapshot().settings;
    if (!persisted) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.RESET_REQUIRED,
        `Session ${session.id} 缺少当前版本 settings，请新建 Session`,
      );
    }
    return getOrCreateSessionSettings(
      {
        sessionId: session.id,
        cwd: workspacePath,
        picoHome: this.picoHome,
        provider: persisted.provider,
        model: persisted.model,
        modelRouteId: persisted.modelRouteId,
        collaborationMode: persisted.collaborationMode,
        permissionMode: persisted.permissionMode,
        orchestrationMode: persisted.orchestrationMode,
        ...(persisted.thinkingEffort ? { thinkingEffort: persisted.thinkingEffort } : {}),
      },
      {
        persistence: session,
        ...(options.persist === undefined ? {} : { persist: options.persist }),
      },
    );
  }

  private async initializeSessionSettings(
    workspacePath: string,
    session: Session,
    modelRouteId?: string,
  ) {
    const persisted = session.getRuntimeStateSnapshot().settings;
    if (persisted) return this.getSessionSettings(workspacePath, session);
    const defaults = effectiveSessionSettingDefaults(
      await this.loadSessionModelRuntime(workspacePath, modelRouteId),
      modelRouteId,
    );
    return getOrCreateSessionSettings(
      {
        sessionId: session.id,
        sessionMode: "new",
        cwd: workspacePath,
        picoHome: this.picoHome,
        provider: defaults.provider,
        model: defaults.model,
        modelRouteId: defaults.modelRouteId,
        collaborationMode: "agent",
        permissionMode: "ask",
        ...(defaults.thinkingEffort ? { thinkingEffort: defaults.thinkingEffort } : {}),
      },
      { persistence: session },
    );
  }

  /** Fork sources must already own a complete current-version settings fact. */
  private async getForkSourceSettings(workspacePath: string, session: Session) {
    return this.getSessionSettings(workspacePath, session);
  }

  private async getSessionModelRouter(
    workspacePath: string,
    preferredModelRouteId?: string,
  ): Promise<ModelRouter> {
    return (await this.loadSessionModelRuntime(workspacePath, preferredModelRouteId)).router;
  }

  private loadSessionModelRuntime(
    workspacePath: string,
    preferredModelRouteId?: string,
  ): Promise<EffectiveModelRuntime> {
    return loadEffectiveModelRuntime({
      workDir: workspacePath,
      projectTrusted: true,
      env: this.env,
      credentialVault: this.providerConfig.credentialVault,
      userConfigStore: this.providerConfig.userConfigStore,
      configResolver: this.providerConfig.effectiveConfigResolver,
      ...(preferredModelRouteId ? { preferredModelRouteId } : {}),
    });
  }

  private async withSession<T>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session) => Promise<T>,
  ): Promise<T> {
    return this.withPinnedSession(workspacePath, sessionId, (session) =>
      session.withSerializedExecution(() => operation(session)),
    );
  }

  private async withPinnedSession<T>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session) => Promise<T>,
  ): Promise<T> {
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
      persistence: true,
      picoHome: this.picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      return await operation(lease.session);
    } finally {
      lease.release();
    }
  }

  private async manageHooks(params: {
    readonly workspacePath: string;
    readonly action: "list" | "review" | "trust" | "enable" | "disable" | "reload";
    readonly handlerId?: string;
  }): Promise<JsonValue> {
    // /hooks 管理面（BLOCKED 收口）：每请求临时装配会话级 hook runtime——
    // 配置/信任/状态加载是无进程操作，reload 语义=下次 run 生效（与插件快照同构）。
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(canonical);
    const runtime = await createSessionHookRuntime({
      logger,
      workDir: canonical,
      picoHome: this.picoHome,
      env: this.env,
      workspaceTrustStore: this.trustStore,
      ...(pluginSnapshot.hookSources.length > 0
        ? { extensionSources: pluginSnapshot.hookSources }
        : {}),
      sessionId: `hooks-manage:${randomUUID()}`,
    });
    try {
      const management = runtime.management;
      const handlerId = params.handlerId;
      switch (params.action) {
        case "list":
          return toJsonValue({ result: { items: management.list() } });
        case "review":
          if (!handlerId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "hooks.manage review 需要 handler-id",
            );
          }
          return toJsonValue({ result: { review: await management.review(handlerId) } });
        case "trust":
        case "enable":
        case "disable":
          if (!handlerId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              `hooks.manage ${params.action} 需要 handler-id`,
            );
          }
          await (params.action === "trust"
            ? management.trust(handlerId)
            : params.action === "enable"
              ? management.enable(handlerId)
              : management.disable(handlerId));
          return toJsonValue({ result: { ok: true } });
        case "reload":
          return toJsonValue({ result: { reloaded: await management.reload() } });
      }
    } finally {
      await runtime.dispose();
    }
  }

  private async manageOperations(params: {
    readonly workspacePath: string;
    readonly action: "list" | "show" | "retry" | "abort";
    readonly operationId?: string;
    readonly expectedVersion?: number;
    readonly reason?: string;
  }): Promise<JsonValue> {
    // /operations 处置面（BLOCKED 收口）：与 forkSession 同构装配 SessionForkService
    // （journal 落盘在 workDir 的 storage 目录，操作即 daemon 侧产生的事实）。
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const service = new SessionForkService({
      workDir: canonical,
      picoHome: this.picoHome,
      runtimePort: createSessionForkRuntimePort(),
    });
    try {
      switch (params.action) {
        case "list":
          if (params.operationId !== undefined) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "operations.manage list 不接受 operationId",
            );
          }
          return toJsonValue({ result: { operations: await service.listNeedsAttention() } });
        case "show": {
          if (!params.operationId) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "operations.manage show 需要 operationId",
            );
          }
          const operation = await service.getOperation(params.operationId);
          if (!operation) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.NOT_FOUND,
              `Storage operation not found: ${params.operationId}`,
            );
          }
          return toJsonValue({ result: { operation } });
        }
        case "retry":
        case "abort": {
          if (!params.operationId || params.expectedVersion === undefined) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              `operations.manage ${params.action} 需要 operationId 与 expectedVersion`,
            );
          }
          const input = {
            operationId: params.operationId,
            expectedVersion: params.expectedVersion,
            reason: params.reason?.trim() || `requested via /operations ${params.action}`,
          };
          const operation =
            params.action === "retry"
              ? await service.retryNeedsAttention(input)
              : await service.abortNeedsAttention(input);
          return toJsonValue({ result: { operation } });
        }
      }
    } finally {
      service.close();
    }
  }

  private async managePlugins(params: {
    readonly workspacePath: string;
    readonly action:
      | "list"
      | "inspect"
      | "install"
      | "trust.prepare"
      | "trust.confirm"
      | "enable"
      | "disable";
    readonly id?: string;
    readonly scope?: "user" | "project" | "local";
    readonly path?: string;
    readonly confirmId?: string;
    readonly fingerprint?: string;
  }): Promise<JsonValue> {
    // /plugin 管理面（BLOCKED 收口）：PluginManagementService 纯本地
    // （安装/信任/启停落盘 + trust store），每请求装配，运行时贡献由下一
    // Session 快照接管（与 hooks 同构）。trust 两阶段无状态化：confirm 用
    // fresh proposal 校验 confirmId+指纹，客户端无需持有 pending 状态。
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const service = new PluginManagementService({
      workDir: canonical,
      picoHome: this.picoHome,
      env: this.env,
    });
    const requireRef = (): {
      readonly id: string;
      readonly scope: "user" | "project" | "local";
    } => {
      if (!params.id || !params.scope) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.INVALID_PARAMS,
          `plugin.manage ${params.action} 需要 id 与 scope`,
        );
      }
      return { id: params.id, scope: params.scope };
    };
    switch (params.action) {
      case "list":
        return toJsonValue({ result: { plugins: await service.list() } });
      case "inspect": {
        const reference = requireRef();
        return toJsonValue({ result: { plugin: await service.inspect(reference) } });
      }
      case "install": {
        if (!params.path || !params.scope) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "plugin.manage install 需要 path 与 scope",
          );
        }
        return toJsonValue({
          result: { install: await service.install(params.path, params.scope) },
        });
      }
      case "trust.prepare": {
        const reference = requireRef();
        return toJsonValue({ result: { proposal: await service.prepareTrust(reference) } });
      }
      case "trust.confirm": {
        const reference = requireRef();
        if (!params.confirmId || !params.fingerprint) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "plugin.manage trust.confirm 需要 confirmId 与 fingerprint",
          );
        }
        const proposal = await service.prepareTrust(reference);
        if (proposal.id !== params.confirmId || proposal.resourceDigest !== params.fingerprint) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            "Plugin 内容在确认期间发生变化，请重新 /plugin trust",
          );
        }
        await service.trust(proposal);
        return toJsonValue({ result: { ok: true } });
      }
      case "enable":
      case "disable": {
        const reference = requireRef();
        await (params.action === "enable" ? service.enable(reference) : service.disable(reference));
        return toJsonValue({ result: { ok: true } });
      }
    }
  }

  private async withTrustedMemory<Result extends JsonValue>(
    workspacePath: string,
    operation: (canonicalWorkspacePath: string) => Result | Promise<Result>,
  ): Promise<Result> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    return operation(canonical);
  }

  private publishMemoryNotification<
    Topic extends Extract<RuntimeNotificationTopic, `memory.${string}`>,
  >(workspacePath: string, topic: Topic, payload: RuntimeNotificationMap[Topic]): void {
    const base = {
      scope: { workspacePath },
      resourceVersion: this.nextResourceVersion(),
      at: this.now(),
    };
    if (topic === "memory.changed") {
      this.publish(
        createRuntimeNotification({
          ...base,
          topic: "memory.changed",
          payload: payload as RuntimeNotificationMap["memory.changed"],
        }),
      );
      return;
    }
    this.publish(
      createRuntimeNotification({
        ...base,
        topic: "memory.deleted",
        payload: payload as RuntimeNotificationMap["memory.deleted"],
      }),
    );
  }

  private async requireTrustedWorkspace(workspacePath: string): Promise<string> {
    const canonical = await this.trustStore.canonicalize(workspacePath);
    if (!(await this.trustStore.isTrusted(canonical))) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.FORBIDDEN,
        `工作区尚未信任，不会读取项目配置: ${canonical}`,
      );
    }
    return canonical;
  }

  private publishSession(session: JsonValue): void {
    if (!isJsonRecord(session)) return;
    const workspacePath = session["workspacePath"];
    const sessionId = session["sessionId"];
    if (typeof workspacePath !== "string" || typeof sessionId !== "string") return;
    this.publish(
      createRuntimeNotification({
        topic: "session.updated",
        scope: { workspacePath, sessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { session },
      }),
    );
  }

  private publishTranscriptUpdate(
    workspacePath: string,
    sessionId: string,
    _operation: "reload" | "truncate",
  ): void {
    this.options.onTranscriptAdvanced?.(workspacePath, sessionId);
  }

  private publishJob(job: JsonValue): void {
    if (!isJsonRecord(job)) return;
    const workspacePath = job["workspacePath"];
    const jobId = job["jobId"];
    if (typeof workspacePath !== "string" || typeof jobId !== "string") return;
    this.publish(
      createRuntimeNotification({
        topic: "job.updated",
        scope: { workspacePath, jobId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { job },
      }),
    );
  }

  private publish(notification: RuntimeNotification): void {
    this.options.runtimeService.publishDesktopNotification(notification);
  }

  private nextResourceVersion(): number {
    this.resourceVersion = Math.max(this.resourceVersion + 1, this.now());
    return this.resourceVersion;
  }

  private agentGraphStore(workspacePath: string): SqliteAgentGraphControlStore {
    const existing = this.agentGraphStores.get(workspacePath);
    if (existing) return existing;
    const store = new SqliteAgentGraphControlStore({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
      now: this.now,
    });
    this.agentGraphStores.set(workspacePath, store);
    return store;
  }

  private releaseAgentGraphStore(workspacePath: string): void {
    const store = this.agentGraphStores.get(workspacePath);
    if (!store) return;
    this.agentGraphStores.delete(workspacePath);
    store.close();
  }

  private sideChatAuthority(
    workspacePath: string,
    context?: TerminalClientContext,
  ): SideChatAuthority {
    const storageRoot = resolvePicoPaths(workspacePath, {
      picoHome: this.picoHome,
    }).workspace.root;
    return new SideChatAuthority({
      storageRoot,
      now: () => new Date(this.now()),
      fork: async ({ sourceSessionId, targetSessionId, throughEventId }) => {
        const sourceLease = await globalSessionManager.getOrCreatePinned(
          sourceSessionId,
          workspacePath,
          {
            persistence: true,
            picoHome: this.picoHome,
            runtimePort: createEngineRuntimePort(),
          },
        );
        try {
          await this.getForkSourceSettings(workspacePath, sourceLease.session);
          await sourceLease.session.flushPersistence();
          const forkService = new SessionForkService({
            workDir: workspacePath,
            picoHome: this.picoHome,
            runtimePort: createSessionForkRuntimePort(),
          });
          try {
            await forkService.fork({ sourceSessionId, targetSessionId, throughEventId });
          } finally {
            forkService.close();
          }
        } finally {
          sourceLease.release();
        }
      },
      markSideConversation: async (targetSessionId) => {
        await this.withSession(workspacePath, targetSessionId, async (session) => {
          const settings = await this.getSessionSettings(workspacePath, session);
          setSessionSideConversation(settings, true);
          await session.flushPersistence();
        });
      },
      removeSession: async (targetSessionId) => {
        await this.removeEphemeralSideChat(workspacePath, targetSessionId, context);
      },
    });
  }

  private async removeEphemeralSideChat(
    workspacePath: string,
    sessionId: string,
    context?: TerminalClientContext,
  ): Promise<void> {
    await this.terminalService.stopSession({ workspacePath, sessionId }, context);
    await this.revokeWindowsTaskNetwork(sessionId);
    globalSessionPermissionGrants.clear(sessionId, workspacePath, this.picoHome);
    await globalClientCapabilityGrants.revokeSession(
      sessionId,
      resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
    );
    const managed = globalSessionManager.delete(sessionId, workspacePath, {
      picoHome: this.picoHome,
    });
    await managed?.close();
    await Promise.all([
      removeCliSessionFile(workspacePath, sessionId, { picoHome: this.picoHome }),
      this.conversationStateStore.clearQueued(workspacePath, sessionId),
    ]);
    this.workbarRepository(workspacePath).purgeOrphanArtifactBlobs();
  }

  private workbarRepository(workspacePath: string): SqliteSessionWorkbarRepository {
    return new SqliteSessionWorkbarRepository({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
      now: this.now,
    });
  }

  private withWorkbarErrors<Result>(operation: () => Result): Result {
    try {
      return operation();
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      if (error instanceof WorkbarConflictError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      if (error instanceof WorkbarNotFoundError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, error.message);
      }
      if (error instanceof WorkbarForbiddenError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FORBIDDEN, error.message);
      }
      throw error;
    }
  }

  private async withHostWorkbarErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      if (error instanceof WorkbarGitReviewError) {
        const code =
          error.code === "not_found"
            ? RUNTIME_ERROR_CODES.NOT_FOUND
            : error.code === "revision_conflict"
              ? RUNTIME_ERROR_CODES.CONFLICT
              : error.code === "outside_workspace"
                ? RUNTIME_ERROR_CODES.FORBIDDEN
                : RUNTIME_ERROR_CODES.INVALID_PARAMS;
        throw new RuntimeProtocolError(code, error.message);
      }
      if (error instanceof WorkbarTerminalError) {
        const code =
          error.code === "not_found"
            ? RUNTIME_ERROR_CODES.NOT_FOUND
            : error.code === "forbidden"
              ? RUNTIME_ERROR_CODES.FORBIDDEN
              : error.code === "resource_epoch_mismatch" ||
                  error.code === "capacity_exceeded" ||
                  error.code === "admission_closed"
                ? RUNTIME_ERROR_CODES.CONFLICT
                : RUNTIME_ERROR_CODES.INVALID_PARAMS;
        throw new RuntimeProtocolError(code, error.message);
      }
      throw error;
    }
  }

  private async withBrowserAgentErrors<Result>(
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      if (error instanceof BrowserAgentBrokerError) {
        const code =
          error.code === "BROWSER_NOT_VISIBLE" || error.code === "BROWSER_LEASE_STALE"
            ? RUNTIME_ERROR_CODES.FORBIDDEN
            : RUNTIME_ERROR_CODES.CONFLICT;
        throw new RuntimeProtocolError(code, error.message);
      }
      throw error;
    }
  }

  private publishWorkbarResource(
    workspacePath: string,
    sessionId: string,
    resource: "tasks" | "artifacts" | "trace" | "context" | "goal",
    value: { readonly revision?: number; readonly watermark?: number },
  ): void {
    this.publish(
      createRuntimeNotification({
        topic: "session.resourceChanged",
        scope: { workspacePath, sessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: {
          resource,
          ...(value.revision !== undefined ? { revision: value.revision } : {}),
          ...(value.watermark !== undefined ? { watermark: value.watermark } : {}),
        },
      }),
    );
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "contentBase64 不是规范 Base64",
    );
  }
  return decoded;
}

function firstSendRequestFingerprint(params: {
  readonly sessionId?: string;
  readonly input: RuntimeUserInput;
  readonly initialSettings?: RuntimeUserDefaults;
  readonly behavior?: "auto" | "steer" | "queue" | "replace";
  readonly expectedRunId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: params.sessionId ?? null,
        input: params.input,
        initialSettings: params.initialSettings ?? null,
        behavior: params.behavior ?? "auto",
        expectedRunId: params.expectedRunId ?? null,
      }),
    )
    .digest("hex");
}

function desktopRunStartIdempotencyKey(source: "send" | "queue" | "goal", key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return `desktop-${source}-run:${digest}`;
}

function sessionPayload(entry: SqliteSessionCatalogEntry): JsonObject {
  const summary = entry.summary;
  return {
    sessionId: summary.id,
    workspacePath: summary.cwd,
    title: summary.title ?? summary.firstMessage ?? "未命名会话",
    status: entry.isArchived ? "archived" : "active",
    pinned: entry.isPinned,
    createdAt: summary.createdAt.getTime(),
    updatedAt: summary.updatedAt.getTime(),
    ...(summary.messageCount !== undefined ? { messageCount: summary.messageCount } : {}),
    ...(summary.lastMessage ? { lastMessage: summary.lastMessage } : {}),
    ...(summary.forkFrom ? { forkFrom: summary.forkFrom } : {}),
  };
}

function runtimeSessionSettings(settings: SessionSettings, router: ModelRouter): JsonObject {
  if (!settings.modelRouteId) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "Durable Session settings are missing modelRouteId",
    );
  }
  return {
    sessionId: settings.sessionId,
    provider: settings.provider,
    model: settings.model,
    modelRouteId: settings.modelRouteId,
    collaborationMode: settings.collaborationMode,
    orchestrationMode: settings.orchestrationMode,
    permissionMode: settings.permissionMode,
    thinkingEffort: settings.thinkingEffort,
    thinkingEffortExplicit: settings.thinkingEffortExplicit,
    reasoningLevels: [...sessionReasoningCandidates(settings, router)],
    ...(settings.additionalDirectories.length > 0
      ? { additionalDirectories: settings.additionalDirectories }
      : {}),
  };
}

function resolveRequestedModelRoute(
  router: ModelRouter,
  modelRouteId: string | undefined,
): ModelRoute | undefined {
  if (modelRouteId === undefined) return undefined;
  const normalized = modelRouteId.trim();
  const route = router.routes.find((candidate) => candidate.id === normalized);
  if (!route) {
    const available = router.routes.map((candidate) => candidate.id).join(", ") || "none";
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `模型路由 ${normalized || "(empty)"} 不可用。可用模型: ${available}。`,
    );
  }
  if (!route.baseURL.trim()) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `模型路由 ${route.id} 缺少 baseURL`,
    );
  }
  return route;
}

function resolveCurrentModelRoute(router: ModelRouter, settings: SessionSettings): ModelRoute {
  const route = router.routes.find((candidate) => candidate.id === settings.modelRouteId);
  if (route) return route;
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.CONFLICT,
    `当前模型路由 ${settings.modelRouteId ?? "(missing)"} 已不可用，请先选择有效模型`,
  );
}

function validateRequestedThinkingEffort(route: ModelRoute, thinkingEffort: string): void {
  const normalized = thinkingEffort.trim().toLowerCase();
  if (!route.capabilities.reasoningProfile.levels.includes(normalized)) {
    const levels = route.capabilities.reasoningProfile.levels.join(", ") || "none";
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `模型路由 ${route.id} 不支持 thinking=${normalized || "(empty)"}；可选档位: ${levels}`,
    );
  }
}

function validateRequestedSessionSettings(params: {
  readonly modelRouteId?: string;
  readonly collaborationMode?: string;
  readonly orchestrationMode?: string;
  readonly permissionMode?: string;
  readonly thinkingEffort?: string;
}): asserts params is RuntimeUserDefaults {
  if (
    params.modelRouteId === undefined &&
    params.collaborationMode === undefined &&
    params.orchestrationMode === undefined &&
    params.permissionMode === undefined &&
    params.thinkingEffort === undefined
  ) {
    throw invalidSessionSetting("session.settings.update 至少需要一个设置字段");
  }
  if (
    params.collaborationMode !== undefined &&
    params.collaborationMode !== "agent" &&
    params.collaborationMode !== "plan" &&
    params.collaborationMode !== "research"
  ) {
    throw invalidSessionSetting("collaborationMode 必须是 agent、plan 或 research");
  }
  if (
    params.orchestrationMode !== undefined &&
    params.orchestrationMode !== "default" &&
    params.orchestrationMode !== "graph" &&
    params.orchestrationMode !== "swarm"
  ) {
    throw invalidSessionSetting("orchestrationMode 必须是 default、graph 或 swarm");
  }
  if (
    params.permissionMode !== undefined &&
    params.permissionMode !== "ask" &&
    params.permissionMode !== "auto" &&
    params.permissionMode !== "full-access"
  ) {
    throw invalidSessionSetting("permissionMode 必须是 ask、auto 或 full-access");
  }
}

function invalidSessionSetting(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}

function effectiveSessionSettingDefaults(
  runtime: EffectiveModelRuntime,
  modelRouteId?: string,
): {
  provider: ProviderKind;
  model: string;
  modelRouteId: string;
  thinkingEffort?: string;
} {
  // First-send overrides choose the final route before coordinating the inherited level.
  const route = runtime.router.require(modelRouteId ?? runtime.config.defaultModelRouteId);
  const reasoning = coordinateReasoningLevel(
    route.capabilities.reasoningProfile,
    runtime.config.defaults.thinkingEffort,
  );
  return {
    provider: route.provider,
    model: route.model,
    modelRouteId: route.id,
    ...(runtime.config.defaults.thinkingEffort && reasoning.level
      ? { thinkingEffort: reasoning.level }
      : {}),
  };
}

function optionalTimestamp(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `${name} 必须是非负整数毫秒时间戳`,
    );
  }
  return value;
}

function inTimeRange(at: number, from: number | undefined, to: number | undefined): boolean {
  return (from === undefined || at >= from) && (to === undefined || at <= to);
}

function summarizeUsageRecords(calls: readonly ProviderCallRecord[]): JsonObject {
  const providerCalls = sumUsage(calls);
  const total = providerCalls;
  let usageReportCount = 0;
  let reasoningTokens = 0;
  let estimatedCostCallCount = 0;
  let includedCostCallCount = 0;
  let unknownCostCallCount = 0;
  for (const call of calls) {
    const reported = call.reported ?? {};
    const fields = reported["reportedFields"];
    if (
      reported["usageMetadata"] === "reported" &&
      (!Array.isArray(fields) || (fields.includes("prompt") && fields.includes("completion")))
    )
      usageReportCount += 1;
    const reasoning = reported["reasoningTokens"];
    if (typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0) {
      reasoningTokens += reasoning;
    }
    if (reported["costStatus"] === "estimated") estimatedCostCallCount += 1;
    else if (reported["costStatus"] === "included") includedCostCallCount += 1;
    else unknownCostCallCount += 1;
  }
  const unknownCostRecordCount = unknownCostCallCount;
  const pricedKinds = Number(estimatedCostCallCount > 0) + Number(includedCostCallCount > 0);
  const costStatus =
    calls.length === 0
      ? "none"
      : unknownCostRecordCount > 0 || pricedKinds > 1
        ? estimatedCostCallCount > 0 || includedCostCallCount > 0
          ? "partial"
          : "unknown"
        : estimatedCostCallCount > 0
          ? "estimated"
          : "included";
  return {
    providerCallCount: calls.length,
    usageReportCount,
    providerCalls: { ...providerCalls },
    total: {
      ...total,
      costCNY: total.cost,
      totalTokens:
        total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens + total.outputTokens,
      reasoningTokens,
    },
    currency: "CNY",
    costStatus,
    estimatedCostCallCount,
    includedCostCallCount,
    unknownCostRecordCount,
  };
}

function sumUsage(records: readonly ProviderCallRecord[]): UsageLedgerTotals {
  return records.reduce<UsageLedgerTotals>(
    (total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      cost: total.cost + record.cost,
    }),
    emptyUsage(),
  );
}

function emptyUsage(): UsageLedgerTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

const MAX_DESKTOP_PATCH_BYTES = 512 * 1024;

interface DesktopChangesProjection extends DesktopCheckpointProjection {
  readonly workspacePath: string;
  readonly runId?: string;
}

function runtimeChange(file: FileHistoryFilePatch, workspacePath: string): JsonObject {
  return {
    path: displayChangePath(file.filePath, workspacePath),
    status:
      file.status === "created" ? "added" : file.status === "deleted" ? "deleted" : "modified",
    additions: file.addedLines,
    deletions: file.removedLines,
  };
}

function displayChangePath(filePath: string, workspacePath: string): string {
  const absoluteFilePath = resolve(filePath);
  const fromWorkspace = relative(resolve(workspacePath), absoluteFilePath);
  if (
    fromWorkspace &&
    fromWorkspace !== ".." &&
    !fromWorkspace.startsWith(`..${sep}`) &&
    !isAbsolute(fromWorkspace)
  ) {
    return fromWorkspace.split("\\").join("/");
  }
  return absoluteFilePath;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function requireRevisionPrompt(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "要求修改时必须说明原因");
  }
  return normalized;
}

/** Persist a user-triggered Skill card beside the display-only input message. */
async function ensureDesktopSkillTranscriptEntry(
  session: Session,
  input: Extract<RuntimeUserInput, { kind: "skill" }>,
  messageId: string,
): Promise<void> {
  const eventId = `desktop-skill:${messageId}`;
  const snapshot = await session.readHydrationSnapshot();
  if (snapshot.transcriptEvents.some((event) => event.eventId === eventId)) return;
  const sequence = (snapshot.transcriptEvents.at(-1)?.sequence ?? 0) + 1;
  const event = {
    eventId,
    sequence,
    createdAt: Date.now(),
    type: "entry.appended",
    entryId: `desktop-skill-entry:${messageId}`,
    entry: {
      kind: "skill",
      name: input.name,
      args: input.args ?? "",
      trigger: "user-slash",
    },
  } satisfies TranscriptEvent;
  await session.recordTranscriptEvent(event, { eventId: `desktop-transcript:${eventId}` });
}

function normalizeRuntimeUserInput(value: RuntimeUserInput): RuntimeUserInput {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "input 必须是对象");
  }
  // Reuse the exact protocol shape gate for internal callers as well.
  parseStrictRuntimeParams("session.send", {
    workspacePath: "/",
    input: value,
    idempotencyKey: "validate",
  });
  const kind = value["kind"];
  if (kind === "text") {
    const attachments = normalizeInputAttachments(value["attachments"]);
    const mode = value["orchestrationMode"];
    if (mode !== undefined && mode !== "graph" && mode !== "swarm")
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "input.orchestrationMode 必须是 graph 或 swarm",
      );
    return {
      kind,
      text:
        value.skills && typeof value["text"] === "string"
          ? value["text"].trim()
          : requireText(value["text"], "input.text"),
      ...(attachments ? { attachments } : {}),
      ...(value.skills ? { skills: value.skills as readonly RuntimeSkillReference[] } : {}),
      ...(mode ? { orchestrationMode: mode } : {}),
    };
  }
  if (kind === "skill") {
    const args = value["args"];
    if (args !== undefined && typeof args !== "string") {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "input.args 必须是字符串");
    }
    return {
      kind,
      name: requireText(value["name"], "input.name"),
      ...(typeof args === "string" ? { args } : {}),
    };
  }
  if (kind === "agent") {
    const subagentId = value["subagentId"];
    if (subagentId !== undefined && !isSafeSubagentPresetId(subagentId)) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "input.subagentId 无效");
    }
    return {
      kind,
      name: requireText(value["name"], "input.name"),
      task: requireText(value["task"], "input.task"),
      ...(typeof subagentId === "string" ? { subagentId } : {}),
    };
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
    `input.kind 不支持: ${String(kind)}`,
  );
}

function queuedInputResult(value: DesktopQueuedInput): RuntimeQueuedInput {
  return {
    queueId: value.queueId,
    sessionId: value.sessionId,
    input: value.input,
    createdAt: value.createdAt,
  };
}

/**
 * text 输入附件的 daemon 侧再校验（协议参数门已是第一道；本函数兜住内部
 * 调用方如队列重放）。合法形状原样保留，缺省返回 undefined，malformed 抛
 * INVALID_PARAMS——上限与协议层一致（4 张 / 总 256KB 解码后）。
 */
function normalizeInputAttachments(value: unknown): readonly RuntimeInputAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "input.attachments 必须是非空数组（无附件时省略字段）",
    );
  }
  if (value.length > 4) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "input.attachments 最多 4 张图片",
    );
  }
  let totalChars = 0;
  const attachments = value.map((item, index) => {
    if (!isJsonRecord(item) || item["type"] !== "image_base64") {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `input.attachments[${index}] 必须是 image_base64 附件对象`,
      );
    }
    const mimeType = typeof item["mimeType"] === "string" ? item["mimeType"] : "";
    const data = typeof item["data"] === "string" ? item["data"] : "";
    if (!mimeType || !data) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `input.attachments[${index}] 缺少 mimeType/data`,
      );
    }
    totalChars += data.length;
    return { type: "image_base64" as const, mimeType, data };
  });
  if (totalChars > Math.floor((256 * 1024 * 4) / 3)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "input.attachments 解码后总大小超过 256KB 上限",
    );
  }
  return attachments;
}

/** 协议 wire 附件 → 引擎 ImagePart（形状同一，独立类型面保持协议/引擎解耦）。 */
function inputAttachmentsToImages(
  attachments: readonly RuntimeInputAttachment[] | undefined,
): ImagePart[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment) => ({
    type: "image_base64",
    mimeType: attachment.mimeType,
    data: attachment.data,
  }));
}

function isRuntimeActivation(input: RuntimeUserInput): boolean {
  return input.kind !== "text" || (input.skills?.length ?? 0) > 0;
}

function runtimeInputTitle(input: RuntimeUserInput): string {
  if (input.kind === "agent") return input.task;
  if (input.kind === "skill") {
    return [`/${input.name}`, input.args?.trim()].filter(Boolean).join(" ");
  }
  return input.text || input.skills?.map((skill) => `/${skill.name}`).join(" ") || "";
}

function runtimeInputDisplay(input: RuntimeUserInput): string {
  if (input.kind === "agent") return [`@${input.name}`, input.task.trim()].join(" ");
  if (input.kind === "skill") {
    return [`/${input.name}`, input.args?.trim()].filter(Boolean).join(" ");
  }
  return input.text.trim() || input.skills?.map((skill) => `/${skill.name}`).join(" ") || "";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function goalRunCompletion(run: JsonObject): GoalRunCompletion {
  const result = isJsonRecord(run["result"]) ? run["result"] : undefined;
  const outcome = isJsonRecord(result?.["outcome"]) ? result["outcome"] : undefined;
  const usage = isJsonRecord(outcome?.["primaryUsage"]) ? outcome["primaryUsage"] : undefined;
  return {
    runId: String(run["runId"]),
    status: String(run["status"]),
    ...(typeof run["error"] === "string" ? { error: run["error"] } : {}),
    ...(typeof outcome?.["stopReason"] === "string" ? { stopReason: outcome["stopReason"] } : {}),
    ...(typeof usage?.["promptTokens"] === "number" && typeof usage["completionTokens"] === "number"
      ? {
          primaryUsage: {
            promptTokens: usage["promptTokens"],
            completionTokens: usage["completionTokens"],
          },
        }
      : {}),
  };
}
