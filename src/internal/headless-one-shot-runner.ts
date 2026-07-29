import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SilentReporter } from "../engine/reporter.js";
import type { EffectiveConfigSnapshot } from "../input/effective-config.js";
import type { SessionSettings } from "../input/session-settings.js";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigStore,
  type UserConfigSnapshot,
  type UserModelProviderConfig,
} from "../input/user-config-store.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import type { CredentialVault } from "../provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../provider/effective-model-runtime.js";
import type { ModelProviderConfig } from "../provider/model-router.js";
import { coordinateReasoningLevel } from "../provider/reasoning-capability.js";
import type { PluginRuntimeSnapshot } from "../plugins/plugin-runtime-snapshot.js";
import {
  executeAgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentProviderFactory,
} from "../runtime/agent-runtime.js";
import type { RunAgentCliResult, RunAgentUsage } from "../runtime/runtime-contract.js";
import { LeaseConflictError, OwnerLease } from "../storage/owner-lease.js";
import { RuntimeEventStore } from "../storage/runtime-event-store.js";
import { ensureWorkspaceTrusted, WorkspaceTrustStore } from "../security/workspace-trust.js";

const SCHEMA_VERSION = 1 as const;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1024 * 1024;
const MAX_SHUTDOWN_GRACE_MS = 60_000;
const MAX_TIMEOUT_MS = 7_200_000;
const LOCK_DIRECTORY_MODE = 0o700;
const HEADLESS_TOOL_NAMES = new Set([
  "bash",
  "edit_file",
  "fetch_url",
  "glob",
  "grep",
  "read_evidence",
  "read_file",
  "todo",
  "web_search",
  "write_file",
]);
const pendingLockReleases = new Map<
  ExclusiveCaseLocks,
  { attempt: number; timer?: NodeJS.Timeout }
>();
const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "requestId",
  "workspacePath",
  "picoHome",
  "sessionId",
  "prompt",
  "modelRouteId",
  "thinkingEffort",
  "permissionMode",
  "allowedTools",
  "timeoutMs",
  "shutdownGraceMs",
  "trace",
]);
const REQUIRED_REQUEST_FIELDS = [
  "schemaVersion",
  "requestId",
  "workspacePath",
  "picoHome",
  "sessionId",
  "prompt",
  "modelRouteId",
  "permissionMode",
  "allowedTools",
  "timeoutMs",
  "shutdownGraceMs",
  "trace",
] as const;
const INTERACTION_MODES = new Set<SessionSettings["mode"]>(["default", "auto", "plan", "yolo"]);
const EMPTY_USAGE: RunAgentUsage = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  costCNY: 0,
});

export type HeadlessOneShotStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "canceled"
  | "policy_blocked"
  | "invalid_request";

export interface HeadlessOneShotRequestV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly requestId: string;
  readonly workspacePath: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly modelRouteId: string;
  readonly thinkingEffort?: string;
  readonly permissionMode: SessionSettings["mode"];
  readonly allowedTools: readonly string[];
  readonly timeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly trace: boolean;
}

export interface HeadlessOneShotEffectivePolicy {
  readonly modelRouteId: string | null;
  readonly thinkingEffort: string | null;
  readonly permissionMode: SessionSettings["mode"] | null;
  readonly allowedTools: readonly string[];
}

export interface HeadlessOneShotError {
  readonly code: string;
  readonly summary: string;
}

export interface HeadlessOneShotResultV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly requestId: string | null;
  readonly status: HeadlessOneShotStatus;
  readonly sessionId: string | null;
  readonly workDir: string | null;
  readonly finalMessage: string | null;
  readonly usage: RunAgentUsage;
  readonly durationMs: number;
  readonly tracePath: string | null;
  readonly effective: HeadlessOneShotEffectivePolicy;
  readonly error: HeadlessOneShotError | null;
  /** True only when all Runtime execution has settled before this payload is emitted. */
  readonly terminationConfirmed: boolean;
}

export interface HeadlessOneShotOutcome {
  readonly result: HeadlessOneShotResultV1;
  readonly exitCode: 0 | 2 | 3 | 4 | 124 | 130 | 143;
  /** False means the grace deadline elapsed before Runtime cleanup settled. */
  readonly shutdownConfirmed: boolean;
}

export interface HeadlessOneShotDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly signalKind?: "SIGINT" | "SIGTERM";
  readonly credentialVault?: CredentialVault;
  readonly providerFactory?: RunAgentProviderFactory;
  readonly executeRuntime?: typeof executeAgentRuntime;
  readonly now?: () => number;
  readonly lockRoot?: string;
  /** Test seam for machine-local owner-lease deletion fault injection. */
  readonly lockRemoveLeaseDirectory?: (leaseDirectory: string) => Promise<void>;
  /** Test seam that opens a deterministic crash window after Runtime trace export. */
  readonly beforeTraceSanitize?: () => Promise<void>;
}

type CancelCause = "timeout" | "SIGINT" | "SIGTERM" | "canceled";

