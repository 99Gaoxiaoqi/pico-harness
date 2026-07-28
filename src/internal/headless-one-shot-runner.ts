import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SilentReporter } from "../engine/reporter.js";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import { EffectiveConfigResolver } from "../input/effective-config.js";
import type { SessionSettings } from "../input/session-settings.js";
import { UserConfigStore } from "../input/user-config-store.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import type { CredentialVault } from "../provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../provider/effective-model-runtime.js";
import { coordinateReasoningLevel } from "../provider/reasoning-capability.js";
import {
  executeAgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentProviderFactory,
} from "../runtime/agent-runtime.js";
import type { RunAgentCliResult, RunAgentUsage } from "../runtime/runtime-contract.js";
import { RuntimeEventStore } from "../storage/runtime-event-store.js";
import { ensureWorkspaceTrusted, WorkspaceTrustStore } from "../security/workspace-trust.js";

const SCHEMA_VERSION = 1 as const;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1024 * 1024;
const MAX_SHUTDOWN_GRACE_MS = 60_000;
const MAX_TIMEOUT_MS = 7_200_000;
const LOCK_DIRECTORY_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;
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

class HeadlessPolicyReporter extends SilentReporter {
  policyBlocked = false;

  override onToolResult(result: ToolResultEnvelope): void {
    if (
      result.status === "rejected" ||
      /执行被(?:系统|Guardrail)拦截|安全拒绝|拒绝了该工具调用/u.test(result.projection.text)
    ) {
      this.policyBlocked = true;
    }
  }
}

class ExclusiveCaseLocks {
  private constructor(private readonly files: readonly { path: string; handle: FileHandle }[]) {}

  static async acquire(
    request: HeadlessOneShotRequestV1,
    workDir: string,
    picoHome: string,
    root = join(tmpdir(), "pico-headless-one-shot-locks"),
  ): Promise<ExclusiveCaseLocks> {
    await secureLockDirectory(root);
    const keys = [
      `pico-home:${picoHome}`,
      `workspace:${workDir}`,
      `session:${picoHome}\0${workDir}\0${request.sessionId}`,
    ].sort();
    const acquired: { path: string; handle: FileHandle }[] = [];
    try {
      for (const key of keys) {
        const name = createHash("sha256").update(key).digest("hex");
        const path = join(root, `${name}.lock`);
        let handle: FileHandle;
        try {
          handle = await open(path, "wx", LOCK_FILE_MODE);
        } catch (error) {
          if (isErrnoCode(error, "EEXIST")) {
            throw new HeadlessRequestError(
              "CASE_RESOURCE_CONFLICT",
              "The requested PICO_HOME, workspace, or Session is already owned by another case.",
            );
          }
          throw error;
        }
        await handle.writeFile(`${process.pid}\n`, "utf8");
        acquired.push({ path, handle });
      }
      return new ExclusiveCaseLocks(acquired);
    } catch (error) {
      await releaseLockFiles(acquired, true);
      throw error;
    }
  }

