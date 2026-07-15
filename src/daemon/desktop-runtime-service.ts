import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listRewindPointSummaries } from "../cli/file-history.js";
import { createCliSessionId, listCliSessionSummaries } from "../cli/session-resolver.js";
import { SkillLoader } from "../context/skill.js";
import { globalSessionManager, Session } from "../engine/session.js";
import { loadPicoConfig, type PicoConfig } from "../input/pico-config.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "../runtime/runtime-event-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import {
  fileHistoryChanges,
  type FileHistoryChanges,
  type FileHistoryFilePatch,
} from "../safety/file-history.js";
import { RuntimeStore } from "../tasks/runtime-store.js";
import type {
  ProviderCallRecord,
  UsageBaselineRecord,
  UsageLedgerTotals,
} from "../tasks/runtime-types.js";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  isJsonValue,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type JsonObject,
  type RuntimeEvent,
  type RuntimeRequest,
} from "./protocol.js";
import type { DisposableLocalRuntimeService, RuntimeEventCursor } from "./service.js";
import { DesktopSessionStateStore } from "./desktop-session-state.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { WorkspaceRuntimeService, workspaceStatusResult } from "./workspace-runtime-service.js";
import { DesktopAutomationService } from "./desktop-automation-service.js";

const UNSUPPORTED_DESKTOP_METHODS: ReadonlySet<string> = new Set([
  "approval.respond",
  "prompt.respond",
  "config.update",
] as const);

export interface DesktopRuntimeServiceOptions {
  readonly runtimeService: WorkspaceRuntimeService;
  readonly registrationStore?: WorkspaceRegistrationStore;
  readonly trustStore?: WorkspaceTrustStore;
  readonly sessionStateStore?: DesktopSessionStateStore;
  readonly interactions?: DesktopRuntimeInteractions;
  readonly automations?: DesktopAutomationService;
  readonly now?: () => number;
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
}

/**
 * Desktop control-plane adapter. It composes existing CLI/daemon persistence instead
 * of creating a renderer-owned cache or a second Agent runtime.
 */
export class DesktopRuntimeService implements DisposableLocalRuntimeService {
  private readonly registrationStore: WorkspaceRegistrationStore;
  private readonly trustStore: WorkspaceTrustStore;
  private readonly sessionStateStore: DesktopSessionStateStore;
  private readonly now: () => number;
  private resourceVersion = 0;

  constructor(private readonly options: DesktopRuntimeServiceOptions) {
    this.registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
    this.trustStore = options.trustStore ?? new WorkspaceTrustStore();
    this.sessionStateStore = options.sessionStateStore ?? new DesktopSessionStateStore();
    this.now = options.now ?? Date.now;
  }

