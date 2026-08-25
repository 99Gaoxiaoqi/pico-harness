import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, unwatchFile, watchFile } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkbarTerminalError } from "@pico/runtime-host";
import { listRewindPointSummaries } from "../cli/file-history.js";
import {
  createCliSessionId,
  findCliSessionCatalogEntry,
  listCliSessionCatalogEntries,
  removeCliSessionFile,
} from "../cli/session-resolver.js";
import { createContextBudget, estimateMessagesTokens } from "../context/context-budget.js";
import { EvidenceArchive, parseEvidenceUri } from "../context/evidence-archive.js";
import { FullCompactor } from "../context/full-compactor.js";
import { recordRuntimeCompactionCheckpoint } from "../context/runtime-compaction-checkpoint.js";
import { SkillLoader } from "../context/skill.js";
import { findAgentProfile, loadAgentCatalog } from "../agents/catalog.js";
import { ResourceDoctor, renderResourceDoctorReport } from "../diagnostics/resource-doctor.js";
import {
  runWorkspaceDoctor,
  workspaceConfigurationDiagnosticFromRuntime,
} from "../diagnostics/workspace-doctor.js";
import { SessionForkService } from "../engine/session-fork-service.js";
import { projectRuntimeSessionActiveToolResultEntries } from "../engine/session-runtime-projection.js";
import { globalSessionManager, Session } from "../engine/session.js";
import {
  DEFAULT_INTERACTION_MODE,
  getOrCreateSessionSettings,
  migrateSessionModelRoute,
  normalizeInteractionMode,
  sessionReasoningCandidates,
  setSessionCollaborationMode,
  setSessionOrchestrationMode,
  setSessionPermissionMode,
  setSessionSideConversation,
  setSessionThinkingEffort,
  setSessionTitle,
  addSessionAdditionalDirectory,
  type SessionSettings,
} from "../input/session-settings.js";
import {
  loadPicoConfig,
  parseModelProviderConfigs,
  type PicoProjectConfig,
} from "../input/pico-config.js";
import {
  EffectiveConfigResolver,
  ProviderIdConflictError,
  type ConfigSource,
} from "../input/effective-config.js";
import {
  parseUserConfig,
  UserConfigLockTimeoutError,
  UserConfigRevisionConflictError,
  UserConfigStore,
  type PicoUserConfig,
  type PicoUserConfigDefaults,
  type UserConfigSnapshot,
} from "../input/user-config-store.js";
import { renderAgentDispatchPrompt } from "../input/agent-activation.js";
import { renderSkillActivation } from "../input/skill-activation.js";
import { initializeProjectEntrypoints } from "../input/project-initializer.js";
import { CostTracker } from "../observability/tracker.js";
import { logger } from "../observability/logger.js";
import { summarizeCacheEffectiveness } from "../observability/cache-effectiveness.js";
import { ensureSessionUsageBaseline } from "../observability/usage-baseline.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import {
  type ModelProviderConfig,
  type ModelRoute,
  type ModelRouter,
} from "../provider/model-router.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../provider/effective-model-runtime.js";
import {
  CredentialNotFoundError,
  assertCredentialRefMatchesModelRoute,
  assertCredentialRefMatchesProvider,
  createPlatformCredentialVault,
  credentialRefForProvider,
  importProviderCredential,
  normalizeProviderEndpoint,
  parseAnyCredentialRef,
  parseProviderCredentialRef,
  type CredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { resolveProviderProfile } from "../provider/profile.js";
import {
  ProviderOperationJournal,
  type ProviderOperationRecord,
} from "../provider/provider-operation-journal.js";
import {
  canonicalizeWorkspacePath as canonicalizeManifestWorkspaceForm,
  resolvePicoHome,
  resolvePicoPaths,
} from "../paths/pico-paths.js";
import {
  readExistingSqliteSessionEventSlice,
  SqliteRuntimeEventStore,
  type SqliteSessionCatalogEntry,
} from "../storage/sqlite/sqlite-runtime-event-store.js";
import { SqliteRuntimeControlStore } from "../storage/sqlite/sqlite-runtime-control-store.js";
import {
  SqliteSessionWorkbarRepository,
  WorkbarConflictError,
  WorkbarForbiddenError,
  WorkbarNotFoundError,
} from "../storage/sqlite/sqlite-session-workbar-repository.js";
import { RuntimeRun } from "../runtime/runtime-run.js";
import { createEngineRuntimePort } from "../runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../runtime/session-fork-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { FileHistoryFilePatch } from "../safety/file-history.js";
import {
  fileHistoryChanges,
  fileHistoryRestoreFile,
  type FileHistoryChanges,
} from "../safety/file-history.js";
import type {
  ProviderCallRecord,
  UsageBaselineRecord,
  UsageLedgerTotals,
} from "../tasks/runtime-types.js";
import {
  createRuntimeNotification,
  createRuntimeRequest,
  isJsonValue,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type JsonObject,
  type RuntimeNotification,
  type RuntimeNotificationMap,
  type RuntimeNotificationPage,
  type RuntimeNotificationTopic,
  type RuntimeInputAttachment,
  type RuntimeRequest,
  type RuntimeQueuedInput,
  type RuntimeRun as RuntimeRunRecord,
  type RuntimeSession,
  type RuntimeProviderInput,
  type RuntimeUserDefaults,
  type RuntimeUserInput,
} from "./protocol.js";
import type {
  DisposableLocalRuntimeService,
  RuntimeNotificationCursor,
  ShutdownOwnershipFence,
} from "./service.js";
import type { DesktopConversationStateStoreLike } from "./desktop-conversation-state.js";
import { SqliteDesktopConversationStateStore } from "../storage/sqlite/sqlite-desktop-conversation-state-store.js";
import type { PlanControlPort } from "./plan-control-port.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import { createDesktopProviderRequestHandlers } from "./desktop-provider-request-handlers.js";
import { createDesktopCatalogRequestHandlers } from "./desktop-catalog-request-handlers.js";
import { createDesktopAutomationRequestHandlers } from "./desktop-automation-request-handlers.js";
import { canonicalizeWorkspacePath, resolveGitBranch } from "./workspace-registry.js";

/**
 * manifest.workDir 的写入侧（engine 经 pico-paths 的 canonicalizeWorkspacePath）
 * 与本服务读取校验侧（workspace-registry 的同名函数）是两套规范化：前者在
 * win32 上小写化物理路径，后者保留大小写并解析 git 顶��——两者在 Windows
 * 上凡路径含大写即分叉，会话归属校验必然误判（3-D 冒烟首次触发的既有 bug）。
 * 归属比较必须用写入侧的规范化形态复现：registry canonical → pico-paths 形态。
 */
function manifestWorkspaceForm(registryCanonical: string): string {
  return canonicalizeManifestWorkspaceForm(registryCanonical);
}

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
import {
  WorkspaceRuntimeService,
  workspaceStatusResult,
  type DaemonRunExecution,
} from "./workspace-runtime-service.js";
import type { WorkspaceStatusResult } from "./protocol.js";
import {
  DesktopAutomationService,
  type AutomationProviderReference,
  type ActiveAutomationReference,
} from "./desktop-automation-service.js";
import {
  assertDesktopChangesComplete,
  assertDesktopChangesFingerprint,
  projectDesktopCheckpoint,
  projectDesktopRewindFingerprints,
  type DesktopCheckpointProjection,
} from "./desktop-review.js";
import {
  ingestDesktopRuntimeNotification,
  isDesktopTranscriptNotification,
} from "./desktop-transcript-persistence.js";
import type { TranscriptEvent } from "../presentation/transcript-event-store.js";
import { PluginRuntimeSnapshotRegistry } from "../plugins/plugin-runtime-snapshot-registry.js";
import { PluginCapabilityActivationScope } from "../plugins/plugin-capability.js";
import { activatePluginProviderCapabilities } from "../plugins/plugin-provider-activation.js";
import { UserMcpConfigStore } from "../mcp/user-config-store.js";
import { DesktopRequestRouter, type DesktopRequestHandlers } from "./desktop-request-router.js";
import { createDesktopSessionRequestHandlers } from "./desktop-session-request-handlers.js";
import { TemporaryWorkspaceAuthority } from "./temporary-workspace-authority.js";
import { createDesktopMemoryRequestHandlers } from "./desktop-memory-request-handlers.js";
import { createDesktopWorkbarRequestHandlers } from "./desktop-workbar-request-handlers.js";
import { DesktopWorkbarGitReviewService } from "./desktop-workbar-git-review-service.js";
import { DesktopWorkbarTerminalService } from "./desktop-workbar-terminal-service.js";
import { WorkbarGitReviewError } from "./workbar-git-review.js";
import { SideChatAuthority, SideChatNoSettledTurnError } from "./side-chat-authority.js";
import { DesktopMemoryService } from "./desktop-memory-service.js";
import type { ImagePart } from "../schema/message.js";
import { createModelContextReport } from "../provider/model-runtime-report.js";
import { createSessionHookRuntime } from "../hooks/runtime.js";
import { PluginManagementService } from "../plugins/plugin-management-service.js";
import {
  BrowserAgentBrokerError,
  BrowserAgentCommandBroker,
} from "./browser-agent-command-broker.js";

const UNSUPPORTED_DESKTOP_METHODS: ReadonlySet<string> = new Set([
  "approval.respond",
  "prompt.respond",
  "config.update",
] as const);

interface ResolvedRuntimeUserInput {
  readonly prompt: string;
  readonly execution?: DaemonRunExecution;
  /** text 输入的图片附件（3-D 漏账补齐）：daemon 走 resumeExistingSession，
   * 用户消息由本层 commit——附件必须挂在本层而非 engine executor。 */
  readonly images?: ImagePart[];
}

export interface DesktopRuntimeServiceOptions {
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
  readonly memoryService?: DesktopMemoryService;
  readonly ownsMemoryService?: boolean;
  /** Commit 完成后通知 Dedicated Session Channel 读取已提交水位。 */
  readonly onTranscriptAdvanced?: (workspacePath: string, sessionId: string) => void;
  readonly browserAgentBroker?: BrowserAgentCommandBroker;
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
  private readonly userConfigStore: UserConfigStore;
  private readonly userMcpConfigStore: UserMcpConfigStore;
  private readonly effectiveConfigResolver: EffectiveConfigResolver;
  private readonly credentialVault: CredentialVault;
  private readonly providerOperationJournal: ProviderOperationJournal;
  private readonly providerRecoveryReady: Promise<void>;
  private readonly createSessionId: () => string;
  private readonly now: () => number;
  private readonly pluginRuntimeSnapshotRegistry: PluginRuntimeSnapshotRegistry;
  private readonly ownsPluginRuntimeSnapshotRegistry: boolean;
  private readonly memoryService: DesktopMemoryService;
  private readonly ownsMemoryService: boolean;
  private readonly gitReviewService: DesktopWorkbarGitReviewService;
  private readonly terminalService: DesktopWorkbarTerminalService;
  private readonly requestRouter: DesktopRequestRouter;
  private readonly unsubscribeRuntimeEvents: () => void;
  private readonly userConfigWatchListener = () => this.scheduleUserConfigRefresh();
  private readonly userConfigWatchReady: Promise<void>;
  private readonly pendingSends = new Map<
    string,
    { readonly requestFingerprint: string; readonly promise: Promise<JsonObject> }
  >();
  private readonly inFlightHandles = new Set<Promise<JsonValue>>();
  private transcriptPersistenceTail: Promise<void> = Promise.resolve();
  private userConfigWatchTail: Promise<void> = Promise.resolve();
  /** Serializes operations that can create or remove live Provider dependencies. */
  private providerDependencyTail: Promise<void> = Promise.resolve();
  private providerRecoveryError?: unknown;
  private userConfigWatchTimer?: NodeJS.Timeout;
  private observedUserConfig?: UserConfigSnapshot;
  private userConfigWatchClosed = false;
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private queuedInputDispatchTail: Promise<void> = Promise.resolve();
  private resourceVersion = 0;
  private readonly browserAgentBroker: BrowserAgentCommandBroker;

  constructor(private readonly options: DesktopRuntimeServiceOptions) {
    this.env = options.env ?? process.env;
    // Test embedders commonly inject only model credentials. Treat a missing PICO_HOME
    // as an overlay omission, while still freezing an explicitly supplied host state root.
    this.picoHome = resolvePicoHome({ picoHome: this.env["PICO_HOME"] });
    this.gitReviewService = new DesktopWorkbarGitReviewService();
    this.terminalService = new DesktopWorkbarTerminalService({ picoHome: this.picoHome });
    this.browserAgentBroker = options.browserAgentBroker ?? new BrowserAgentCommandBroker();
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
    this.userConfigStore =
      options.userConfigStore ?? new UserConfigStore({ picoHome: this.picoHome });
    this.userMcpConfigStore =
      options.userMcpConfigStore ?? new UserMcpConfigStore({ picoHome: this.picoHome });
    this.effectiveConfigResolver =
      options.effectiveConfigResolver ??
      new EffectiveConfigResolver({ userConfigStore: this.userConfigStore });
    this.credentialVault =
      options.credentialVault ?? createPlatformCredentialVault(process.platform, this.env);
    this.providerOperationJournal =
      options.providerOperationJournal ??
      new ProviderOperationJournal({ picoHome: this.picoHome, parseUserConfig });
    this.createSessionId = options.createSessionId ?? createCliSessionId;
    this.now = options.now ?? Date.now;
    this.pluginRuntimeSnapshotRegistry =
      options.pluginRuntimeSnapshotRegistry ??
      new PluginRuntimeSnapshotRegistry({ env: this.env, picoHome: this.picoHome });
    this.ownsPluginRuntimeSnapshotRegistry =
      options.ownsPluginRuntimeSnapshotRegistry ??
      options.pluginRuntimeSnapshotRegistry === undefined;
    this.memoryService =
      options.memoryService ??
      new DesktopMemoryService({
        picoHome: this.picoHome,
        publish: (workspacePath, topic, payload) =>
          this.publishMemoryNotification(workspacePath, topic, payload),
        onDegraded: ({ code, workspaceId, operationId, error }) =>
          logger.warn(
            { code, workspaceId, operationId, error },
            "Workspace memory maintenance deferred",
          ),
      });
    this.ownsMemoryService = options.ownsMemoryService ?? options.memoryService === undefined;
    this.providerRecoveryReady = this.recoverProviderOperation().catch((error: unknown) => {
      this.providerRecoveryError = error;
    });
    this.userConfigWatchReady = this.startUserConfigWatch();
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
      const transcriptReady = this.transcriptPersistenceTail;
      const dispatch = async () => {
        await transcriptReady.catch(() => undefined);
        if (this.lifecycleState !== "open") return;
        await this.consumeNextQueued(event.scope.workspacePath, sessionId);
      };
      const queued = this.queuedInputDispatchTail.then(dispatch, dispatch);
      this.queuedInputDispatchTail = queued.then(
        () => undefined,
        () => undefined,
      );
      void queued.catch((error: unknown) => {
        if (this.lifecycleState === "open") {
          this.publishConversationFailure(event.scope.workspacePath, error);
        }
      });
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
  }

  handle(request: RuntimeRequest): Promise<JsonValue> {
    try {
      this.assertAcceptingRequests();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.dispatchRequest(request);
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

  private createRequestHandlers(): DesktopRequestHandlers {
    return {
      "diagnostics.run": (request) => this.runDiagnostics(request.params.workspacePath),
      "diagnostics.resources": (request) =>
        this.runResourceDiagnostics(request.params.workspacePath),
      "config.get": (request) => this.getConfig(request.params.workspacePath),
      "config.providers": (request) => this.listProviders(request.params.workspacePath),
      "config.effective.get": (request) => this.getEffectiveConfig(request.params),
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
      "rewind.apply": (request) => this.applyRewind(request.params),
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
      "approval.respond": (request) => {
        if (!this.options.interactions) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
          );
        }
        return this.options.interactions.respondApproval(request.params);
      },
      "plan.respond": async (request) => {
        if (!this.options.planControl) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接持久化 PlanControlPort，本次请求未执行`,
          );
        }
        const result = await this.options.planControl.respond(request.params);
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
        getUserConfig: this.getUserConfig.bind(this),
        updateUserConfig: this.updateUserConfig.bind(this),
        listUserProviders: this.listUserProviders.bind(this),
        upsertUserProvider: this.upsertUserProvider.bind(this),
        importEnvironmentProvider: this.importEnvironmentProvider.bind(this),
        deleteUserProvider: this.deleteUserProvider.bind(this),
        getProviderCredentialStatus: this.getProviderCredentialStatus.bind(this),
        setProviderCredential: this.setProviderCredential.bind(this),
        deleteProviderCredential: this.deleteProviderCredential.bind(this),
        withProviderDependencyLock: (operation) => this.withProviderDependencyLock(operation),
      }),
      ...createDesktopCatalogRequestHandlers({
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
        automations: this.options.automations,
        credentialVault: this.credentialVault,
        effectiveConfigResolver: this.effectiveConfigResolver,
        userConfigStore: this.userConfigStore,
        pluginRuntimeSnapshotRegistry: this.pluginRuntimeSnapshotRegistry,
        env: this.env,
        now: this.now,
        requireTrustedWorkspace: this.requireTrustedWorkspace.bind(this),
        publishJob: this.publishJob.bind(this),
        withProviderDependencyLock: (operation) => this.withProviderDependencyLock(operation),
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
        compactSession: this.compactSession.bind(this),
        getRuntimeSessionSettings: this.getRuntimeSessionSettings.bind(this),
        getSessionContextReport: this.getSessionContextReport.bind(this),
        addSessionDirectory: this.addSessionDirectory.bind(this),
        updateRuntimeSessionSettings: this.updateRuntimeSessionSettings.bind(this),
        getGoal: this.getGoal.bind(this),
        sendSession: this.sendSession.bind(this),
        readSessionEvidence: this.readSessionEvidence.bind(this),
        cancelRun: this.cancelRun.bind(this),
        withProviderDependencyLock: (operation) => this.withProviderDependencyLock(operation),
        runStart: (request) => this.options.runtimeService.handle(request),
      }),
      ...createDesktopWorkbarRequestHandlers({
        "session.tasks.query": this.querySessionTasks.bind(this),
        "session.tasks.command": this.commandSessionTasks.bind(this),
        "session.artifacts.query": this.querySessionArtifacts.bind(this),
        "session.artifacts.command": this.commandSessionArtifacts.bind(this),
        "session.trace.query": this.querySessionTrace.bind(this),
      }),
      ...createDesktopMemoryRequestHandlers({
        list: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.list(canonical, params),
          ),
        get: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.get(canonical, params.factId),
          ),
        create: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.create(canonical, params.text),
          ),
        update: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.update(canonical, params),
          ),
        forget: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.forget(canonical, params),
          ),
        listReviews: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.listReviews(canonical, params),
          ),
        resolveReview: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.resolveReview(canonical, params),
          ),
        getSettings: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.getSettings(canonical),
          ),
        updateSettings: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.updateSettings(canonical, params),
          ),
        previewContext: (params) =>
          this.withTrustedMemory(params.workspacePath, (canonical) =>
            this.memoryService.previewContext(canonical, params),
          ),
      }),
    };
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

  /** Metadata half of the atomic Runtime Host session subscription snapshot. */
  async readSessionContinuityMetadata(
    workspacePath: string,
    sessionId: string,
  ): Promise<{
    readonly session: RuntimeSession;
    readonly queuedInputs: readonly RuntimeQueuedInput[];
    readonly activeRun?: RuntimeRunRecord;
  }> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    await this.transcriptPersistenceTail;
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
    return { session, queuedInputs, ...(activeRun ? { activeRun } : {}) };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeOnce();
    return this.closePromise;
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
    this.userConfigWatchClosed = true;
    if (this.userConfigWatchTimer) clearTimeout(this.userConfigWatchTimer);
    unwatchFile(this.userConfigStore.filePath, this.userConfigWatchListener);
    await this.userConfigWatchReady.catch(() => undefined);
    await this.userConfigWatchTail.catch(() => undefined);
    await this.providerDependencyTail.catch(() => undefined);
    await Promise.allSettled([...this.pendingSends.values()].map(({ promise }) => promise));
    await this.queuedInputDispatchTail.catch(() => undefined);
    await Promise.allSettled([...this.inFlightHandles]);
    // Workspace shutdown emits the terminal boundary for every active foreground Run.
    // Keep the projection subscriber and RuntimeStore alive until those events are projected.
    try {
      await attempt(() => this.options.runtimeService.closeRuntimes());
      await attempt(() => this.transcriptPersistenceTail);
      this.unsubscribeRuntimeEvents();
      await attempt(() => this.options.runtimeService.close());
      if (this.ownsPluginRuntimeSnapshotRegistry) {
        await attempt(() => this.pluginRuntimeSnapshotRegistry.dispose());
      }
      if (this.ownsMemoryService) await attempt(() => this.memoryService.close());
      await attempt(() => this.terminalService.close());
      this.browserAgentBroker.close();
    } finally {
      this.lifecycleState = "closed";
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Desktop Runtime cleanup failed");
    }
  }

  private async listWorkspaces(): Promise<JsonValue> {
    const workspaces = await Promise.all(
      (await this.registrationStore.list()).map(async (workspacePath) => {
        // 注册项可能指向已删除的目录（崩溃的���试/客户端残留；注册表 list() 会
        // 过滤缺失目录，这里是过滤与物化之间的竞态护栏）。真机事故
        // （2026-08-16）：真 home 累积 54 个存活的 %TEMP% e2e 工作区，单次
        // workspace.list 物化全部 runtime 推过 kernel 操作 deadline，连接被
        // 整条拆断——根治在 e2e 隔离 daemon root，这里保证残留永不致命。
        if (!existsSync(workspacePath)) {
          return this.decorateWorkspaceStatus({
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
          } satisfies WorkspaceStatusResult);
        }
        try {
          const runtime = await this.options.runtimeService.getWorkspaceRuntime(workspacePath);
          return this.decorateWorkspaceStatus(
            workspaceStatusResult(
              runtime,
              true,
              runtime.mode === "git" ? await resolveGitBranch(runtime.workspace) : undefined,
            ),
          );
        } catch (error) {
          // A registered workspace may still contain storage from an unsupported era.
          // Listing is the Desktop bootstrap boundary: one unavailable workspace must
          // remain discoverable without preventing every other workspace from opening.
          logger.warn({ workspacePath, err: error }, "Workspace status materialization failed");
          return this.decorateWorkspaceStatus(unavailableWorkspaceStatus(workspacePath));
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

  private decorateWorkspaceStatus(status: WorkspaceStatusResult): WorkspaceStatusResult {
    return this.temporaryWorkspace.matches(status.workspacePath)
      ? { ...status, temporary: true }
      : status;
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
        picoHome: this.picoHome,
        provider: defaults.provider,
        model: defaults.model,
        env: this.env,
        taskRuntimeAvailable: true,
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

  private async listSessions(workspacePath: string, includeArchived = false): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const sideChats = this.sideChatAuthority(canonical);
    await sideChats.recover();
    const hiddenSessionIds = new Set(sideChats.list().map((lease) => lease.targetSessionId));
    // 归档/置顶已并入 sessions 表(catalog 投影行),desktop session-state.json 退役。
    const entries = await listCliSessionCatalogEntries(canonical, { picoHome: this.picoHome });
    const sessions = entries
      .filter(
        (entry) =>
          !hiddenSessionIds.has(entry.summary.id) && (includeArchived || !entry.isArchived),
      )
      .map((entry) => sessionPayload(entry));
    return { sessions };
  }

  private async getSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    return { session: await this.requireSession(canonical, sessionId) };
  }

  private async createSession(
    workspacePath: string,
    title?: string,
    sessionId = createCliSessionId(),
  ): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const session = new Session(sessionId, canonical, {
      persistence: true,
      picoHome: this.picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      await session.recover();
      if (title !== undefined) {
        const settings = await this.getSessionSettings(canonical, session);
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
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    await this.requireSession(canonical, sessionId);
    await this.withWorkspaceSessionStore(canonical, (store) =>
      store.setSessionArchived(sessionId, archived, this.now),
    );
    if (archived) this.browserAgentBroker.invalidateSession(sessionId, "浏览器 Session 已归档");
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private async setSessionPinned(
    workspacePath: string,
    sessionId: string,
    pinned: boolean,
  ): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    await this.requireSession(canonical, sessionId);
    await this.withWorkspaceSessionStore(canonical, (store) =>
      store.setSessionPinned(sessionId, pinned, this.now),
    );
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private async deleteSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "删除");
    const sideChats = this.sideChatAuthority(canonical);
    await sideChats.recover();
    const leases = sideChats.list();
    if (leases.some((lease) => lease.targetSessionId === sessionId)) {
      this.browserAgentBroker.invalidateSession(sessionId);
      await sideChats.cleanup(sessionId);
      return { sessionId, deleted: true };
    }
    const childLeases = leases.filter((candidate) => candidate.sourceSessionId === sessionId);
    for (const lease of childLeases) {
      this.browserAgentBroker.invalidateSession(lease.targetSessionId);
      await sideChats.cleanup(lease.targetSessionId);
    }
    this.browserAgentBroker.invalidateSession(sessionId);
    await this.terminalService.stopSession({ workspacePath: canonical, sessionId });
    const preparedMemory = this.memoryService.prepareSessionSourceInvalidation(
      canonical,
      sessionId,
      { availability: "unavailable", code: "session_deleted" },
    );
    try {
      const managed = globalSessionManager.delete(sessionId, canonical, {
        picoHome: this.picoHome,
      });
      await managed?.close();
      await Promise.all([
        removeCliSessionFile(canonical, sessionId, { picoHome: this.picoHome }),
        this.conversationStateStore.clearQueued(canonical, sessionId),
      ]);
      this.workbarRepository(canonical).purgeOrphanArtifactBlobs();
    } catch (error) {
      // Once destructive work starts, a rejection may represent partial durable success.
      // Fail closed for privacy and converge source/proposal state through the prepared job.
      this.memoryService.commitSessionSourceInvalidation(preparedMemory);
      throw error;
    }
    this.memoryService.commitSessionSourceInvalidation(preparedMemory);
    return {
      sessionId,
      deleted: true,
      ...(childLeases.length > 0
        ? { closedSessionIds: childLeases.map((lease) => lease.targetSessionId) }
        : {}),
    };
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
      await new SessionForkService({
        workDir: canonical,
        picoHome: this.picoHome,
        runtimePort: createSessionForkRuntimePort(),
      }).fork({
        sourceSessionId: sessionId,
        targetSessionId,
        targetMode:
          sourceLease.session.getRuntimeStateSnapshot().settings?.mode ?? DEFAULT_INTERACTION_MODE,
      });
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

  private async createSideChat(
    params: RuntimeRequest<"sideChat.create">["params"],
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(
      params.workspacePath,
      params.sourceSessionId,
    );
    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
    });
    let sourceEvents;
    try {
      sourceEvents = await store.readSession(params.sourceSessionId);
    } finally {
      store.close();
    }
    const authority = this.sideChatAuthority(canonical);
    await authority.recover();
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
  ): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(params.workspacePath);
    this.browserAgentBroker.invalidateSession(params.sessionId);
    await this.sideChatAuthority(canonical).cleanup(params.sessionId);
    return { cleanupScheduled: true };
  }

  private async getRuntimeSessionSettings(
    workspacePath: string,
    sessionId: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session);
      const router = await this.getSessionModelRouter(canonical, settings);
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
    readonly mode?: string;
    readonly permissions?: string;
    readonly thinkingEffort?: string;
  }): Promise<JsonValue> {
    if (
      params.modelRouteId === undefined &&
      params.collaborationMode === undefined &&
      params.orchestrationMode === undefined &&
      params.permissionMode === undefined &&
      params.mode === undefined &&
      params.permissions === undefined &&
      params.thinkingEffort === undefined
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "session.settings.update 至少需要一个设置字段",
      );
    }
    const legacyMode = normalizeInteractionMode(params.mode ?? params.permissions);
    const requestedCollaborationMode =
      params.collaborationMode ?? (legacyMode === "plan" ? "plan" : undefined);
    const requestedPermissionMode =
      params.permissionMode ?? (legacyMode && legacyMode !== "plan" ? legacyMode : undefined);
    const requestedOrchestrationMode = params.orchestrationMode;
    if ((params.mode !== undefined || params.permissions !== undefined) && !legacyMode) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "mode/permissions 必须是 default、plan、auto 或 yolo",
      );
    }
    if (
      params.mode !== undefined &&
      params.permissions !== undefined &&
      normalizeInteractionMode(params.mode) !== normalizeInteractionMode(params.permissions)
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "permissions 是 mode 的别名，二者不能指定不同值",
      );
    }
    if (
      requestedCollaborationMode !== undefined &&
      requestedCollaborationMode !== "agent" &&
      requestedCollaborationMode !== "plan"
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "collaborationMode 必须是 agent 或 plan",
      );
    }
    if (
      requestedOrchestrationMode !== undefined &&
      requestedOrchestrationMode !== "default" &&
      requestedOrchestrationMode !== "graph"
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "orchestrationMode 必须是 default 或 graph",
      );
    }
    if (
      requestedPermissionMode !== undefined &&
      requestedPermissionMode !== "default" &&
      requestedPermissionMode !== "auto" &&
      requestedPermissionMode !== "yolo"
    ) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "permissionMode 必须是 default、auto 或 yolo",
      );
    }

    const canonical = await this.requireIdleTrustedSession(
      params.workspacePath,
      params.sessionId,
      "修改会话设置",
    );
    const settings = await this.withSession(canonical, params.sessionId, async (session) => {
      const current = await this.getSessionSettings(canonical, session);
      if (
        requestedCollaborationMode === "agent" &&
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
      const router = await this.getSessionModelRouter(canonical, current);
      const selectedRoute = resolveRequestedModelRoute(router, params.modelRouteId);
      if (params.thinkingEffort !== undefined) {
        validateRequestedThinkingEffort(
          selectedRoute ?? resolveCurrentModelRoute(router, current),
          params.thinkingEffort,
        );
      }

      if (selectedRoute) migrateSessionModelRoute(current, selectedRoute);
      if (requestedCollaborationMode) {
        const result = setSessionCollaborationMode(current, requestedCollaborationMode);
        if (!result.ok) throw invalidSessionSetting(result.message);
      }
      if (requestedOrchestrationMode) {
        const result = setSessionOrchestrationMode(
          current,
          requestedOrchestrationMode as "default" | "graph",
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
      return runtimeSessionSettings(current, router);
    });
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
      const settings = await this.getSessionSettings(canonical, session);
      const runtime = await this.loadSessionModelRuntime(canonical, settings);
      const route = runtime.router.require(settings.modelRouteId);
      const traceWatermark = this.workbarRepository(canonical).queryTrace({
        sessionId,
        limit: 1,
      }).throughSequence;
      return toJsonValue({
        context: {
          ...createModelContextReport(route, session.getHistory()),
          version: 2,
          sessionId,
          generatedAt: this.now(),
          traceWatermark,
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
      this.publishWorkbarResource(canonical, params.sessionId, "artifacts", {
        revision: typeof result.revision === "number" ? result.revision : undefined,
      });
    }
    return toJsonValue(result);
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

  private async getGoal(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withSession(canonical, sessionId, async (session) => {
      const hydration = await session.readHydrationSnapshot();
      return { goal: hydration.runtime.goal ? toJsonValue(hydration.runtime.goal) : null };
    });
  }

  private async compactSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(workspacePath, sessionId, "压缩");
    const result = await this.withSession(canonical, sessionId, async (session) => {
      const settings = await this.getSessionSettings(canonical, session);
      const effective = await this.loadSessionModelRuntime(canonical, settings);
      const active = effective.router.providerConfig(settings.modelRouteId);
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
        ensureSessionUsageBaseline(ledger, session);
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
        });
        const checkpoint = await runtimeRun.run(async () => {
          const entries = await runtimeRun.readModelHistoryEntries();
          const historyTokens = estimateMessagesTokens(entries.map(({ message }) => message));
          const result = await recordRuntimeCompactionCheckpoint({
            session,
            runtimeRun,
            compactor: new FullCompactor({ provider }),
            request: {
              inputBudgetTokens: budget.inputBudgetTokens,
              targetRetainedTokens: Math.max(
                1,
                Math.min(
                  Math.floor(budget.inputBudgetTokens * 0.5),
                  Math.floor(historyTokens * 0.5),
                ),
              ),
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
  }): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(params.workspacePath);
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
    const operation = this.sendSessionOnce({ ...params, workspacePath: canonical, input })
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
      );
    }
    const sessionRecord = requireJsonRecord(session, "session");
    const sessionId = requireText(sessionRecord["sessionId"], "session.sessionId");
    const activeRun = await this.findActiveSessionRun(params.workspacePath, sessionId);

    if (!params.sessionId && params.initialSettings && !activeRun) {
      await this.updateRuntimeSessionSettings({
        workspacePath: params.workspacePath,
        sessionId,
        ...params.initialSettings,
      });
    }

    if (params.expectedRunId !== undefined && activeRun?.["runId"] !== params.expectedRunId) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `当前活动 Run 已变化，期望 ${params.expectedRunId}，实际 ${String(activeRun?.["runId"] ?? "none")}`,
      );
    }

    if (activeRun) {
      const runId = requireText(activeRun["runId"], "run.runId");
      const activation = params.input.kind === "agent" || params.input.kind === "skill";
      if (activation && behavior === "steer") {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "Agent/Skill 激活必须在新 Run 中应用；请选择 Queue 或 Replace",
        );
      }
      if (activation) await this.resolveRuntimeUserInput(params.workspacePath, params.input);
      if (behavior === "queue" || behavior === "replace" || activation) {
        await this.conversationStateStore.enqueue(params.workspacePath, sessionId, params.input);
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
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "无法 Steer 非文本输入");
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

    if (behavior === "steer" && params.expectedRunId !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        "目标 Run 已结束，无法继续 Steer；请作为下一轮发送",
      );
    }
    const run = await this.startSessionRun(
      params.workspacePath,
      sessionId,
      params.input,
      initialResolution,
      {
        inputKey: params.idempotencyKey,
        runStartKey: desktopRunStartIdempotencyKey("send", params.idempotencyKey),
      },
    );
    return { session: sessionRecord, run, disposition: "started" };
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
      const canonical = await canonicalizeWorkspacePath(workspacePath);
      await this.conversationStateStore.clearQueued(canonical, sessionId);
    }
    return result;
  }

  private async readSessionEvidence(
    params: RuntimeRequest<"session.evidence.read">["params"],
  ): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(params.workspacePath);
    await this.requireSession(canonical, params.sessionId);
    // 票 04:evidence 授权点查只消费 tool.result.recorded(跨可见度的 active
    // ToolResult 投影),kind 切片 + manifest,不再全量投影。
    // 票 E3(ADR 26 §2.4):Evidence 回读协议已退役,本 RPC 降级为旧
    // `storage:"evidence"` 事件的诊断分页读——新会话不再产生 evidence 引用。
    const sliceSnapshot = await readExistingSqliteSessionEventSlice({
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
      sessionId: params.sessionId,
      kinds: ["tool.result.recorded"],
    });
    if (!sliceSnapshot || sliceSnapshot.manifest.workDir !== manifestWorkspaceForm(canonical)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Session ${params.sessionId} 不属于工作区 ${canonical}`,
      );
    }

    let uriReference;
    try {
      uriReference = parseEvidenceUri(params.evidenceUri);
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        error instanceof Error ? error.message : String(error),
      );
    }
    // Fork 会保留 source-session Evidence ref。授权边界不是 URI 内的 sessionId，
    // 而是当前 active branch 是否确实包含引用它的 canonical ToolResult。
    const reference = projectRuntimeSessionActiveToolResultEntries(sliceSnapshot.slice.entries)
      .map(({ envelope }) => envelope.evidence?.ref)
      .find(
        (candidate) =>
          candidate?.sessionId === uriReference.sessionId &&
          candidate.contentHash === uriReference.contentHash &&
          candidate.kind === "tool-exchange",
      );
    if (!reference) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        "当前 Session 未引用该 Evidence",
      );
    }
    const page = await new EvidenceArchive({
      baseDir: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.evidence,
    }).readEvidencePage(reference, {
      ...(params.offsetBytes !== undefined ? { offsetBytes: params.offsetBytes } : {}),
      ...(params.limitBytes !== undefined ? { limitBytes: params.limitBytes } : {}),
    });
    if (page.kind !== "tool-exchange") {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        "Evidence 不是 ToolResult exchange",
      );
    }
    return {
      evidenceUri: params.evidenceUri,
      content: page.content,
      offsetBytes: page.offsetBytes,
      endOffsetBytes: page.endOffsetBytes,
      totalBytes: page.totalBytes,
      limitBytes: page.limitBytes,
      truncated: page.truncated,
      ...(page.nextOffsetBytes !== undefined ? { nextOffsetBytes: page.nextOffsetBytes } : {}),
    };
  }

  private async ensureSessionForMessage(
    workspacePath: string,
    message: string,
    sessionId: string,
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
      await this.createSession(workspacePath, title, sessionId),
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
      await this.commitSessionInputOnce(
        workspacePath,
        sessionId,
        resolved.prompt,
        runtimeInputDisplay(input),
        input,
        identity.inputKey,
        resolved.images,
      );
      return requireJsonRecord(
        await this.options.runtimeService.startForegroundRun({
          workspacePath,
          sessionId,
          prompt: resolved.prompt,
          execution: { ...(resolved.execution ?? {}), resumeExistingSession: true },
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
  ): Promise<void> {
    const digest = createHash("sha256")
      .update(`${workspacePath}\0${sessionId}\0${idempotencyKey}`)
      .digest("hex");
    const messageId = `desktop-input:${digest}`;
    await this.withSession(workspacePath, sessionId, async (session) => {
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
  }

  private async consumeNextQueued(workspacePath: string, sessionId: string): Promise<void> {
    if (this.lifecycleState !== "open") return;
    const [next] = await this.conversationStateStore.listQueued(workspacePath, sessionId);
    if (!next) return;
    if (await this.findActiveSessionRun(workspacePath, sessionId)) return;
    // 队列准入线性化点：通过后 close() 会等待 queuedInputDispatchTail，允许本项完整启动并出队。
    if (this.lifecycleState !== "open") return;
    await this.startSessionRun(workspacePath, sessionId, next.input, undefined, {
      inputKey: next.queueId,
      runStartKey: desktopRunStartIdempotencyKey("queue", next.queueId),
    });
    await this.conversationStateStore.removeQueued(workspacePath, next.queueId);
  }

  private async persistRuntimeNotification(event: RuntimeNotification): Promise<void> {
    const sessionId = event.scope.sessionId;
    if (!sessionId) return;
    const persisted = await this.withSession(event.scope.workspacePath, sessionId, (session) =>
      ingestDesktopRuntimeNotification(session, event),
    );
    if (persisted) this.publishTranscriptUpdate(event.scope.workspacePath, sessionId, "reload");
  }

  private async resolveRuntimeUserInput(
    workspacePath: string,
    input: RuntimeUserInput,
  ): Promise<ResolvedRuntimeUserInput> {
    if (input.kind === "text") {
      const images = inputAttachmentsToImages(input.attachments);
      return { prompt: input.text, ...(images ? { images } : {}) };
    }
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await this.pluginRuntimeSnapshotRegistry.get(canonical);
    const config = await loadPicoConfig(canonical);
    const compatibility = config.compatibility.claude;
    if (input.kind === "agent") {
      const profiles = await loadAgentCatalog({
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
        execution: { allowedTools: ["delegate_task"] },
      };
    }
    const skillName = requireText(input["name"], "input.name");
    const skillArgs = typeof input["args"] === "string" ? input["args"] : "";
    const loader = new SkillLoader(canonical, {
      includeUserResources: true,
      includeClaudeProjectResources: compatibility.enabled && compatibility.projectResources,
      includeClaudeUserResources: compatibility.enabled && compatibility.userResources,
      ...(pluginSnapshot.skillSources ? { externalSources: pluginSnapshot.skillSources } : {}),
      env: this.env,
      picoHome: this.picoHome,
    });
    const skill = await loader.view(skillName);
    if (!skill) {
      const available = (await loader.listSummaries()).map((item) => item.name).join(", ");
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `未找到 Skill: ${skillName}。可用 Skills: ${available || "none"}`,
      );
    }
    const activation = renderSkillActivation({
      name: skill.name,
      args: skillArgs,
      body: skill.body,
      sourcePath: skill.sourcePath,
      trigger: "user-slash",
    });
    const execution: DaemonRunExecution = {
      ...(skill.model ? { requestedModel: skill.model } : {}),
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      ...(skill.sourcePath && skill.hooks !== undefined
        ? {
            skillActivation: {
              name: skill.name,
              sourcePath: skill.sourcePath,
              hooks: skill.hooks,
              ...(skill.source?.id ? { sourceId: skill.source.id } : {}),
            },
          }
        : {}),
    };
    return {
      prompt: activation.prompt,
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
    return sessionPayload(entry);
  }

  /** 归档/置顶等 sessions 表级写:短生命周期打开 workspace 级 SqliteRuntimeEventStore。 */
  private async withWorkspaceSessionStore<Result>(
    workspacePath: string,
    write: (store: SqliteRuntimeEventStore) => Result | Promise<Result>,
  ): Promise<Result> {
    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root,
    });
    try {
      return await write(store);
    } finally {
      store.close();
    }
  }

  private async getConfig(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const [config, version] = await Promise.all([
      loadPicoConfig(canonical),
      configContentVersion(canonical),
    ]);
    return { config: safeConfig(config), version };
  }

  private async listProviders(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const config = await loadPicoConfig(canonical);
    return {
      providers: toJsonValue(
        Object.entries(config.providers).map(([id, provider]) =>
          runtimeProviderInput(id, provider),
        ),
      ),
    };
  }

  private async getUserConfig(params: unknown): Promise<JsonValue> {
    assertExactObjectKeys(params, [], "config.user.get params");
    const snapshot = await this.userConfigStore.read();
    return {
      config: runtimeUserConfig(snapshot.config),
      revision: this.projectUserConfigRevision(snapshot.revision),
    };
  }

  private async updateUserConfig(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["defaults", "expectedRevision"],
      "config.user.update params",
    );
    const defaults = normalizeRuntimeUserDefaults(record["defaults"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        providers: current.config.providers,
      },
      "config.user.update",
    );
    assertUserDefaultRoute(next);
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, []);
    return {
      config: runtimeUserConfig(written.config),
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  private async getEffectiveConfig(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(params, ["workspacePath"], "config.effective.get params");
    const workspacePath = await this.requireTrustedWorkspace(
      requireText(record["workspacePath"], "workspacePath"),
    );
    let snapshot;
    try {
      snapshot = await this.effectiveConfigResolver.resolve({
        workDir: workspacePath,
        projectTrusted: true,
        env: this.env,
      });
    } catch (error) {
      if (error instanceof ProviderIdConflictError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      throw error;
    }
    const userProviders = (await this.userConfigStore.read()).config.providers;
    const providers = await Promise.all(
      Object.entries(snapshot.providers)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, provider]) => {
          const origin = providerOrigin(snapshot.sources[`providers.${id}`]);
          const userProvider = userProviders[id];
          const supportsSharedCredential =
            origin === "user" ||
            (userProvider !== undefined &&
              userProvider.protocol === provider.protocol &&
              sameProviderEndpoint(userProvider.baseURL, provider.baseURL));
          return this.projectProviderProfile(
            id,
            provider,
            origin,
            supportsSharedCredential,
            supportsSharedCredential && userProvider ? userProvider : provider,
          );
        }),
    );
    return {
      config: {
        ...(snapshot.defaultModelRouteId
          ? { defaultModelRouteId: snapshot.defaultModelRouteId }
          : {}),
        defaults: toJsonValue(snapshot.defaults),
        providers,
        sources: toJsonValue(snapshot.sources),
        revisions: {
          ...snapshot.revisions,
          user: this.projectUserConfigRevision(snapshot.revisions.user),
        },
      },
    };
  }

  private async listUserProviders(params: unknown): Promise<JsonValue> {
    assertExactObjectKeys(params, [], "provider.list params");
    const snapshot = await this.userConfigStore.read();
    const providers = await Promise.all(
      Object.entries(snapshot.config.providers)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, provider]) => this.projectProviderProfile(id, provider, "user")),
    );
    return { providers, revision: this.projectUserConfigRevision(snapshot.revision) };
  }

  private async upsertUserProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["provider", "expectedRevision"],
      "provider.upsert params",
    );
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const { id, config } = normalizeRuntimeProvider(record["provider"]);
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const previousProvider = current.config.providers[id];
    const workspacePaths = await this.registrationStore.list();
    this.assertProviderCompatibleWithAutomationReferences(
      id,
      config,
      this.options.automations?.providerReferences(id, workspacePaths) ?? [],
    );
    if (
      previousProvider &&
      (previousProvider.protocol !== config.protocol ||
        !sameProviderEndpoint(previousProvider.baseURL, config.baseURL))
    ) {
      await this.assertNoStoredCredentialBeforeAuthorityChange(id, previousProvider);
    }
    const nextProvider = retainConfiguredCredential(config, previousProvider);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [id]: nextProvider },
      },
      "provider.upsert",
    );
    assertUserDefaultRoute(next);
    const written = await this.writeUserConfig(next, current.revision);
    const provider = await this.projectProviderProfile(id, written.config.providers[id]!, "user");
    await this.publishUserConfigUpdated(written.revision, [id]);
    return { provider, revision: this.projectUserConfigRevision(written.revision) };
  }

  private async importEnvironmentProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["provider", "defaultModel", "secret", "expectedRevision"],
      "provider.importEnvironment params",
    );
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const { id, config } = normalizeRuntimeProvider(record["provider"]);
    const defaultModel = requireText(record["defaultModel"], "defaultModel");
    if (!config.models.includes(defaultModel)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `默认模型 ${defaultModel} 不在 Provider ${id} 的显式模型列表中`,
      );
    }
    const capability = this.credentialVault.capability();
    if (!capability.available) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FORBIDDEN, capability.diagnostic);
    }
    const secret = requireSecret(record["secret"]);
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const previousProvider = current.config.providers[id];
    if (previousProvider && !sameProviderAuthority(previousProvider, config)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 已使用不同的协议或 Endpoint，请先显式删除后再导入`,
      );
    }
    if (previousProvider && configuredCredential(previousProvider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 已在用户配置中保存 API Key，请先删除配置中的 Key 再导入旧版环境凭证`,
      );
    }
    const workspacePaths = await this.registrationStore.list();
    this.assertProviderCompatibleWithAutomationReferences(
      id,
      config,
      this.options.automations?.providerReferences(id, workspacePaths) ?? [],
    );
    const next = validatedUserConfig(
      {
        version: 1,
        defaults: {
          ...current.config.defaults,
          modelRouteId: current.config.defaults?.modelRouteId ?? `${id}/${defaultModel}`,
        },
        providers: { ...current.config.providers, [id]: config },
      },
      "provider.importEnvironment",
    );
    assertUserDefaultRoute(next);
    const credentialRef = credentialRefForProvider(providerCredentialIdentity(id, config));
    const pending = await this.providerOperationJournal.prepare({
      kind: "import",
      previousUserConfig: current.config,
      targetUserConfig: next,
      credentialRef,
      credentialExistedBefore: await this.credentialVault.has(credentialRef),
      configRevision: current.revision,
    });
    try {
      await importProviderCredential({
        provider: providerCredentialIdentity(id, config),
        secret,
        vault: this.credentialVault,
      });
      await this.providerOperationJournal.update(pending.operationId, {
        phase: "credential-imported",
      });
    } catch (error) {
      if (!pending.credentialExistedBefore) {
        await this.credentialVault.delete(credentialRef).catch(() => undefined);
      }
      await this.providerOperationJournal.clear(pending.operationId).catch(() => undefined);
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 凭证导入失败，用户配置尚未变更: ${redactedErrorMessage(error, secret)}`,
      );
    }
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
    const provider = await this.projectProviderProfile(id, written.config.providers[id]!, "user");
    await this.publishUserConfigUpdated(written.revision, [id]);
    return { provider, revision: this.projectUserConfigRevision(written.revision) };
  }

  private async deleteUserProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "expectedRevision"],
      "provider.delete params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    const provider = current.config.providers[providerId];
    if (!provider) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Provider ${providerId} 不存在`,
      );
    }
    this.assertUserConfigRevision(expectedRevision, current.revision);
    if (configuredCredential(provider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 已在用户配置中保存 API Key，请先删除配置中的 Key 再删除 Provider`,
      );
    }
    if (providerIdForModelRoute(current.config.defaults?.modelRouteId) === providerId) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 仍是用户默认模型路由，请先更换默认模型`,
      );
    }
    const workspacePaths = await this.registrationStore.list();
    await this.assertProviderDependenciesIdle(providerId, workspacePaths);
    const credentialRef = credentialRefForProvider(
      providerCredentialIdentity(providerId, provider),
    );
    const storedCredential = await this.hasStoredProviderCredential(providerId, credentialRef);
    const providers = { ...current.config.providers };
    delete providers[providerId];
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers,
      },
      "provider.delete",
    );
    const pending = await this.providerOperationJournal.prepare({
      kind: "delete",
      previousUserConfig: current.config,
      targetUserConfig: next,
      credentialRef,
      credentialExistedBefore: storedCredential,
      configRevision: current.revision,
    });
    if (storedCredential) {
      try {
        await this.credentialVault.delete(credentialRef);
      } catch (error) {
        if (!(error instanceof CredentialNotFoundError)) {
          await this.providerOperationJournal.clear(pending.operationId).catch(() => undefined);
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            `Provider ${providerId} 的系统凭证删除失败，用户配置尚未变更: ${errorMessage(error)}`,
          );
        }
      }
    }
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "credential-deleted",
    });
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    return { deleted: true, revision: this.projectUserConfigRevision(written.revision) };
  }

  private async getProviderCredentialStatus(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId"],
      "provider.credential.status params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const provider = await this.requireUserProvider(providerId);
    return {
      providerId,
      ...(await this.projectCredentialStatus(providerId, provider)),
      providerFingerprint: providerFingerprint(providerId, provider),
    };
  }

  private async setProviderCredential(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "secret", "expectedRevision"],
      "provider.credential.set params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const provider = requireProviderFromUserConfig(current.config, providerId);
    const fingerprint = providerFingerprint(providerId, provider);
    const secret = requireSecret(record["secret"]);
    if (configuredCredential(provider) === secret) {
      return {
        providerId,
        status: "ready",
        source: "config",
        storedCredentialPresent: true,
        providerFingerprint: fingerprint,
        revision: this.projectUserConfigRevision(current.revision),
      };
    }
    const nextProvider = withConfiguredCredential(provider, secret);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [providerId]: nextProvider },
      },
      "provider.credential.set",
    );
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    return {
      providerId,
      status: "ready",
      source: "config",
      storedCredentialPresent: true,
      providerFingerprint: fingerprint,
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  private async deleteProviderCredential(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "expectedRevision"],
      "provider.credential.delete params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const provider = requireProviderFromUserConfig(current.config, providerId);
    const fingerprint = providerFingerprint(providerId, provider);
    const workspacePaths = await this.registrationStore.list();
    await this.assertProviderDependenciesIdle(providerId, workspacePaths);
    if (configuredCredential(provider) === undefined) {
      const status = await this.projectCredentialStatus(providerId, provider);
      return {
        providerId,
        status: status.credentialStatus,
        source: status.credentialSource,
        storedCredentialPresent: status.storedCredentialPresent,
        providerFingerprint: fingerprint,
        revision: this.projectUserConfigRevision(current.revision),
      };
    }
    const nextProvider = withoutConfiguredCredential(provider);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [providerId]: nextProvider },
      },
      "provider.credential.delete",
    );
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    const status = await this.projectCredentialStatus(
      providerId,
      written.config.providers[providerId]!,
    );
    return {
      providerId,
      status: status.credentialStatus,
      source: status.credentialSource,
      storedCredentialPresent: status.storedCredentialPresent,
      providerFingerprint: fingerprint,
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  private async requireUserProvider(providerId: string): Promise<ModelProviderConfig> {
    const provider = (await this.userConfigStore.read()).config.providers[providerId];
    if (!provider) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Provider ${providerId} 不存在`,
      );
    }
    return provider;
  }

  private async assertNoStoredCredentialBeforeAuthorityChange(
    providerId: string,
    provider: ModelProviderConfig,
  ): Promise<void> {
    if (configuredCredential(provider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 已在用户配置中保存 API Key，请先删除 API Key 再修改 Endpoint 或协议`,
      );
    }
    const capability = this.credentialVault.capability();
    if (!capability.available && !capability.cleanupAvailable) return;
    let stored: boolean;
    try {
      stored = await this.credentialVault.has(
        credentialRefForProvider(providerCredentialIdentity(providerId, provider)),
      );
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法确认 Provider ${providerId} 的系统凭证状态，已拒绝变更: ${errorMessage(error)}`,
      );
    }
    if (stored) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 仍有旧版系统凭证，请先清理后再修改 Endpoint 或协议`,
      );
    }
  }

  private async projectProviderProfile(
    id: string,
    provider: ModelProviderConfig,
    origin: "user" | "project-legacy" | "environment",
    supportsSharedCredential = true,
    credentialProvider = provider,
  ): Promise<JsonObject> {
    return {
      ...runtimeProviderInput(id, provider),
      origin,
      fingerprint: providerFingerprint(id, provider),
      ...(await this.projectCredentialStatus(id, credentialProvider, supportsSharedCredential)),
    };
  }

  private async projectCredentialStatus(
    providerId: string,
    provider: ModelProviderConfig,
    supportsSharedCredential = true,
  ): Promise<{
    readonly credentialStatus: "ready" | "missing" | "environment" | "unsupported";
    readonly credentialSource: "config" | "keychain" | "environment" | "none";
    readonly storedCredentialPresent: boolean;
  }> {
    if (configuredCredential(provider) !== undefined) {
      return {
        credentialStatus: "ready",
        credentialSource: "config",
        storedCredentialPresent: true,
      };
    }
    const environmentCredentialPresent = Boolean(
      readEnvironmentSecret(this.env, provider.apiKeyEnv),
    );
    if (!supportsSharedCredential) {
      return environmentCredentialPresent
        ? {
            credentialStatus: "environment",
            credentialSource: "environment",
            storedCredentialPresent: false,
          }
        : {
            credentialStatus: "unsupported",
            credentialSource: "none",
            storedCredentialPresent: false,
          };
    }
    const capability = this.credentialVault.capability();
    try {
      const ref = credentialRefForProvider(providerCredentialIdentity(providerId, provider));
      const storedCredentialPresent =
        capability.available || capability.cleanupAvailable
          ? await this.credentialVault.has(ref)
          : false;
      if (storedCredentialPresent) {
        return {
          credentialStatus: "ready",
          credentialSource: "keychain",
          storedCredentialPresent: true,
        };
      }
      if (environmentCredentialPresent) {
        return {
          credentialStatus: "environment",
          credentialSource: "environment",
          storedCredentialPresent: false,
        };
      }
      return {
        credentialStatus: capability.available ? "missing" : "unsupported",
        credentialSource: "none",
        storedCredentialPresent: false,
      };
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法读取 Provider ${providerId} 的系统凭证状态: ${errorMessage(error)}`,
      );
    }
  }

  private async writeUserConfig(config: PicoUserConfig, expectedRevision: string) {
    // Do not let the async watch bootstrap replace a snapshot written through this service.
    await this.userConfigWatchReady;
    try {
      const written = await this.userConfigStore.write(config, { expectedRevision });
      this.observedUserConfig = written;
      return written;
    } catch (error) {
      if (error instanceof UserConfigRevisionConflictError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "用户配置已更改，请刷新后重试",
        );
      }
      if (error instanceof UserConfigLockTimeoutError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      throw error;
    }
  }

  private async startUserConfigWatch(): Promise<void> {
    try {
      this.observedUserConfig = await this.userConfigStore.read();
    } catch {
      // The typed config methods surface corrupt state. Keep watching so an external repair
      // is detected without requiring a daemon restart.
    }
    if (this.userConfigWatchClosed) return;
    watchFile(
      this.userConfigStore.filePath,
      { persistent: false, interval: 200 },
      this.userConfigWatchListener,
    );
  }

  private scheduleUserConfigRefresh(): void {
    if (this.userConfigWatchClosed) return;
    if (this.userConfigWatchTimer) clearTimeout(this.userConfigWatchTimer);
    this.userConfigWatchTimer = setTimeout(() => {
      this.userConfigWatchTimer = undefined;
      this.userConfigWatchTail = this.userConfigWatchTail
        .then(
          () => this.refreshObservedUserConfig(),
          () => this.refreshObservedUserConfig(),
        )
        .catch(() => undefined);
    }, 60);
    this.userConfigWatchTimer.unref();
  }

  private async refreshObservedUserConfig(): Promise<void> {
    if (this.userConfigWatchClosed) return;
    const current = await this.userConfigStore.read();
    const previous = this.observedUserConfig;
    if (previous?.revision === current.revision) return;
    this.observedUserConfig = current;
    await this.publishUserConfigUpdated(
      current.revision,
      changedProviderIds(previous?.config.providers, current.config.providers),
    );
  }

  private async assertProviderDependenciesIdle(
    providerId: string,
    workspacePaths: readonly string[],
  ): Promise<void> {
    await this.assertNoActiveRuns(workspacePaths, `删除 Provider ${providerId} 或其系统凭证`);
    const automationReferences =
      this.options.automations?.providerReferences(providerId, workspacePaths) ?? [];
    if (automationReferences.length > 0) {
      const active = automationReferences.find(isActiveAutomationReference);
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        active
          ? `Provider ${providerId} 仍被运行中 Automation Run ${active.runId} 引用`
          : `Provider ${providerId} 仍被已启用 Automation ${automationReferences[0]!.jobId} 引用`,
      );
    }
  }

  private assertProviderCompatibleWithAutomationReferences(
    providerId: string,
    provider: ModelProviderConfig,
    references: readonly AutomationProviderReference[],
  ): void {
    for (const reference of references) {
      const modelRouteId = reference.modelRouteId;
      const separator = modelRouteId?.indexOf("/") ?? -1;
      const model = separator > 0 ? modelRouteId!.slice(separator + 1) : undefined;
      if (!model || !provider.models.includes(model)) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider ${providerId} 的模型变更会破坏 Automation ${reference.jobId} 固定的路由 ${modelRouteId ?? "<unknown>"}`,
        );
      }
      if (!reference.credentialRef) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Automation ${reference.jobId} 缺少可验证的 credentialRef，已拒绝变更 Provider ${providerId}`,
        );
      }
      try {
        const parsed = parseAnyCredentialRef(reference.credentialRef);
        if (parsed.version === "v2") {
          assertCredentialRefMatchesProvider(
            reference.credentialRef,
            providerCredentialIdentity(providerId, provider),
          );
        } else {
          assertCredentialRefMatchesModelRoute(
            reference.credentialRef,
            {
              id: modelRouteId!,
              provider: provider.protocol,
              baseURL: provider.baseURL,
              model,
              apiKeyEnv: provider.apiKeyEnv,
            },
            reference.workspacePath,
          );
        }
      } catch (error) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider ${providerId} 的协议或 Endpoint 变更会破坏 Automation ${reference.jobId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async hasStoredProviderCredential(
    providerId: string,
    credentialRef: CredentialRef,
  ): Promise<boolean> {
    const capability = this.credentialVault.capability();
    // An unavailable adapter cannot have accepted a v2 credential on this platform.
    // Preserve configuration management on Linux/Windows while still failing closed on
    // metadata errors from an actually available vault.
    if (!capability.available && !capability.cleanupAvailable) return false;
    try {
      return await this.credentialVault.has(credentialRef);
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法确认 Provider ${providerId} 的系统凭证状态，已拒绝删除: ${errorMessage(error)}`,
      );
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

  private async recoverProviderOperation(): Promise<void> {
    let pending = await this.providerOperationJournal.read();
    if (!pending) return;
    if (pending.phase === "config-committed") {
      await this.providerOperationJournal.clear(pending.operationId);
      return;
    }
    if (pending.kind === "import") {
      if (!this.credentialVault.capability().available) {
        throw new Error(
          `Provider 操作 ${pending.operationId} 等待凭证后端恢复: ${this.credentialVault.capability().diagnostic}`,
        );
      }
      const credentialPresent = await this.credentialVault.has(pending.credentialRef);
      if (!credentialPresent) {
        if (pending.phase === "prepared") {
          await this.providerOperationJournal.clear(pending.operationId);
          return;
        }
        throw new Error(`Provider 操作 ${pending.operationId} 的凭证阶段已提交但凭证不存在`);
      }
      if (pending.phase === "prepared") {
        pending = await this.providerOperationJournal.update(pending.operationId, {
          phase: "credential-imported",
        });
      }
    } else if (pending.phase === "prepared") {
      const capability = this.credentialVault.capability();
      if (
        pending.credentialExistedBefore &&
        !capability.available &&
        !capability.cleanupAvailable
      ) {
        throw new Error(
          `Provider 删除 ${pending.operationId} 等待凭证后端恢复: ${this.credentialVault.capability().diagnostic}`,
        );
      }
      if (pending.credentialExistedBefore) {
        try {
          await this.credentialVault.delete(pending.credentialRef);
        } catch (error) {
          if (!(error instanceof CredentialNotFoundError)) throw error;
        }
      }
      pending = await this.providerOperationJournal.update(pending.operationId, {
        phase: "credential-deleted",
      });
    }
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
  }

  private async commitProviderOperationConfig(
    operation: ProviderOperationRecord,
  ): Promise<UserConfigSnapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.userConfigStore.read();
      const next = reconcileProviderOperationConfig(operation, current.config);
      if (sameConfigValue(next, current.config)) return current;
      try {
        return await this.userConfigStore.write(next, { expectedRevision: current.revision });
      } catch (error) {
        if (!(error instanceof UserConfigRevisionConflictError)) throw error;
      }
    }
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `Provider 操作 ${operation.operationId} 在并发配置更新后仍无法提交，请刷新后重试`,
    );
  }

  private async withProviderDependencyLock<Result extends JsonValue>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const guarded = async () => {
      await this.providerRecoveryReady;
      if (this.providerRecoveryError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider 配置恢复尚未完成，已拒绝新的依赖变更: ${errorMessage(this.providerRecoveryError)}`,
        );
      }
      await this.recoverProviderOperation();
      return operation();
    };
    const queued = this.providerDependencyTail.then(guarded, guarded);
    this.providerDependencyTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private assertAcceptingRequests(): void {
    if (this.lifecycleState === "open") return;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      this.lifecycleState === "closing" ? "Runtime daemon 正在关闭" : "Runtime daemon 已关闭",
    );
  }

  private assertUserConfigRevision(expected: string, actual: string): void {
    const expectedBytes = Buffer.from(expected, "hex");
    const actualBytes = Buffer.from(this.projectUserConfigRevision(actual), "hex");
    if (!timingSafeEqual(expectedBytes, actualBytes)) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "用户配置已更改，请刷新后重试");
    }
  }

  private projectUserConfigRevision(revision: string): string {
    return createHmac("sha256", this.userConfigRevisionTokenKey)
      .update("pico.desktop.user-config-revision.v1\0", "utf8")
      .update(revision, "utf8")
      .digest("hex");
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
            revision: this.projectUserConfigRevision(revision),
            providerIds: [...providerIds],
          },
        }),
      );
    }
  }

  private async publishCapabilityConfigUpdated(
    capability: "skills" | "mcp",
    revision: string,
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
            capabilities: [capability],
          },
        }),
      );
    }
  }

  private async getUsage(params: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly from?: number;
    readonly to?: number;
  }): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(params.workspacePath);
    const from = optionalTimestamp(params.from, "from");
    const to = optionalTimestamp(params.to, "to");
    if (from !== undefined && to !== undefined && from > to) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "usage.get 的 from 不能晚于 to",
      );
    }
    const store = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome: this.picoHome }).workspace.root,
    });
    try {
      const filter = params.sessionId ? { sessionId: params.sessionId } : {};
      const calls = store
        .listProviderCalls(filter)
        .filter((record) => inTimeRange(record.createdAt, from, to));
      const hasRange = from !== undefined || to !== undefined;
      const baselines = hasRange
        ? []
        : store.listUsageBaselines(params.sessionId ? { sessionId: params.sessionId } : {});
      const providerCalls = sumUsage(calls);
      const baselineTotals = sumUsage(baselines);
      const total = addUsage(providerCalls, baselineTotals);
      // Baseline only contains cumulative buckets, not per-request report coverage or prompt
      // fingerprints. Cache-effectiveness ratios intentionally stay provider_calls-only.
      const cache = summarizeCacheEffectiveness(calls);
      return toJsonValue({
        usage: {
          workspacePath: canonical,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          providerCallCount: calls.length,
          baselineCount: baselines.length,
          providerCalls,
          baselines: baselineTotals,
          total: { ...total, totalTokens: total.inputTokens + total.outputTokens },
          cache,
          rangeAccuracy: hasRange ? "provider_calls_only" : "all_time_with_baselines",
        },
      });
    } finally {
      store.close();
    }
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
  }): Promise<JsonValue> {
    const revisionPrompt =
      params.decision === "request_changes" ? requireRevisionPrompt(params.message) : undefined;
    const projection = await this.projectRunChanges(params.workspacePath, params.runId);
    assertDesktopChangesComplete(projection.changes, "Changes 审阅");
    assertDesktopChangesFingerprint(params.expectedFingerprint, projection.fingerprint, "Changes");
    if (revisionPrompt) {
      await this.options.runtimeService.handle(
        createRuntimeRequest("run.start", {
          workspacePath: projection.workspacePath,
          sessionId: projection.sessionId,
          prompt: revisionPrompt,
        }),
      );
    }
    this.publish(
      createRuntimeNotification({
        topic: "changes.updated",
        scope: {
          workspacePath: projection.workspacePath,
          sessionId: projection.sessionId,
          runId: params.runId,
        },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: {
          runId: params.runId,
          fingerprint: projection.fingerprint,
        },
      }),
    );
    return { accepted: true, fingerprint: projection.fingerprint };
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
    return this.withSession(canonical, sessionId, async (session) => ({
      checkpoints: (await listRewindPointSummaries(session)).map((checkpoint) => ({
        checkpointId: checkpoint.messageId,
        label: checkpoint.userPrompt,
        createdAt: Date.parse(checkpoint.timestamp),
        changedFileCount: checkpoint.changedFileCount ?? 0,
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

  private async applyRewind(params: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly checkpointId: string;
    readonly expectedFingerprint: string;
    /** 回滚范围（fork mode）；缺省 both（协议默认，向后兼容）。 */
    readonly mode?: "code" | "conversation" | "both";
  }): Promise<JsonValue> {
    const canonical = await this.requireIdleTrustedSession(
      params.workspacePath,
      params.sessionId,
      "回滚",
    );
    // Non-destructive rewind: 从 checkpoint 创建新 Session（fork）。
    // 原 Session 完全不变，因此不再需要 Memory Source 失效——fork 不会破坏任何账本。
    const targetSessionId = this.createSessionId();
    const forkedSessionId = await this.withSession(canonical, params.sessionId, async (session) => {
      const expectedFingerprints = await projectDesktopRewindFingerprints(
        session,
        params.checkpointId,
        params.expectedFingerprint,
      );
      const fork = await session.forkFromCheckpoint(
        params.checkpointId,
        params.mode ?? "both",
        createSessionForkRuntimePort(),
        () => targetSessionId,
        expectedFingerprints,
      );
      return fork.targetSessionId;
    });
    const session = await this.requireSession(canonical, forkedSessionId);
    this.publishSession(session);
    this.publishTranscriptUpdate(canonical, forkedSessionId, "reload");
    this.publish(
      createRuntimeNotification({
        topic: "rewind.completed",
        scope: { workspacePath: canonical, sessionId: forkedSessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: {
          sessionId: forkedSessionId,
          sourceSessionId: params.sessionId,
          checkpointId: params.checkpointId,
        },
      }),
    );
    return { applied: true, sessionId: forkedSessionId, sourceSessionId: params.sessionId };
  }

  /** /changes 单文件恢复（3-D tier2 收口）：checkpoint 维度逐文件 diff + 当前指纹。 */
  private async listRewindFileChanges(
    workspacePath: string,
    sessionId: string,
    checkpointId: string,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(workspacePath, sessionId);
    return this.withSession(canonical, sessionId, async (session) => {
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
    return this.withSession(canonical, sessionId, async (session) => ({
      workspacePath: canonical,
      ...(await projectDesktopCheckpoint(session, checkpointId)),
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

  private async getSessionSettings(workspacePath: string, session: Session) {
    const persisted = session.getRuntimeStateSnapshot().settings;
    const defaults =
      persisted ??
      effectiveSessionSettingDefaults(await this.loadSessionModelRuntime(workspacePath));
    return getOrCreateSessionSettings(
      {
        sessionId: session.id,
        cwd: workspacePath,
        picoHome: this.picoHome,
        provider: defaults.provider,
        model: defaults.model,
        modelRouteId: defaults.modelRouteId,
        ...(defaults.mode ? { mode: defaults.mode } : {}),
        ...(defaults.thinkingEffort ? { thinkingEffort: defaults.thinkingEffort } : {}),
      },
      { persistence: session },
    );
  }

  private async getSessionModelRouter(
    workspacePath: string,
    settings: SessionSettings,
  ): Promise<ModelRouter> {
    return (await this.loadSessionModelRuntime(workspacePath, settings)).router;
  }

  private loadSessionModelRuntime(
    workspacePath: string,
    settings?: Pick<SessionSettings, "provider" | "model">,
  ): Promise<EffectiveModelRuntime> {
    return loadEffectiveModelRuntime({
      workDir: workspacePath,
      projectTrusted: true,
      legacyProvider: settings?.provider ?? "openai",
      legacyModel: settings?.model ?? "",
      legacyModelExplicit: false,
      env: this.env,
      credentialVault: this.credentialVault,
      userConfigStore: this.userConfigStore,
      configResolver: this.effectiveConfigResolver,
    });
  }

  private async withSession<T>(
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
      return await lease.session.withSerializedExecution(() => operation(lease.session));
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
      workDir: canonical,
      picoHome: this.picoHome,
      env: this.env,
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
    operation: (canonicalWorkspacePath: string) => Result,
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
    if (topic === "memory.proposed") {
      this.publish(
        createRuntimeNotification({
          ...base,
          topic: "memory.proposed",
          payload: payload as RuntimeNotificationMap["memory.proposed"],
        }),
      );
      return;
    }
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
        topic: "memory.forgotten",
        payload: payload as RuntimeNotificationMap["memory.forgotten"],
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

  private sideChatAuthority(workspacePath: string): SideChatAuthority {
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
          await new SessionForkService({
            workDir: workspacePath,
            picoHome: this.picoHome,
            runtimePort: createSessionForkRuntimePort(),
          }).fork({
            sourceSessionId,
            targetSessionId,
            throughEventId,
            targetMode:
              sourceLease.session.getRuntimeStateSnapshot().settings?.mode ??
              DEFAULT_INTERACTION_MODE,
          });
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
        await this.removeEphemeralSideChat(workspacePath, targetSessionId);
      },
    });
  }

  private async removeEphemeralSideChat(workspacePath: string, sessionId: string): Promise<void> {
    await this.terminalService.stopSession({ workspacePath, sessionId });
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
    resource: "tasks" | "artifacts" | "trace" | "context",
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

function reconcileProviderOperationConfig(
  operation: ProviderOperationRecord,
  current: PicoUserConfig,
): PicoUserConfig {
  const providerId = parseProviderCredentialRef(operation.credentialRef).providerId;
  const previousProvider = operation.previousUserConfig.providers[providerId];
  const targetProvider = operation.targetUserConfig.providers[providerId];
  const currentProvider = current.providers[providerId];
  if (
    !sameConfigValue(currentProvider, previousProvider) &&
    !sameConfigValue(currentProvider, targetProvider)
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `Provider ${providerId} 在恢复操作期间被修改，拒绝覆盖`,
    );
  }

  const providers = { ...current.providers };
  if (targetProvider) providers[providerId] = targetProvider;
  else delete providers[providerId];

  const defaults = { ...(current.defaults ?? {}) };
  const previousDefault = operation.previousUserConfig.defaults?.modelRouteId;
  const targetDefault = operation.targetUserConfig.defaults?.modelRouteId;
  if (previousDefault !== targetDefault && defaults.modelRouteId === previousDefault) {
    if (targetDefault === undefined) delete defaults.modelRouteId;
    else defaults.modelRouteId = targetDefault;
  }
  const next = validatedUserConfig(
    {
      version: 1,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      providers,
    },
    `provider.${operation.kind}.recovery`,
  );
  assertUserDefaultRoute(next);
  return next;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function redactedErrorMessage(error: unknown, secret: string): string {
  return errorMessage(error).split(secret).join("<redacted>");
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

function desktopRunStartIdempotencyKey(source: "send" | "queue", key: string): string {
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

function runtimeUserConfig(config: PicoUserConfig): JsonObject {
  return {
    version: 1,
    defaults: toJsonValue(config.defaults ?? {}),
    providers: Object.entries(config.providers)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([id, provider]) => runtimeProviderInput(id, provider)),
  };
}

function runtimeProviderInput(id: string, provider: ModelProviderConfig): JsonObject {
  const modelCapabilities =
    provider.modelCapabilities === undefined
      ? undefined
      : requireJsonRecord(toJsonValue(provider.modelCapabilities), "modelCapabilities");
  return {
    id,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    models: [...provider.models],
    discoverModels: provider.discoverModels,
    ...(modelCapabilities ? { modelCapabilities } : {}),
  } satisfies RuntimeProviderInput;
}

type ConfigCredentialProvider = ModelProviderConfig & { readonly apiKey?: string };

function configuredCredential(provider: ModelProviderConfig): string | undefined {
  const value = (provider as ConfigCredentialProvider).apiKey?.trim();
  return value || undefined;
}

function withConfiguredCredential(
  provider: ModelProviderConfig,
  apiKey: string,
): ModelProviderConfig {
  return { ...provider, apiKey } as ConfigCredentialProvider;
}

function withoutConfiguredCredential(provider: ModelProviderConfig): ModelProviderConfig {
  const next = { ...provider } as ModelProviderConfig & { apiKey?: string };
  delete next.apiKey;
  return next;
}

function retainConfiguredCredential(
  provider: ModelProviderConfig,
  previous: ModelProviderConfig | undefined,
): ModelProviderConfig {
  const apiKey = previous === undefined ? undefined : configuredCredential(previous);
  return apiKey === undefined ? provider : withConfiguredCredential(provider, apiKey);
}

function requireProviderFromUserConfig(
  config: PicoUserConfig,
  providerId: string,
): ModelProviderConfig {
  const provider = config.providers[providerId];
  if (!provider) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, `Provider ${providerId} 不存在`);
  }
  return provider;
}

function normalizeRuntimeUserDefaults(value: unknown): PicoUserConfigDefaults {
  const record = assertExactObjectKeys(
    value,
    ["modelRouteId", "mode", "thinkingEffort"],
    "defaults",
  );
  const modelRouteId = record["modelRouteId"];
  const mode = record["mode"];
  const thinkingEffort = record["thinkingEffort"];
  if (
    modelRouteId !== undefined &&
    (typeof modelRouteId !== "string" || !/^[^/\s]+\/.+$/u.test(modelRouteId.trim()))
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.modelRouteId 必须使用 providerID/modelID 格式",
    );
  }
  if (mode !== undefined && !isOneOf(mode, ["default", "plan", "auto", "yolo"] as const)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.mode 必须是 default、plan、auto 或 yolo",
    );
  }
  if (
    thinkingEffort !== undefined &&
    (typeof thinkingEffort !== "string" || !thinkingEffort.trim())
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.thinkingEffort 必须是非空字符串",
    );
  }
  return {
    ...(typeof modelRouteId === "string" ? { modelRouteId: modelRouteId.trim() } : {}),
    ...(isOneOf(mode, ["default", "plan", "auto", "yolo"] as const) ? { mode } : {}),
    ...(typeof thinkingEffort === "string" ? { thinkingEffort: thinkingEffort.trim() } : {}),
  };
}

function normalizeRuntimeProvider(value: unknown): {
  readonly id: string;
  readonly config: ModelProviderConfig;
} {
  const record = assertExactObjectKeys(
    value,
    ["id", "protocol", "baseURL", "apiKeyEnv", "models", "discoverModels", "modelCapabilities"],
    "provider",
  );
  const id = requireProviderId(record["id"]);
  const protocol = record["protocol"];
  if (!isOneOf(protocol, ["openai", "claude"] as const)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.protocol 必须是 openai 或 claude",
    );
  }
  const baseURL = requireText(record["baseURL"], "provider.baseURL");
  let normalizedEndpoint: string;
  try {
    normalizedEndpoint = normalizeProviderEndpoint(baseURL);
  } catch (error) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
  const apiKeyEnv = requireText(record["apiKeyEnv"], "provider.apiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.apiKeyEnv 必须是环境变量名",
    );
  }
  const rawModels = record["models"];
  if (!Array.isArray(rawModels) || rawModels.some((model) => typeof model !== "string")) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 必须是字符串数组",
    );
  }
  const models = rawModels.map((model) => String(model).trim()).filter(Boolean);
  if (new Set(models).size !== models.length) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 不能包含重复模型",
    );
  }
  const discoverModels = record["discoverModels"];
  if (typeof discoverModels !== "boolean") {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.discoverModels 必须是布尔值",
    );
  }
  if (models.length === 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 首版必须至少包含一个显式模型",
    );
  }
  if (discoverModels && protocol !== "openai") {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.discoverModels 首版仅支持 openai 协议",
    );
  }
  const modelCapabilitiesValue = record["modelCapabilities"];
  const modelCapabilities =
    modelCapabilitiesValue === undefined
      ? undefined
      : assertExactModelCapabilities(modelCapabilitiesValue, models);
  const rawProvider = {
    protocol,
    baseURL: normalizedEndpoint,
    apiKeyEnv,
    discoverModels,
    models:
      modelCapabilities === undefined
        ? models
        : Object.fromEntries(models.map((model) => [model, modelCapabilities[model] ?? {}])),
  };
  try {
    const config = parseModelProviderConfigs({ [id]: rawProvider }, "provider.upsert")[id];
    if (!config) throw new Error(`Provider ${id} 解析后丢失`);
    return { id, config };
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
}

function assertExactModelCapabilities(value: unknown, models: readonly string[]): JsonObject {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.modelCapabilities 必须是对象",
    );
  }
  for (const [model, capabilities] of Object.entries(value)) {
    if (!models.includes(model)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `provider.modelCapabilities.${model} 不在 models 列表中`,
      );
    }
    if (!isJsonRecord(capabilities)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `provider.modelCapabilities.${model} 必须是对象`,
      );
    }
  }
  return value;
}

function validatedUserConfig(config: PicoUserConfig, operation: string): PicoUserConfig {
  try {
    return parseUserConfig(config, operation);
  } catch (error) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
}

function assertUserDefaultRoute(config: PicoUserConfig): void {
  const routeId = config.defaults?.modelRouteId;
  if (!routeId) return;
  const separator = routeId.indexOf("/");
  const providerId = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  const provider = config.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `默认模型路由 ${routeId} 不在用户 Provider 模型列表中`,
    );
  }
}

function providerFingerprint(providerId: string, provider: ModelProviderConfig): string {
  return createHash("sha256")
    .update(
      stableJson({
        providerId,
        protocol: provider.protocol,
        baseURL: provider.baseURL.trim().replace(/\/+$/u, ""),
        apiKeyEnv: provider.apiKeyEnv,
        models: [...provider.models],
        discoverModels: provider.discoverModels,
        modelCapabilities: provider.modelCapabilities ?? {},
      }),
    )
    .digest("hex");
}

function changedProviderIds(
  previous: Readonly<Record<string, ModelProviderConfig>> | undefined,
  current: Readonly<Record<string, ModelProviderConfig>>,
): string[] {
  const ids = new Set([...Object.keys(previous ?? {}), ...Object.keys(current)]);
  return [...ids]
    .filter((id) => {
      const before = previous?.[id];
      const after = current[id];
      if (!before || !after) return true;
      return (
        providerFingerprint(id, before) !== providerFingerprint(id, after) ||
        configuredCredential(before) !== configuredCredential(after)
      );
    })
    .toSorted();
}

function providerCredentialIdentity(providerId: string, provider: ModelProviderConfig) {
  return {
    providerId,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
  } as const;
}

function sameProviderEndpoint(left: string, right: string): boolean {
  try {
    return normalizeProviderEndpoint(left) === normalizeProviderEndpoint(right);
  } catch {
    return left.trim().replace(/\/+$/u, "") === right.trim().replace(/\/+$/u, "");
  }
}

function providerOrigin(
  source: ConfigSource | undefined,
): "user" | "project-legacy" | "environment" {
  if (source === "user" || source === "project-legacy" || source === "environment") {
    return source;
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.INTERNAL_ERROR,
    `Provider 配置来源无效: ${String(source)}`,
  );
}

function readEnvironmentSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name]
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
}

function requireProviderId(value: unknown): string {
  const providerId = requireText(value, "providerId");
  if (
    !/^[^/\s]+$/u.test(providerId) ||
    ["__proto__", "prototype", "constructor"].includes(providerId)
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "providerId 不能包含空白或斜杠",
    );
  }
  return providerId;
}

function providerIdForModelRoute(modelRouteId: string | undefined): string | undefined {
  if (!modelRouteId) return undefined;
  const separator = modelRouteId.indexOf("/");
  return separator > 0 ? modelRouteId.slice(0, separator) : undefined;
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return left.protocol === right.protocol && sameProviderEndpoint(left.baseURL, right.baseURL);
}

function isActiveAutomationReference(
  reference: AutomationProviderReference,
): reference is ActiveAutomationReference {
  return "runId" in reference;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `${field} 必须是小写 SHA-256`,
    );
  }
  return value;
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "secret 必须是不含换行的非空字符串",
    );
  }
  return value.trim();
}

function assertExactObjectKeys(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): JsonObject {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, `${label} 必须是对象`);
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `${label} 包含未知字段: ${unexpected.join(", ")}`,
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    collaborationMode: settings.collaborationMode ?? (settings.mode === "plan" ? "plan" : "agent"),
    orchestrationMode: settings.orchestrationMode ?? "default",
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

function invalidSessionSetting(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}

function effectiveSessionSettingDefaults(runtime: EffectiveModelRuntime): {
  provider: ProviderKind;
  model: string;
  modelRouteId: string;
  mode?: SessionSettings["mode"];
  thinkingEffort?: string;
} {
  const route = runtime.router.require(runtime.config.defaultModelRouteId);
  return {
    provider: route.provider,
    model: route.model,
    modelRouteId: route.id,
    ...(runtime.config.defaults.mode ? { mode: runtime.config.defaults.mode } : {}),
    ...(runtime.config.defaults.thinkingEffort
      ? { thinkingEffort: runtime.config.defaults.thinkingEffort }
      : {}),
  };
}

function safeConfig(config: PicoProjectConfig): JsonValue {
  return toJsonValue({
    schemaVersion: config.version,
    commandsDir: config.commandsDir,
    additionalDirectories: config.additionalDirectories,
    keybindings: config.keybindings,
    sandbox: config.sandbox,
    lspServers: config.lspServers,
  });
}

async function configContentVersion(workspacePath: string): Promise<number> {
  try {
    const content = await readFile(join(workspacePath, ".pico", "config.json"));
    return Number.parseInt(createHash("sha256").update(content).digest("hex").slice(0, 8), 16);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return 0;
    throw error;
  }
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

function sumUsage(
  records: readonly (ProviderCallRecord | UsageBaselineRecord)[],
): UsageLedgerTotals {
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

function addUsage(left: UsageLedgerTotals, right: UsageLedgerTotals): UsageLedgerTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cost: left.cost + right.cost,
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value cannot be represented as JSON");
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed)) throw new Error("Value cannot be represented as Runtime JSON");
  return parsed;
}

function requireJsonRecord(value: unknown, label: string): JsonObject {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, `${label} 必须是对象`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, `${label} 必须是非空字符串`);
  }
  return value.trim();
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
  const event: TranscriptEvent = {
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
  };
  await session.recordTranscriptEvent(event, { eventId: `desktop-transcript:${eventId}` });
}

function normalizeRuntimeUserInput(value: RuntimeUserInput): RuntimeUserInput {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, "input 必须是对象");
  }
  const kind = value["kind"];
  if (kind === "text") {
    const attachments = normalizeInputAttachments(value["attachments"]);
    return {
      kind,
      text: requireText(value["text"], "input.text"),
      ...(attachments ? { attachments } : {}),
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
    return {
      kind,
      name: requireText(value["name"], "input.name"),
      task: requireText(value["task"], "input.task"),
    };
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
    `input.kind 不支持: ${String(kind)}`,
  );
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

function runtimeInputTitle(input: RuntimeUserInput): string {
  if (input.kind === "agent") return input.task;
  if (input.kind === "skill") {
    return [`/${input.name}`, input.args?.trim()].filter(Boolean).join(" ");
  }
  return input.text;
}

function runtimeInputDisplay(input: RuntimeUserInput): string {
  if (input.kind === "agent") return [`@${input.name}`, input.task.trim()].join(" ");
  if (input.kind === "skill") {
    return [`/${input.name}`, input.args?.trim()].filter(Boolean).join(" ");
  }
  return input.text.trim();
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}

function isTerminalRunStatus(status: string): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function isJsonRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
