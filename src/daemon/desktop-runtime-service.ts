import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCliSessionId, listCliSessionSummaries } from "../cli/session-resolver.js";
import { SkillLoader } from "../context/skill.js";
import { Session } from "../engine/session.js";
import { loadPicoConfig, type PicoConfig } from "../input/pico-config.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import { RuntimeStore } from "../tasks/runtime-store.js";
import type {
  ProviderCallRecord,
  UsageBaselineRecord,
  UsageLedgerTotals,
} from "../tasks/runtime-types.js";
import {
  createRuntimeEvent,
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
import { WorkspaceRuntimeService } from "./workspace-runtime-service.js";

const UNSUPPORTED_DESKTOP_METHODS: ReadonlySet<string> = new Set([
  "run.pause",
  "run.resume",
  "approval.respond",
  "prompt.respond",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "config.update",
] as const);

export interface DesktopRuntimeServiceOptions {
  readonly runtimeService: WorkspaceRuntimeService;
  readonly registrationStore?: WorkspaceRegistrationStore;
  readonly trustStore?: WorkspaceTrustStore;
  readonly sessionStateStore?: DesktopSessionStateStore;
  readonly now?: () => number;
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
      default:
        if (UNSUPPORTED_DESKTOP_METHODS.has(request.method)) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
            `${request.method} 尚未连接可验证的 Runtime 能力，本次请求未执行`,
          );
        }
        return this.options.runtimeService.handle(request);
    }
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
    const workspaces = (await this.registrationStore.list()).map((workspacePath) => ({
      workspacePath,
      registered: true,
      schedulerStatus: "unknown" as const,
    }));
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
      // A metadata-only JSONL has no session records for the CLI projector to identify.
      // Persist the real zero-usage runtime snapshot so both surfaces discover it immediately.
      session.updateRuntimeState({ usage: session.getRuntimeStateSnapshot().usage });
      await session.flushPersistence();
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