  async handle(request: RuntimeRequest): Promise<JsonValue> {
    switch (request.method) {
      case "workspace.list":
        return this.listWorkspaces();
      case "workspace.trustStatus":
        return this.trustStatus(request.params.workspacePath);
      case "workspace.trust":
        return this.setTrust(request.params.workspacePath, request.params.trusted);
      case "session.list":
        return this.listSessions(request.params.workspacePath, request.params.includeArchived);
      case "session.get":
        return this.getSession(request.params.workspacePath, request.params.sessionId);
      case "session.create":
        return this.createSession(request.params.workspacePath, request.params.title);
      case "session.archive":
        return this.setSessionArchived(
          request.params.workspacePath,
          request.params.sessionId,
          true,
        );
      case "session.restore":
        return this.setSessionArchived(
          request.params.workspacePath,
          request.params.sessionId,
          false,
        );
      case "config.get":
        return this.getConfig(request.params.workspacePath);
      case "config.providers":
        return this.listProviders(request.params.workspacePath);
      case "config.skills":
        return this.listSkills(request.params.workspacePath);
      case "config.mcpServers":
        return this.listMcpServers(request.params.workspacePath);
      case "usage.get":
        return this.getUsage(request.params);
      case "changes.list":
        return this.listChanges(request.params.workspacePath, request.params.runId);
      case "changes.diff":
        return this.getChangeDiff(
          request.params.workspacePath,
          request.params.runId,
          request.params.path,
        );
      case "changes.review":
        return this.reviewChanges(request.params);
      case "changes.apply":
        return this.applyChanges(
          request.params.workspacePath,
          request.params.runId,
          request.params.expectedFingerprint,
        );
      case "rewind.list":
        return this.listRewindPoints(request.params.workspacePath, request.params.sessionId);
      case "rewind.preview":
        return this.previewRewind(
          request.params.workspacePath,
          request.params.sessionId,
          request.params.checkpointId,
        );
      case "rewind.apply":
        return this.applyRewind(request.params);
      case "jobs.list":
        return this.listJobs(request.params.workspacePath);
      case "jobs.create":
        return this.createJob(request.params);
      case "jobs.update":
        return this.updateJob(request.params);
      case "jobs.delete":
        return this.deleteJob(request.params.workspacePath, request.params.jobId);
      case "jobs.setEnabled":
        return this.setJobEnabled(
          request.params.workspacePath,
          request.params.jobId,
          request.params.enabled,
        );
      case "jobs.runNow":
        return this.runJobNow(request.params.workspacePath, request.params.jobId);
      case "jobs.history":
        return this.jobHistory(
          request.params.workspacePath,
          request.params.jobId,
          request.params.limit,
        );
      case "approval.respond":
        if (this.options.interactions) {
          return this.options.interactions.respondApproval(request.params);
        }
        break;
      case "prompt.respond":
        if (this.options.interactions) {
          return this.options.interactions.respondPrompt(request.params);
        }
        break;
      default:
        if (!UNSUPPORTED_DESKTOP_METHODS.has(request.method)) {
          return this.options.runtimeService.handle(request);
        }
    }
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
      `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
    );
  }

  replayEvents(cursor: RuntimeEventCursor): Promise<readonly RuntimeEvent[]> {
    return this.options.runtimeService.replayEvents(cursor);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.options.runtimeService.subscribe(listener);
  }

  close(): Promise<void> {
    return this.options.runtimeService.close();
  }

  private async listWorkspaces(): Promise<JsonValue> {
    const workspaces = await Promise.all(
      (await this.registrationStore.list()).map(async (workspacePath) =>
        workspaceStatusResult(
          await this.options.runtimeService.getWorkspaceRuntime(workspacePath),
          true,
        ),
      ),
    );
    return { workspaces };
  }

  private async trustStatus(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.trustStore.canonicalize(workspacePath);
    return { workspacePath: canonical, trusted: await this.trustStore.isTrusted(canonical) };
  }

  private async setTrust(workspacePath: string, trusted: boolean): Promise<JsonValue> {
    const canonical = await this.trustStore.canonicalize(workspacePath);
    await this.trustStore.setTrusted(canonical, trusted);
    this.publish(
      createRuntimeEvent({
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
    const [summaries, metadata] = await Promise.all([
      listCliSessionSummaries(canonical),
      this.sessionStateStore.list(canonical),
    ]);
    const metadataById = new Map(metadata.map((entry) => [entry.sessionId, entry]));
    const sessions = summaries
      .map((summary) => sessionPayload(summary, metadataById.get(summary.id)))
      .filter((session) => includeArchived || session.status !== "archived");
    return { sessions };
  }

  private async getSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    return { session: await this.requireSession(canonical, sessionId) };
  }

  private async createSession(workspacePath: string, title?: string): Promise<JsonValue> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const sessionId = createCliSessionId();
    const session = new Session(sessionId, canonical, {
      persistence: true,
      sessionCatalog: false,
    });
    try {
      await session.recover();
      await new RuntimeEventStore({
        databasePath: resolvePicoPaths(canonical).workspace.runtimeDatabase,
      }).initializeSession({ sessionId, workDir: canonical });
    } finally {
      await session.close();
    }
    if (title !== undefined) {
      await this.sessionStateStore.update(canonical, sessionId, { title });
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
    await this.sessionStateStore.update(canonical, sessionId, { archived });
    const session = await this.requireSession(canonical, sessionId);
    this.publishSession(session);
    return { session };
  }

  private async requireSession(workspacePath: string, sessionId: string): Promise<JsonValue> {
    const summaries = await listCliSessionSummaries(workspacePath);
    const summary = summaries.find((candidate) => candidate.id === sessionId);
    if (!summary) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Session ${sessionId} 不存在于工作区 ${workspacePath}`,
      );
    }
    return sessionPayload(summary, await this.sessionStateStore.get(workspacePath, sessionId));
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
        Object.entries(config.providers).map(([id, provider]) => ({ id, ...provider })),
      ),
    };
  }

  private async listSkills(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const loader = new SkillLoader(canonical);
    const summaries = await loader.listSummaries();
    return {
      skills: await Promise.all(
        summaries.map(async (skill) => ({
          ...skill,
          sourcePath: await loader.viewSourcePath(skill.name),
        })),
      ).then(toJsonValue),
    };
  }

  private async listMcpServers(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const manager = new McpConnectionManager(undefined, { stdioCwd: canonical });
    try {
      await manager.loadConfig(join(canonical, ".claw", "mcp.json"));
      return { servers: toJsonValue(manager.getStatusSnapshot().servers) };
    } finally {
      await manager.closeAll();
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
    const store = new RuntimeStore({ workDir: canonical });
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
    this.assertCompleteChanges(projection.changes, "Changes 审阅");
    this.assertFingerprint(params.expectedFingerprint, projection.fingerprint, "Changes");
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
      createRuntimeEvent({
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
    this.assertCompleteChanges(projection.changes, "Changes 应用");
    this.assertFingerprint(expectedFingerprint, projection.fingerprint, "Changes");
    // Foreground Agent tools already commit directly into the trusted workspace. This call
    // revalidates that the reviewed bytes are still current and records that fact;
    // it never stages or copies renderer-owned content into the workspace.
    this.publish(
      createRuntimeEvent({
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
        label: checkpoint.userPrompt ?? "未命名检查点",
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
  }): Promise<JsonValue> {
    const canonical = await this.requireTrustedSession(params.workspacePath, params.sessionId);
    await this.withSession(canonical, params.sessionId, async (session) => {
      const checkpoint = session.fileHistory.snapshots.find(
        (candidate) => candidate.messageId === params.checkpointId,
      );
      if (
        !checkpoint ||
        checkpoint.userPrompt === undefined ||
        checkpoint.messageIndex === undefined
      ) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.NOT_FOUND,
          `Session ${params.sessionId} 中不存在可完整回滚的检查点 ${params.checkpointId}`,
        );
      }
      const changes = await fileHistoryChanges(
        session.fileHistory,
        params.checkpointId,
        session.id,
      );
      const fingerprint = changesFingerprint(session, params.checkpointId, changes);
      this.assertCompleteChanges(changes, "Rewind");
      this.assertFingerprint(params.expectedFingerprint, fingerprint, "Rewind");
      const expectedCurrentFingerprints = new Map(
        changes.files.map((file) => [file.filePath, file.currentFingerprint]),
      );
      try {
        await session.rewindBoth(
          params.checkpointId,
          checkpoint.messageIndex,
          expectedCurrentFingerprints,
        );
      } catch (error) {
        if (isRewindConflict(error)) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            `Rewind 安全检查失败: ${errorMessage(error)}`,
          );
        }
        throw error;
      }
    });
    this.publish(
      createRuntimeEvent({
        topic: "rewind.completed",
        scope: { workspacePath: canonical, sessionId: params.sessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { sessionId: params.sessionId, checkpointId: params.checkpointId },
      }),
    );
    return { applied: true, sessionId: params.sessionId };
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
    return this.withSession(canonical, sessionId, async (session) => {
      const checkpoint = session.fileHistory.snapshots.find(
        (candidate) => candidate.messageId === checkpointId,
      );
      if (!checkpoint || checkpoint.userPrompt === undefined) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.NOT_FOUND,
          `Session ${sessionId} 中不存在检查点 ${checkpointId}`,
        );
      }
      const changes = await fileHistoryChanges(session.fileHistory, checkpointId, session.id);
      return {
        workspacePath: canonical,
        sessionId,
        checkpointId,
        changes,
        fingerprint: changesFingerprint(session, checkpointId, changes),
      };
    });
  }

  private async requireTrustedSession(workspacePath: string, sessionId: string): Promise<string> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    await this.requireSession(canonical, sessionId);
    return canonical;
  }

  private async withSession<T>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session) => Promise<T>,
  ): Promise<T> {
    const session = await globalSessionManager.getOrCreate(sessionId, workspacePath, {
      persistence: true,
      sessionCatalog: false,
    });
    return session.serialize(() => operation(session));
  }

  private assertFingerprint(expected: string, actual: string, operation: string): void {
    if (expected !== actual) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `${operation} 指纹已变化，请刷新后重试`,
      );
    }
  }

  private assertCompleteChanges(changes: FileHistoryChanges, operation: string): void {
    if (changes.incomplete) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `${operation} 捕获不完整，拒绝在不完整文件集上继续`,
      );
    }
  }

  private async listJobs(workspacePath: string): Promise<JsonValue> {
    const [canonical, automations] = await Promise.all([
      this.requireTrustedWorkspace(workspacePath),
      Promise.resolve(this.requireAutomations()),
    ]);
    return { jobs: automations.list(canonical) };
  }

  private async createJob(params: {
    readonly workspacePath: string;
    readonly name: string;
    readonly prompt: string;
    readonly schedule: string;
    readonly enabled?: boolean;
  }): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const job = await this.requireAutomations().create(canonical, params);
    this.publishJob(job);
    return { job };
  }

  private async updateJob(params: {
    readonly workspacePath: string;
    readonly jobId: string;
    readonly name?: string;
    readonly prompt?: string;
    readonly schedule?: string;
  }): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(params.workspacePath);
    const job = this.requireAutomations().update(canonical, params.jobId, params);
    this.publishJob(job);
    return { job };
  }

  private async deleteJob(workspacePath: string, jobId: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    return { deleted: this.requireAutomations().delete(canonical, jobId) };
  }

  private async setJobEnabled(
    workspacePath: string,
    jobId: string,
    enabled: boolean,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const job = this.requireAutomations().setEnabled(canonical, jobId, enabled);
    this.publishJob(job);
    return { job };
  }

  private async runJobNow(workspacePath: string, jobId: string): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    const result = await this.requireAutomations().runNow(canonical, jobId);
    this.publishJob(result.job);
    return result;
  }

  private async jobHistory(
    workspacePath: string,
    jobId: string,
    limit?: number,
  ): Promise<JsonValue> {
    const canonical = await this.requireTrustedWorkspace(workspacePath);
    return { runs: this.requireAutomations().history(canonical, jobId, limit) };
  }

  private requireAutomations(): DesktopAutomationService {
    if (this.options.automations) return this.options.automations;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
      "Automations 尚未连接到 daemon Cron runtime",
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
      createRuntimeEvent({
        topic: "session.updated",
        scope: { workspacePath, sessionId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { session },
      }),
    );
  }

  private publishJob(job: JsonValue): void {
    if (!isJsonRecord(job)) return;
    const workspacePath = job["workspacePath"];
    const jobId = job["jobId"];
    if (typeof workspacePath !== "string" || typeof jobId !== "string") return;
    this.publish(
      createRuntimeEvent({
        topic: "job.updated",
        scope: { workspacePath, jobId },
        resourceVersion: this.nextResourceVersion(),
        at: this.now(),
        payload: { job },
      }),
    );
  }

  private publish(event: RuntimeEvent): void {
    this.options.runtimeService.publishDesktopEvent(event);
  }

  private nextResourceVersion(): number {
    this.resourceVersion = Math.max(this.resourceVersion + 1, this.now());
    return this.resourceVersion;
  }
}