class HeadlessRequestError extends Error {
  constructor(
    readonly code: string,
    readonly summary: string,
  ) {
    super(summary);
    this.name = "HeadlessRequestError";
  }
}

class HeadlessCancellationError extends Error {
  constructor(readonly cancelCause: CancelCause) {
    super(cancelCause);
    this.name = "HeadlessCancellationError";
  }
}

class ExclusiveCaseLocks {
  private releasePromise?: Promise<void>;

  private constructor(private leases: OwnerLease[]) {}

  static async acquire(
    request: HeadlessOneShotRequestV1,
    workDir: string,
    picoHome: string,
    root = join(tmpdir(), "pico-headless-one-shot-locks"),
    removeLeaseDirectory?: (leaseDirectory: string) => Promise<void>,
  ): Promise<ExclusiveCaseLocks> {
    await secureLockDirectory(root);
    const keys = [
      `pico-home:${picoHome}`,
      `workspace:${workDir}`,
      `session:${picoHome}\0${workDir}\0${request.sessionId}`,
    ].sort();
    const acquired: OwnerLease[] = [];
    try {
      for (const key of keys) {
        const hash = createHash("sha256").update(key).digest("hex");
        await recoverLegacyLock(root, hash);
        acquired.push(
          await OwnerLease.acquire({
            leaseDirectory: join(root, `${hash}.lease`),
            ownerId: `headless:${request.requestId}:${request.sessionId}:${hash}`,
            staleAfterMs: 0,
            heartbeatIntervalMs: 1_000,
            ...(removeLeaseDirectory ? { removeLeaseDirectory } : {}),
          }),
        );
      }
      return new ExclusiveCaseLocks(acquired);
    } catch (error) {
      if (acquired.length > 0) {
        await releaseCaseLocks(new ExclusiveCaseLocks(acquired));
      }
      if (error instanceof LeaseConflictError) {
        throw new HeadlessRequestError(
          "CASE_RESOURCE_CONFLICT",
          "Another live or unverifiable headless case owns one of the requested resources.",
        );
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.leases.length === 0) return;
    if (this.releasePromise) return this.releasePromise;
    const release = this.releaseOnce();
    this.releasePromise = release;
    try {
      await release;
    } finally {
      if (this.releasePromise === release) this.releasePromise = undefined;
    }
  }

  private async releaseOnce(): Promise<void> {
    const remaining: OwnerLease[] = [];
    let firstError: unknown;
    for (const lease of [...this.leases].reverse()) {
      try {
        await lease.release();
      } catch (error) {
        remaining.unshift(lease);
        firstError ??= error;
      }
    }
    this.leases = remaining;
    if (firstError !== undefined) throw firstError;
  }
}

/**
 * Parse and execute exactly one internal headless request.
 *
 * The returned object is the complete stdout payload. Callers must not project Runtime events,
 * messages, raw ToolResults, or caught error text onto stdout.
 */
export async function runHeadlessOneShotJson(
  rawInput: string,
  dependencies: HeadlessOneShotDependencies = {},
): Promise<HeadlessOneShotOutcome> {
  const startedAt = dependencies.now?.() ?? Date.now();
  let parsed: unknown;
  try {
    if (Buffer.byteLength(rawInput, "utf8") > MAX_INPUT_BYTES) {
      throw new HeadlessRequestError(
        "INPUT_TOO_LARGE",
        "The headless request exceeds the supported size limit.",
      );
    }
    parsed = JSON.parse(rawInput) as unknown;
  } catch (error) {
    const requestError =
      error instanceof HeadlessRequestError
        ? error
        : new HeadlessRequestError(
            "INVALID_JSON",
            "stdin must contain exactly one valid JSON object.",
          );
    return invalidOutcome(undefined, requestError, elapsed(startedAt, dependencies.now));
  }

  let request: HeadlessOneShotRequestV1;
  try {
    request = parseRequest(parsed);
  } catch (error) {
    return invalidOutcome(
      requestIdentity(parsed),
      normalizeRequestError(error),
      elapsed(startedAt, dependencies.now),
    );
  }
  return runValidatedRequest(request, startedAt, dependencies);
}

async function runValidatedRequest(
  request: HeadlessOneShotRequestV1,
  startedAt: number,
  dependencies: HeadlessOneShotDependencies,
): Promise<HeadlessOneShotOutcome> {
  let effective: HeadlessOneShotEffectivePolicy = {
    modelRouteId: request.modelRouteId,
    thinkingEffort: request.thinkingEffort ?? null,
    permissionMode: request.permissionMode,
    allowedTools: request.allowedTools,
  };
  let workDir: string | null = null;
  let locks: ExclusiveCaseLocks | undefined;
  const cancellation = createCancellation(
    request.timeoutMs,
    dependencies.signal,
    dependencies.signalKind,
  );
  try {
    const casePaths = await racePreflight(canonicalizeCasePaths(request), cancellation);
    workDir = casePaths.workDir;
    const picoHome = casePaths.picoHome;

    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    try {
      await racePreflight(ensureWorkspaceTrusted(workDir, { store: trustStore }), cancellation);
    } catch (error) {
      if (error instanceof HeadlessCancellationError) throw error;
      throw new HeadlessRequestError(
        "WORKSPACE_UNTRUSTED",
        "The workspace is not trusted by this isolated PICO_HOME.",
      );
    }

    let modelRuntime;
    try {
      modelRuntime = await loadTrustedModelRuntime(
        request,
        workDir,
        picoHome,
        dependencies,
        cancellation,
      );
    } catch (error) {
      if (error instanceof HeadlessCancellationError || error instanceof HeadlessRequestError) {
        throw error;
      }
      throw new HeadlessRequestError(
        "MODEL_RUNTIME_INVALID",
        "The trusted user model configuration could not be loaded.",
      );
    }

    const route = modelRuntime.router.resolve(request.modelRouteId);
    if (!route || route.id !== request.modelRouteId) {
      throw new HeadlessRequestError(
        "MODEL_ROUTE_INVALID",
        "The requested model route is unavailable.",
      );
    }
    const requestedThinking = request.thinkingEffort ?? modelRuntime.config.defaults.thinkingEffort;
    const reasoning = coordinateReasoningLevel(
      route.capabilities.reasoningProfile,
      requestedThinking,
    );
    if (request.thinkingEffort !== undefined && reasoning.reason !== "requested") {
      throw new HeadlessRequestError(
        "THINKING_EFFORT_INVALID",
        "The requested thinking effort is unsupported by this model route.",
      );
    }
    const effectiveThinking = reasoning.level;
    let selected;
    try {
      selected = modelRuntime.router.providerConfig(route.id, effectiveThinking);
    } catch {
      throw new HeadlessRequestError(
        "MODEL_ROUTE_INVALID",
        "The requested model route is unavailable or lacks credentials.",
      );
    }

    effective = {
      modelRouteId: selected.route.id,
      thinkingEffort: effectiveThinking ?? null,
      permissionMode: request.permissionMode,
      allowedTools: request.allowedTools,
    };
    locks = await racePreflight(
      ExclusiveCaseLocks.acquire(
        request,
        workDir,
        picoHome,
        dependencies.lockRoot,
        dependencies.lockRemoveLeaseDirectory,
      ),
      cancellation,
      async (lateLocks) => {
        await releaseCaseLocks(lateLocks);
      },
    );
    await racePreflight(assertNewSession(request.sessionId, workDir, picoHome), cancellation);
    const traceBaseline = request.trace
      ? await racePreflight(
          snapshotSessionTraceFiles(workDir, picoHome, request.sessionId),
          cancellation,
        )
      : new Map<string, string>();

    let policyBlocked = false;
    const reporter = new SilentReporter();
    const runtimeEnv = isolatedRuntimeEnvironment(picoHome, dependencies.env ?? process.env);
    const runtimeDependencies: RunAgentCliDependencies = {
      signal: cancellation.signal,
      reporter,
      modelRouter: modelRuntime.router,
      picoHome,
      env: runtimeEnv,
      isolatedHeadless: true,
      pluginSnapshot: emptyPluginSnapshot(),
      onPolicyDenied: () => {
        policyBlocked = true;
      },
      ...(dependencies.providerFactory ? { providerFactory: dependencies.providerFactory } : {}),
    };
    const executeRuntime = dependencies.executeRuntime ?? executeAgentRuntime;
    const runtimePromise = executeRuntime(
      {
        prompt: request.prompt,
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: request.sessionId },
        provider: selected.provider,
        baseURL: selected.config.baseURL,
        apiKey: selected.config.apiKey,
        model: selected.config.model,
        modelRouteId: selected.route.id,
        modelCapabilities: selected.route.capabilities,
        interactionMode: request.permissionMode,
        ...(effectiveThinking !== undefined ? { thinkingEffort: effectiveThinking } : {}),
        allowedTools: request.allowedTools,
        trace: request.trace,
      },
      runtimeDependencies,
    );
    const settled = await settleRuntime(runtimePromise, cancellation, request.shutdownGraceMs);
    if (request.trace) await dependencies.beforeTraceSanitize?.();
    const traceWorkDir = workDir;
    const secrets = credentialCandidates(selected.config.apiKey);
    const safeTracePath = request.trace
      ? await sanitizeRuntimeTraces({
          workDir: traceWorkDir,
          picoHome,
          sessionId: request.sessionId,
          baseline: traceBaseline,
          secrets,
          tracePath: settled.result?.tracePath,
        })
      : undefined;
    if (!settled.shutdownConfirmed && locks) {
      const heldLocks = locks;
      locks = undefined;
      void runtimePromise
        .then(
          (lateResult) =>
            sanitizeRuntimeTraces({
              workDir: traceWorkDir,
              picoHome,
              sessionId: request.sessionId,
              baseline: traceBaseline,
              secrets,
              tracePath: lateResult.tracePath,
            }),
          () =>
            sanitizeRuntimeTraces({
              workDir: traceWorkDir,
              picoHome,
              sessionId: request.sessionId,
              baseline: traceBaseline,
              secrets,
            }),
        )
        .finally(() => releaseCaseLocks(heldLocks))
        .catch(() => undefined);
    }

    if (settled.cancelCause) {
      const mapped = cancellationOutcome(
        request,
        workDir,
        effective,
        settled.cancelCause,
        settled.shutdownConfirmed,
        elapsed(startedAt, dependencies.now),
      );
      return mapped;
    }
    if (settled.error !== undefined) {
      return failedOutcome(
        request,
        workDir,
        effective,
        "RUNTIME_FAILED",
        "The Agent Runtime failed.",
        elapsed(startedAt, dependencies.now),
      );
    }
    if (!settled.result) {
      return failedOutcome(
        request,
        workDir,
        effective,
        "RUNTIME_FAILED",
        "The Agent Runtime did not produce a result.",
        elapsed(startedAt, dependencies.now),
      );
    }
    if (
      settled.result.finalMessage.trim().length === 0 &&
      settled.result.usage.promptTokens === 0 &&
      settled.result.usage.completionTokens === 0
    ) {
      return failedOutcome(
        request,
        workDir,
        effective,
        "RUNTIME_EMPTY_RESPONSE",
        "The Agent Runtime returned an empty model response.",
        elapsed(startedAt, dependencies.now),
      );
    }
    if (policyBlocked) {
      return {
        result: resultPayload({
          request,
          status: "policy_blocked",
          workDir,
          effective,
          durationMs: elapsed(startedAt, dependencies.now),
          usage: settled.result.usage,
          tracePath: safeTracePath ?? null,
          error: {
            code: "POLICY_BLOCKED",
            summary: "The requested tool action was blocked by the effective policy.",
          },
        }),
        exitCode: 4,
        shutdownConfirmed: true,
      };
    }
    return {
      result: resultPayload({
        request,
        status: "completed",
        workDir,
        effective,
        durationMs: elapsed(startedAt, dependencies.now),
        finalMessage: redactSecrets(settled.result.finalMessage, secrets),
        usage: settled.result.usage,
        tracePath: safeTracePath ?? null,
      }),
      exitCode: 0,
      shutdownConfirmed: true,
    };
  } catch (error) {
    if (error instanceof HeadlessCancellationError) {
      return cancellationOutcome(
        request,
        workDir,
        effective,
        error.cancelCause,
        true,
        elapsed(startedAt, dependencies.now),
      );
    }
    if (error instanceof HeadlessRequestError) {
      return invalidOutcome(
        request,
        error,
        elapsed(startedAt, dependencies.now),
        workDir,
        effective,
      );
    }
    return failedOutcome(
      request,
      workDir,
      effective,
      "INTERNAL_FAILURE",
      "The headless runner failed.",
      elapsed(startedAt, dependencies.now),
    );
  } finally {
    cancellation.dispose();
    if (locks) await releaseCaseLocks(locks);
  }
}