  release(removeFiles: boolean): Promise<void> {
    return releaseLockFiles(this.files, removeFiles);
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
  const baseEffective: HeadlessOneShotEffectivePolicy = {
    modelRouteId: request.modelRouteId,
    thinkingEffort: request.thinkingEffort ?? null,
    permissionMode: request.permissionMode,
    allowedTools: request.allowedTools,
  };
  let workDir: string | null = null;
  let locks: ExclusiveCaseLocks | undefined;
  let shutdownConfirmed = true;
  const cancellation = createCancellation(
    request.timeoutMs,
    dependencies.signal,
    dependencies.signalKind,
  );
  try {
    const casePaths = await canonicalizeCasePaths(request);
    workDir = casePaths.workDir;
    const picoHome = casePaths.picoHome;
    locks = await ExclusiveCaseLocks.acquire(request, workDir, picoHome, dependencies.lockRoot);

    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    try {
      await ensureWorkspaceTrusted(workDir, { store: trustStore });
    } catch {
      throw new HeadlessRequestError(
        "WORKSPACE_UNTRUSTED",
        "The workspace is not trusted by this isolated PICO_HOME.",
      );
    }

    await assertNewSession(request.sessionId, workDir, picoHome);
    const env = Object.freeze({
      ...(dependencies.env ?? process.env),
      PICO_HOME: picoHome,
    });
    const userConfigStore = new UserConfigStore({ picoHome });
    const configResolver = new EffectiveConfigResolver({ userConfigStore });
    let modelRuntime;
    try {
      modelRuntime = await loadEffectiveModelRuntime({
        workDir,
        projectTrusted: true,
        legacyProvider: "openai",
        legacyModel: "unused-headless-model",
        legacyModelExplicit: false,
        env,
        userConfigStore,
        configResolver,
        ...(dependencies.credentialVault ? { credentialVault: dependencies.credentialVault } : {}),
      });
    } catch {
      throw new HeadlessRequestError(
        "MODEL_RUNTIME_INVALID",
        "The effective model configuration could not be loaded.",
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

    const effective: HeadlessOneShotEffectivePolicy = {
      modelRouteId: selected.route.id,
      thinkingEffort: effectiveThinking ?? null,
      permissionMode: request.permissionMode,
      allowedTools: request.allowedTools,
    };
    const reporter = new HeadlessPolicyReporter();
    const runtimeDependencies: RunAgentCliDependencies = {
      signal: cancellation.signal,
      reporter,
      modelRouter: modelRuntime.router,
      picoHome,
      env: { ...env },
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
    shutdownConfirmed = settled.shutdownConfirmed;

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
      if (/allowed-tools.*未知工具|allowed-tools.*空值/iu.test(errorText(settled.error))) {
        return invalidOutcome(
          request,
          new HeadlessRequestError(
            "ALLOWED_TOOLS_INVALID",
            "The tool allowlist contains an unavailable tool.",
          ),
          elapsed(startedAt, dependencies.now),
          workDir,
          effective,
        );
      }
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
    const secrets = credentialCandidates(env, selected.config.apiKey);
    await redactTrace(settled.result.tracePath, secrets);
    if (reporter.policyBlocked) {
      return {
        result: resultPayload({
          request,
          status: "policy_blocked",
          workDir,
          effective,
          durationMs: elapsed(startedAt, dependencies.now),
          tracePath: settled.result.tracePath ?? null,
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
        tracePath: settled.result.tracePath ?? null,
      }),
      exitCode: 0,
      shutdownConfirmed: true,
    };
  } catch (error) {
    if (error instanceof HeadlessRequestError) {
      return invalidOutcome(
        request,
        error,
        elapsed(startedAt, dependencies.now),
        workDir,
        baseEffective,
      );
    }
    return failedOutcome(
      request,
      workDir,
      baseEffective,
      "INTERNAL_FAILURE",
      "The headless runner failed.",
      elapsed(startedAt, dependencies.now),
    );
  } finally {
    cancellation.dispose();
    if (locks) await locks.release(shutdownConfirmed);
  }
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
  workDir: string,
  effective: HeadlessOneShotEffectivePolicy,
  cause: CancelCause,
  shutdownConfirmed: boolean,
  durationMs: number,
): HeadlessOneShotOutcome {
  const status = shutdownConfirmed ? (cause === "timeout" ? "timed_out" : "canceled") : "failed";
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function releaseLockFiles(
  files: readonly { path: string; handle: FileHandle }[],
  removeFiles: boolean,
): Promise<void> {
  for (const file of [...files].reverse()) {
    await file.handle.close().catch(() => undefined);
    if (removeFiles) await unlink(file.path).catch(() => undefined);
  }
}

function credentialCandidates(
  env: Readonly<Record<string, string | undefined>>,
  routeCredential: string,
): readonly string[] {
  const candidates = [routeCredential];
  for (const [name, value] of Object.entries(env)) {
    if (!/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(name)) continue;
    if (value) candidates.push(value);
  }
  return [...new Set(candidates.filter((candidate) => candidate.length >= 6))].sort(
    (left, right) => right.length - left.length,
  );
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

async function redactTrace(
  tracePath: string | undefined,
  secrets: readonly string[],
): Promise<void> {
  if (!tracePath || secrets.length === 0) return;
  const raw = await readFile(tracePath, "utf8");
  const redacted = redactSecrets(raw, secrets);
  if (redacted === raw) return;
  await mkdir(dirname(tracePath), { recursive: true, mode: 0o700 });
  await writeFile(tracePath, redacted, { encoding: "utf8", mode: 0o600 });
  await chmod(tracePath, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