function sessionPayload(
  summary: Awaited<ReturnType<typeof listCliSessionSummaries>>[number],
  metadata: Awaited<ReturnType<DesktopSessionStateStore["get"]>>,
): JsonObject {
  return {
    sessionId: summary.id,
    workspacePath: summary.cwd,
    title: metadata?.title ?? summary.title ?? summary.firstMessage ?? "未命名会话",
    status: metadata?.archivedAt === undefined ? "active" : "archived",
    createdAt: summary.createdAt.getTime(),
    updatedAt: Math.max(summary.updatedAt.getTime(), metadata?.updatedAt ?? 0),
    messageCount: summary.messageCount,
    ...(summary.lastMessage ? { lastMessage: summary.lastMessage } : {}),
    ...(summary.forkFrom ? { forkFrom: summary.forkFrom } : {}),
  };
}

function safeConfig(config: PicoConfig): JsonValue {
  return toJsonValue({
    schemaVersion: config.version,
    ...(config.model ? { model: config.model } : {}),
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

interface DesktopChangesProjection {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly runId?: string;
  readonly changes: FileHistoryChanges;
  readonly fingerprint: string;
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

function changesFingerprint(
  session: Session,
  checkpointId: string,
  changes: FileHistoryChanges,
): string {
  const payload = {
    version: 1,
    sessionId: session.id,
    checkpointId,
    fileHistoryRevision: session.fileHistory.revision,
    incomplete: changes.incomplete === true,
    warnings: [...(changes.warnings ?? [])].toSorted(),
    files: changes.files
      .map((file) => ({
        filePath: resolve(file.filePath),
        status: file.status,
        addedLines: file.addedLines,
        removedLines: file.removedLines,
        currentFingerprint: file.currentFingerprint,
      }))
      .toSorted((left, right) => left.filePath.localeCompare(right.filePath)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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

function isRewindConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:conflict|drift|fingerprint|revision|变化|变更|预检|人工处理)/iu.test(error.message);
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

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