async function loadTrustedModelRuntime(
  request: HeadlessOneShotRequestV1,
  workDir: string,
  picoHome: string,
  dependencies: HeadlessOneShotDependencies,
  cancellation: ReturnType<typeof createCancellation>,
) {
  const routeParts = splitModelRoute(request.modelRouteId);
  const durableStore = new UserConfigStore({ picoHome });
  const durableSnapshot = await racePreflight(durableStore.read(), cancellation);
  const provider = durableSnapshot.config.providers[routeParts.providerId];
  if (!provider || !provider.models?.includes(routeParts.modelId)) {
    throw new HeadlessRequestError(
      "MODEL_ROUTE_INVALID",
      "The requested model route is absent from the trusted user model catalog.",
    );
  }

  const selectedProvider: UserModelProviderConfig = Object.freeze({
    ...provider,
    models: Object.freeze([routeParts.modelId]),
    discoverModels: false,
  });
  const filteredSnapshot: UserConfigSnapshot = Object.freeze({
    revision: durableSnapshot.revision,
    config: Object.freeze({
      version: 1,
      defaults: Object.freeze({
        modelRouteId: request.modelRouteId,
        mode: request.permissionMode,
        ...(request.thinkingEffort ? { thinkingEffort: request.thinkingEffort } : {}),
      }),
      providers: Object.freeze({ [routeParts.providerId]: selectedProvider }),
    }),
  });
  const { apiKey: _configuredSecret, ...effectiveProvider } = selectedProvider;
  const config: EffectiveConfigSnapshot = Object.freeze({
    defaults: filteredSnapshot.config.defaults ?? {},
    defaultModelRouteId: request.modelRouteId,
    providers: Object.freeze({
      [routeParts.providerId]: Object.freeze(effectiveProvider as ModelProviderConfig),
    }),
    sources: Object.freeze({ [`providers.${routeParts.providerId}`]: "user" as const }),
    revisions: Object.freeze({
      user: filteredSnapshot.revision,
      project: EMPTY_USER_CONFIG_REVISION,
    }),
  });
  const modelEnv: Record<string, string | undefined> = { PICO_HOME: picoHome };
  const credentialName = selectedProvider.apiKeyEnv;
  if (credentialName) {
    modelEnv[credentialName] = (dependencies.env ?? process.env)[credentialName];
  }
  return await racePreflight(
    loadEffectiveModelRuntime({
      workDir,
      projectTrusted: false,
      legacyProvider: selectedProvider.protocol,
      legacyModel: routeParts.modelId,
      legacyModelExplicit: false,
      env: Object.freeze(modelEnv),
      userConfigStore: { read: async () => filteredSnapshot },
      configResolver: { resolve: async () => config },
      ...(dependencies.credentialVault ? { credentialVault: dependencies.credentialVault } : {}),
    }),
    cancellation,
  );
}

function splitModelRoute(routeId: string): { providerId: string; modelId: string } {
  const separator = routeId.indexOf("/");
  if (separator <= 0 || separator === routeId.length - 1) {
    throw new HeadlessRequestError(
      "MODEL_ROUTE_INVALID",
      "modelRouteId must identify an exact trusted provider/model route.",
    );
  }
  return {
    providerId: routeId.slice(0, separator),
    modelId: routeId.slice(separator + 1),
  };
}

function isolatedRuntimeEnvironment(
  picoHome: string,
  source: Readonly<Record<string, string | undefined>>,
): RunAgentCliDependencies["env"] {
  const runtimeHome = join(picoHome, "headless-home");
  const env: Record<string, string | undefined> = {
    PICO_HOME: picoHome,
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    XDG_CONFIG_HOME: join(runtimeHome, ".config"),
    XDG_DATA_HOME: join(runtimeHome, ".local", "share"),
    XDG_CACHE_HOME: join(runtimeHome, ".cache"),
  };
  for (const name of [
    "PATH",
    "SHELL",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return Object.freeze(env);
}

function emptyPluginSnapshot(): PluginRuntimeSnapshot {
  return Object.freeze({
    pluginIds: Object.freeze([]),
    skillSources: Object.freeze([]),
    commandSources: Object.freeze([]),
    agentSources: Object.freeze([]),
    hookSources: Object.freeze([]),
    mcpSources: Object.freeze([]),
    lspServers: Object.freeze([]),
    capabilities: Object.freeze([]),
    diagnostics: Object.freeze([]),
    dispose: async () => undefined,
  });
}

async function racePreflight<T>(
  promise: Promise<T>,
  cancellation: ReturnType<typeof createCancellation>,
  cleanupLateValue?: (value: T) => void | Promise<void>,
): Promise<T> {
  const outcome = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const first = await Promise.race([
    outcome,
    cancellation.canceled.then((cause) => ({ kind: "canceled" as const, cause })),
  ]);
  if (first.kind === "canceled") {
    if (cleanupLateValue) {
      void outcome
        .then(async (late) => {
          if (late.kind === "value") await cleanupLateValue(late.value);
        })
        .catch(() => undefined);
    }
    throw new HeadlessCancellationError(first.cause);
  }
  if (first.kind === "error") throw first.error;
  return first.value;
}

function parseRequest(value: unknown): HeadlessOneShotRequestV1 {
  if (!isRecord(value)) {
    throw new HeadlessRequestError("INVALID_REQUEST", "The request must be a JSON object.");
  }
  const unknownFields = Object.keys(value).filter((field) => !REQUEST_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new HeadlessRequestError("UNKNOWN_FIELD", "The request contains unsupported fields.");
  }
  if (REQUIRED_REQUEST_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    throw new HeadlessRequestError(
      "MISSING_FIELD",
      "The request is missing one or more required fields.",
    );
  }
  if (value["schemaVersion"] !== SCHEMA_VERSION) {
    throw new HeadlessRequestError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Only headless request schemaVersion 1 is supported.",
    );
  }

  const requestId = requiredString(value["requestId"], "requestId", 128);
  const workspacePath = requiredString(value["workspacePath"], "workspacePath", 4096);
  const picoHome = requiredString(value["picoHome"], "picoHome", 4096);
  const sessionId = requiredString(value["sessionId"], "sessionId", 128);
  const prompt = requiredString(value["prompt"], "prompt", MAX_PROMPT_LENGTH, false);
  const modelRouteId = requiredString(value["modelRouteId"], "modelRouteId", 512);
  const permissionMode = value["permissionMode"];
  if (typeof permissionMode !== "string" || !INTERACTION_MODES.has(permissionMode as never)) {
    throw new HeadlessRequestError(
      "INVALID_PERMISSION_MODE",
      "permissionMode must be one of default, auto, plan, or yolo.",
    );
  }
  if (!Array.isArray(value["allowedTools"]) || value["allowedTools"].length > 128) {
    throw new HeadlessRequestError(
      "INVALID_ALLOWED_TOOLS",
      "allowedTools must be a bounded array of tool names.",
    );
  }
  const allowedTools = value["allowedTools"].map((tool) =>
    requiredString(tool, "allowedTools", 128),
  );
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new HeadlessRequestError(
      "INVALID_ALLOWED_TOOLS",
      "allowedTools must not contain duplicate names.",
    );
  }
  if (allowedTools.some((tool) => !HEADLESS_TOOL_NAMES.has(tool))) {
    throw new HeadlessRequestError(
      "ALLOWED_TOOLS_INVALID",
      "allowedTools contains a tool unavailable to the isolated headless runner.",
    );
  }
  const timeoutMs = requiredInteger(value["timeoutMs"], "timeoutMs", 1, MAX_TIMEOUT_MS);
  const shutdownGraceMs = requiredInteger(
    value["shutdownGraceMs"],
    "shutdownGraceMs",
    0,
    MAX_SHUTDOWN_GRACE_MS,
  );
  if (typeof value["trace"] !== "boolean") {
    throw new HeadlessRequestError("INVALID_TRACE", "trace must be a boolean.");
  }
  const thinkingEffort =
    value["thinkingEffort"] === undefined
      ? undefined
      : requiredString(value["thinkingEffort"], "thinkingEffort", 64);

  if (!isAbsolute(workspacePath) || !isAbsolute(picoHome)) {
    throw new HeadlessRequestError(
      "PATH_NOT_ABSOLUTE",
      "workspacePath and picoHome must both be absolute paths.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId)) {
    throw new HeadlessRequestError(
      "INVALID_SESSION_ID",
      "sessionId contains unsupported characters.",
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    workspacePath,
    picoHome,
    sessionId,
    prompt,
    modelRouteId,
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    permissionMode: permissionMode as SessionSettings["mode"],
    allowedTools: Object.freeze(allowedTools),
    timeoutMs,
    shutdownGraceMs,
    trace: value["trace"],
  };
}

async function canonicalizeCasePaths(
  request: HeadlessOneShotRequestV1,
): Promise<{ workDir: string; picoHome: string }> {
  let workDir: string;
  let picoHome: string;
  try {
    [workDir, picoHome] = await Promise.all([
      canonicalDirectory(request.workspacePath),
      canonicalDirectory(request.picoHome),
    ]);
  } catch {
    throw new HeadlessRequestError(
      "PATH_INVALID",
      "workspacePath and picoHome must identify existing physical directories.",
    );
  }
  const defaultPicoHome = resolvePicoHome({ homeDir: homedir(), env: {} });
  if (resolve(picoHome) === resolve(defaultPicoHome)) {
    throw new HeadlessRequestError(
      "PICO_HOME_NOT_ISOLATED",
      "The default user PICO_HOME is not accepted by the internal headless runner.",
    );
  }
  if (pathsOverlap(workDir, picoHome)) {
    throw new HeadlessRequestError(
      "CASE_PATH_OVERLAP",
      "workspacePath and picoHome must be independent directory trees.",
    );
  }
  return { workDir, picoHome };
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw new Error("not a directory");
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return isWithin(leftToRight) || isWithin(rightToLeft);
}

function isWithin(relativePath: string): boolean {
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function assertNewSession(
  sessionId: string,
  workDir: string,
  picoHome: string,
): Promise<void> {
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  if (await store.readSessionManifest(sessionId)) {
    throw new HeadlessRequestError(
      "SESSION_ALREADY_EXISTS",
      "The internal one-shot runner only accepts a unique new Session ID.",
    );
  }
}

function createCancellation(
  timeoutMs: number,
  externalSignal?: AbortSignal,
  externalSignalKind?: "SIGINT" | "SIGTERM",
): {
  readonly signal: AbortSignal;
  readonly canceled: Promise<CancelCause>;
  cause(): CancelCause | undefined;
  dispose(): void;
} {
  const controller = new AbortController();
  let cancelCause: CancelCause | undefined;
  let resolveCanceled!: (cause: CancelCause) => void;
  const canceled = new Promise<CancelCause>((resolveCanceledPromise) => {
    resolveCanceled = resolveCanceledPromise;
  });
  const cancel = (cause: CancelCause) => {
    if (cancelCause !== undefined) return;
    cancelCause = cause;
    controller.abort(new DOMException(cause, "AbortError"));
    resolveCanceled(cause);
  };
  const timeout = setTimeout(() => cancel("timeout"), timeoutMs);
  const onExternalAbort = () =>
    cancel(externalSignalKind ?? cancelCauseFromReason(externalSignal?.reason));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    canceled,
    cause: () => cancelCause,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function cancelCauseFromReason(reason: unknown): Exclude<CancelCause, "timeout"> {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  if (text === "SIGTERM") return "SIGTERM";
  if (text === "SIGINT") return "SIGINT";
  return "canceled";
}

async function settleRuntime(
  runtimePromise: Promise<RunAgentCliResult>,
  cancellation: ReturnType<typeof createCancellation>,
  shutdownGraceMs: number,
): Promise<{
  readonly result?: RunAgentCliResult;
  readonly error?: unknown;
  readonly cancelCause?: CancelCause;
  readonly shutdownConfirmed: boolean;
}> {
  const outcome = runtimePromise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  const first = await Promise.race([
    outcome.then((value) => ({ kind: "runtime" as const, value })),
    cancellation.canceled.then((cause) => ({ kind: "cancel" as const, cause })),
  ]);
  if (first.kind === "runtime") {
    const cause = cancellation.cause();
    return {
      ...first.value,
      ...(cause ? { cancelCause: cause } : {}),
      shutdownConfirmed: true,
    };
  }
  const afterCancel = await Promise.race([
    outcome.then((value) => ({ kind: "runtime" as const, value })),
    delay(shutdownGraceMs).then(() => ({ kind: "grace" as const })),
  ]);
  if (afterCancel.kind === "runtime") {
    return {
      ...afterCancel.value,
      cancelCause: first.cause,
      shutdownConfirmed: true,
    };
  }
  return { cancelCause: first.cause, shutdownConfirmed: false };
}

function cancellationOutcome(
  request: HeadlessOneShotRequestV1,
  workDir: string | null,
  effective: HeadlessOneShotEffectivePolicy,
  cause: CancelCause,
  shutdownConfirmed: boolean,
  durationMs: number,
): HeadlessOneShotOutcome {
  const status = cause === "timeout" ? "timed_out" : "canceled";
  const exitCode = cause === "timeout" ? 124 : cause === "SIGTERM" ? 143 : 130;
  return {
    result: resultPayload({
      request,
      status,
      workDir,
      effective,
      durationMs,
      error: {
        code: shutdownConfirmed
          ? cause === "timeout"
            ? "TIMEOUT"
            : cause
          : "SHUTDOWN_UNCONFIRMED",
        summary: shutdownConfirmed
          ? cause === "timeout"
            ? "The Agent Runtime exceeded timeoutMs and stopped."
            : "The Agent Runtime was canceled by the host signal."
          : "The cancellation grace period elapsed before Runtime shutdown could be confirmed.",
      },
      terminationConfirmed: shutdownConfirmed,
    }),
    exitCode,
    shutdownConfirmed,
  };
}

function invalidOutcome(
  request: HeadlessOneShotRequestV1 | { requestId?: string; sessionId?: string } | undefined,
  error: HeadlessRequestError,
  durationMs: number,
  workDir: string | null = null,
  effective?: HeadlessOneShotEffectivePolicy,
): HeadlessOneShotOutcome {
  return {
    result: resultPayload({
      request,
      status: "invalid_request",
      workDir,
      effective: effective ?? emptyEffective(request),
      durationMs,
      error: { code: error.code, summary: error.summary },
    }),
    exitCode: 2,
    shutdownConfirmed: true,
  };
}

function failedOutcome(
  request: HeadlessOneShotRequestV1,
  workDir: string | null,
  effective: HeadlessOneShotEffectivePolicy,
  code: string,
  summary: string,
  durationMs: number,
): HeadlessOneShotOutcome {
  return {
    result: resultPayload({
      request,
      status: "failed",
      workDir,
      effective,
      durationMs,
      error: { code, summary },
    }),
    exitCode: 3,
    shutdownConfirmed: true,
  };
}

function resultPayload(input: {
  request: HeadlessOneShotRequestV1 | { requestId?: string; sessionId?: string } | undefined;
  status: HeadlessOneShotStatus;
  workDir: string | null;
  effective: HeadlessOneShotEffectivePolicy;
  durationMs: number;
  finalMessage?: string;
  usage?: RunAgentUsage;
  tracePath?: string | null;
  error?: HeadlessOneShotError;
  terminationConfirmed?: boolean;
}): HeadlessOneShotResultV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: input.request?.requestId ?? null,
    status: input.status,
    sessionId: input.request?.sessionId ?? null,
    workDir: input.workDir,
    finalMessage: input.finalMessage ?? null,
    usage: input.usage ?? EMPTY_USAGE,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    tracePath: input.tracePath ?? null,
    effective: input.effective,
    error: input.error ?? null,
    terminationConfirmed: input.terminationConfirmed ?? true,
  };
}

function emptyEffective(
  request: HeadlessOneShotRequestV1 | { requestId?: string; sessionId?: string } | undefined,
): HeadlessOneShotEffectivePolicy {
  const candidate = request as Partial<HeadlessOneShotRequestV1> | undefined;
  return {
    modelRouteId: candidate?.modelRouteId ?? null,
    thinkingEffort: candidate?.thinkingEffort ?? null,
    permissionMode: candidate?.permissionMode ?? null,
    allowedTools: candidate?.allowedTools ?? [],
  };
}

function requestIdentity(value: unknown): { requestId?: string; sessionId?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = safeIdentity(value["requestId"]);
  const sessionId = safeIdentity(value["sessionId"], true);
  return {
    ...(requestId ? { requestId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function safeIdentity(value: unknown, session = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  if (session && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) return undefined;
  return normalized;
}

function requiredString(value: unknown, field: string, maxLength: number, trim = true): string {
  if (typeof value !== "string") {
    throw new HeadlessRequestError("INVALID_FIELD", `${field} must be a string.`);
  }
  const normalized = trim ? value.trim() : value;
  if (
    normalized.trim().length === 0 ||
    normalized.length > maxLength ||
    normalized.includes("\0")
  ) {
    throw new HeadlessRequestError(
      "INVALID_FIELD",
      `${field} is empty or exceeds its supported boundary.`,
    );
  }
  return normalized;
}

function requiredInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new HeadlessRequestError(
      "INVALID_FIELD",
      `${field} is outside its supported integer range.`,
    );
  }
  return value as number;
}

function normalizeRequestError(error: unknown): HeadlessRequestError {
  return error instanceof HeadlessRequestError
    ? error
    : new HeadlessRequestError("INVALID_REQUEST", "The headless request is invalid.");
}

function elapsed(startedAt: number, now?: () => number): number {
  return (now?.() ?? Date.now()) - startedAt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function secureLockDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: LOCK_DIRECTORY_MODE });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new HeadlessRequestError(
      "LOCK_ROOT_INVALID",
      "The machine-local headless lock root is not a physical directory.",
    );
  }
  await chmod(path, LOCK_DIRECTORY_MODE);
}

async function recoverLegacyLock(root: string, hash: string): Promise<void> {
  const path = join(root, `${hash}.lock`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return;
    throw error;
  }
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) {
    throw new HeadlessRequestError(
      "CASE_RESOURCE_CONFLICT",
      "Another live or unverifiable headless case owns one of the requested resources.",
    );
  }
  await unlink(path).catch((error: unknown) => {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  });
}

async function releaseCaseLocks(locks: ExclusiveCaseLocks): Promise<boolean> {
  try {
    await locks.release();
    clearPendingLockRelease(locks);
    return true;
  } catch {
    schedulePendingLockRelease(locks);
    return false;
  }
}

function schedulePendingLockRelease(locks: ExclusiveCaseLocks): void {
  const state = pendingLockReleases.get(locks) ?? { attempt: 0 };
  if (state.timer) return;
  const delayMs = Math.min(1_000, 10 * 2 ** Math.min(state.attempt, 7));
  state.attempt++;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void releaseCaseLocks(locks);
  }, delayMs);
  state.timer.unref();
  pendingLockReleases.set(locks, state);
}

function clearPendingLockRelease(locks: ExclusiveCaseLocks): void {
  const state = pendingLockReleases.get(locks);
  if (state?.timer) clearTimeout(state.timer);
  pendingLockReleases.delete(locks);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}

function credentialCandidates(routeCredential: string): readonly string[] {
  return [...new Set([routeCredential].filter((candidate) => candidate.length >= 6))].sort(
    (left, right) => right.length - left.length,
  );
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

interface RuntimeTraceSanitizationInput {
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly baseline: ReadonlyMap<string, string>;
  readonly secrets: readonly string[];
  readonly tracePath?: string;
}

async function sanitizeRuntimeTraces(
  input: RuntimeTraceSanitizationInput,
): Promise<string | undefined> {
  const traceDirectory = resolvePicoPaths(input.workDir, {
    picoHome: input.picoHome,
  }).workspace.traces;
  const current = await snapshotSessionTraceFiles(input.workDir, input.picoHome, input.sessionId);
  const createdPaths = [...current]
    .filter(([name, signature]) => input.baseline.get(name) !== signature)
    .map(([name]) => join(traceDirectory, name));
  const paths = new Set(createdPaths);
  if (input.tracePath) paths.add(input.tracePath);

  let safeResultPath: string | undefined;
  for (const path of paths) {
    const safePath = await sanitizeTrace(path, input.secrets);
    if (path === input.tracePath) safeResultPath = safePath;
  }
  return safeResultPath;
}

async function snapshotSessionTraceFiles(
  workDir: string,
  picoHome: string,
  sessionId: string,
): Promise<Map<string, string>> {
  const traceDirectory = resolvePicoPaths(workDir, { picoHome }).workspace.traces;
  const prefix = `trace_${sessionId.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}_`;
  try {
    const entries = await readdir(traceDirectory, { withFileTypes: true });
    const candidates = entries.filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"),
    );
    const snapshots = await Promise.all(
      candidates.map(async (entry): Promise<readonly [string, string] | undefined> => {
        try {
          const info = await lstat(join(traceDirectory, entry.name), { bigint: true });
          if (!info.isFile()) return undefined;
          return [
            entry.name,
            `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
          ] as const;
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) return undefined;
          throw error;
        }
      }),
    );
    return new Map(snapshots.filter((entry) => entry !== undefined));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return new Map();
    throw error;
  }
}

async function sanitizeTrace(
  tracePath: string,
  secrets: readonly string[],
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(tracePath, "utf8")) as unknown;
    const metadataOnly = sanitizeTraceNode(parsed);
    const redacted = redactSecrets(JSON.stringify(metadataOnly, null, 2), secrets);
    await mkdir(dirname(tracePath), { recursive: true, mode: 0o700 });
    await writeFile(tracePath, redacted, { encoding: "utf8", mode: 0o600 });
    await chmod(tracePath, 0o600);
    return tracePath;
  } catch {
    await unlink(tracePath).catch(() => undefined);
    return undefined;
  }
}

function sanitizeTraceNode(value: unknown, insideAttributes = false): unknown {
  if (typeof value === "string") return insideAttributes ? "[REDACTED]" : value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceNode(item, insideAttributes));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizeTraceNode(item, insideAttributes || key === "attributes"),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
