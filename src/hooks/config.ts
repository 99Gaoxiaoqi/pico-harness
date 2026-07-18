import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { logger } from "../observability/logger.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { emptyHookSnapshot } from "./service.js";
import { HookLocalStateStore } from "./management/state.js";
import { HookTrustStore, type HookTrustAuthority, type HookTrustStatus } from "./trust/store.js";
import {
  HOOK_EVENTS,
  type AgentHookHandler,
  type CommandHookHandler,
  type HookCondition,
  type HookDiagnostic,
  type HookEvent,
  type HookHandler,
  type HookMatcherGroup,
  type HookSnapshot,
  type HookSource,
  type HookSourceKind,
  type HooksConfig,
  type HttpHookHandler,
  type McpToolHookHandler,
  type PromptHookHandler,
  type ResolvedHookHandler,
} from "./types.js";

const EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);
const CONDITION_OPERATORS = new Set(["equals", "contains", "regex", "exists"]);

export interface HookConfigSourceSpec {
  kind: HookSourceKind;
  path: string;
  format?: "canonical" | "legacy";
  componentId?: string;
  /** plugin/managed 由宿主显式提供；加载器不会自行发现或启用 plugin runtime。 */
  enabled?: boolean;
  /** Skill/Agent frontmatter 已由组件加载器解析时，以受信的内联值传入。 */
  inlineHooks?: unknown;
  /**
   * Host-only executable trust authority. This is intentionally injected by the runtime for
   * immutable extension snapshots; config files cannot create one.
   */
  trustAuthority?: HookTrustAuthority;
}

export interface LoadHookSnapshotOptions {
  workDir: string;
  userHome?: string;
  /** Host-owned Pico state root. Takes precedence over the legacy userHome seam. */
  picoHome?: string;
  trustStore?: HookTrustStore;
  stateStore?: HookLocalStateStore;
  componentSources?: readonly HookConfigSourceSpec[];
  extensionSources?: readonly HookConfigSourceSpec[];
  version?: number;
}

export interface LoadedHookSource {
  source: HookSource;
  config?: HooksConfig;
  status: "loaded" | "missing" | "invalid" | "disabled";
  error?: string;
}

export interface LoadHookSnapshotResult {
  snapshot: HookSnapshot;
  sources: readonly LoadedHookSource[];
  /** 初次启动可继续使用其他合法源；热重载据此决定是否保留旧快照。 */
  hasErrors: boolean;
  watchedPaths: readonly string[];
}

export function defaultHookConfigSources(
  workDir: string,
  userHome?: string,
  picoHome?: string,
): readonly HookConfigSourceSpec[] {
  const resolvedPicoHome = picoHome ?? (userHome ? join(userHome, ".pico") : resolvePicoHome());
  return [
    { kind: "user", path: join(resolvedPicoHome, "hooks.json") },
    { kind: "project", path: join(workDir, ".pico", "hooks.json") },
    { kind: "local", path: join(workDir, ".claw", "hooks.local.json") },
    {
      kind: "legacy",
      path: join(workDir, ".claw", "settings.json"),
      format: "legacy",
    },
  ];
}

export async function loadHookSnapshot(
  options: LoadHookSnapshotOptions,
): Promise<LoadHookSnapshotResult> {
  const workspace = await canonicalPath(options.workDir);
  const specs = [
    ...defaultHookConfigSources(workspace, options.userHome, options.picoHome),
    ...(options.componentSources ?? []),
    ...(options.extensionSources ?? []),
  ];
  const trustStore =
    options.trustStore ??
    new HookTrustStore({
      ...(options.userHome ? { userHome: options.userHome } : {}),
      ...(options.picoHome ? { picoHome: options.picoHome } : {}),
    });
  const stateStore =
    options.stateStore ??
    new HookLocalStateStore(workspace, {
      ...(options.picoHome
        ? { picoHome: options.picoHome }
        : options.userHome
          ? { picoHome: join(options.userHome, ".pico") }
          : {}),
    });
  let localState: Readonly<Record<string, boolean>> = {};
  let stateError: string | undefined;
  try {
    localState = await stateStore.getAll();
  } catch (error) {
    stateError = errorMessage(error);
  }
  const loadedSources: LoadedHookSource[] = [];
  const resolvedHandlers = blankHandlers();
  const diagnostics: HookDiagnostic[] = [];
  let order = 0;

  for (const spec of specs) {
    const loaded = await loadSource(spec, options.version ?? 1);
    loadedSources.push(loaded);
    if (loaded.status !== "loaded" || !loaded.config) continue;
    for (const event of HOOK_EVENTS) {
      for (const group of loaded.config[event] ?? []) {
        for (const handler of group.hooks) {
          const id = normalizedHandlerId(loaded.source, event, group, handler);
          const trust = await executableTrustStatus(handler, trustStore, workspace, loaded.source);
          const effectiveHandler =
            localState[id] === undefined
              ? handler
              : ({ ...handler, enabled: localState[id] } satisfies HookHandler);
          resolvedHandlers[event].push({
            id,
            event,
            source: loaded.source,
            order: order++,
            ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
            ...(group.if === undefined ? {} : { groupCondition: group.if }),
            handler: deepFreeze(effectiveHandler),
            trusted: trust === "active",
          });
        }
      }
    }
  }

  const version = options.version ?? 1;
  const handlers = Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, Object.freeze(resolvedHandlers[event].slice())]),
  ) as Readonly<Record<HookEvent, readonly ResolvedHookHandler[]>>;
  for (const source of loadedSources) {
    if (source.status !== "invalid") continue;
    diagnostics.push({
      handlerId: `source:${source.source.kind}`,
      source: source.source,
      level: "error",
      message: source.error ?? "Hook 配置无效",
    });
  }
  if (stateError) {
    diagnostics.push({
      handlerId: "source:local-state",
      source: { kind: "local", path: stateStore.filePath, version },
      level: "error",
      message: stateError,
    });
  }
  const snapshot: HookSnapshot = deepFreeze({
    id: snapshotId(workspace, version, handlers),
    version,
    createdAt: new Date().toISOString(),
    handlers,
    diagnostics,
  });
  return {
    snapshot,
    sources: Object.freeze(loadedSources),
    hasErrors: loadedSources.some((source) => source.status === "invalid"),
    watchedPaths: Object.freeze([
      ...specs.filter((spec) => spec.enabled !== false).map((spec) => spec.path),
      stateStore.filePath,
      trustStore.filePath,
    ]),
  };
}

export async function loadSource(
  spec: HookConfigSourceSpec,
  version = 1,
): Promise<LoadedHookSource> {
  const source: HookSource = {
    kind: spec.kind,
    path: await canonicalPath(spec.path),
    version,
    ...(spec.componentId === undefined ? {} : { componentId: spec.componentId }),
    ...(spec.trustAuthority === undefined ? {} : { trustAuthority: spec.trustAuthority }),
  };
  if (spec.enabled === false) return { source, status: "disabled" };
  let parsed: unknown;
  if (spec.inlineHooks !== undefined) {
    parsed = spec.inlineHooks;
  } else {
    let raw: string;
    try {
      raw = await readFile(source.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { source, status: "missing" };
      return { source, status: "invalid", error: errorMessage(error) };
    }
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { source, status: "invalid", error: `JSON 解析失败: ${errorMessage(error)}` };
    }
  }
  const legacy = spec.format === "legacy" || spec.kind === "legacy";
  const field = legacy ? objectField(parsed, "hooks") : parsed;
  if (field === undefined) return { source, status: "missing" };
  try {
    const config = normalizeHooksConfig(field, { legacy });
    return config ? { source, status: "loaded", config } : { source, status: "missing" };
  } catch (error) {
    return { source, status: "invalid", error: errorMessage(error) };
  }
}

export function normalizeCanonicalHooksConfig(input: unknown): HooksConfig | undefined {
  return normalizeHooksConfig(input, { legacy: false });
}

function normalizeHooksConfig(
  input: unknown,
  options: { legacy: boolean },
): HooksConfig | undefined {
  if (!isRecord(input)) {
    if (options.legacy) return undefined;
    throw new Error("hooks 顶层必须是对象");
  }
  const config: HooksConfig = {};
  let count = 0;
  for (const [eventName, rawGroups] of Object.entries(input)) {
    if (!EVENT_SET.has(eventName)) {
      if (options.legacy) continue;
      throw new Error(`不支持的 Hook 事件: ${eventName}`);
    }
    const groups = normalizeGroups(rawGroups, options);
    if (groups.length > 0) {
      config[eventName as HookEvent] = groups;
      count += groups.reduce((total, group) => total + group.hooks.length, 0);
    }
  }
  return count > 0 ? config : undefined;
}

function normalizeGroups(input: unknown, options: { legacy: boolean }): HookMatcherGroup[] {
  if (!Array.isArray(input)) return invalidOrEmpty(options, "matcher group 必须是数组");
  const groups: HookMatcherGroup[] = [];
  for (const raw of input) {
    try {
      if (!isRecord(raw)) throw new Error("matcher group 必须是对象");
      if (!options.legacy) assertOnlyKeys(raw, ["matcher", "if", "hooks"], "matcher group");
      const matcher = optionalString(raw.matcher, "matcher");
      if (matcher !== undefined) validateRegexOrMatcher(matcher);
      const condition = raw.if === undefined ? undefined : normalizeCondition(raw.if);
      if (!Array.isArray(raw.hooks)) throw new Error("matcher group.hooks 必须是数组");
      const hooks: HookHandler[] = [];
      for (const hook of raw.hooks) {
        try {
          hooks.push(normalizeHandler(hook, options));
        } catch (error) {
          if (!options.legacy) throw error;
        }
      }
      if (hooks.length === 0) {
        if (!options.legacy) throw new Error("matcher group 至少需要一个有效 handler");
        continue;
      }
      groups.push({
        ...(matcher === undefined ? {} : { matcher }),
        ...(condition === undefined ? {} : { if: condition }),
        hooks,
      });
    } catch (error) {
      if (!options.legacy) throw error;
    }
  }
  return groups;
}

function normalizeHandler(input: unknown, options: { legacy: boolean }): HookHandler {
  if (!isRecord(input)) throw new Error("handler 必须是对象");
  const type = requiredString(input.type, "handler.type");
  const common = normalizeHandlerCommon(input, options);
  switch (type) {
    case "command": {
      if (!options.legacy)
        assertOnlyKeys(
          input,
          ["type", "command", "args", "async", "asyncRewake", "env", "timeout", "if", "enabled"],
          "command handler",
        );
      const command = requiredNonEmpty(input.command, "command");
      const args = optionalStringArray(input.args, "args");
      const env = optionalStringRecord(input.env, "env");
      return {
        type,
        command,
        ...common,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
        ...(input.async === undefined ? {} : { async: requiredBoolean(input.async, "async") }),
        ...(input.asyncRewake === undefined
          ? {}
          : { asyncRewake: requiredBoolean(input.asyncRewake, "asyncRewake") }),
      } satisfies CommandHookHandler;
    }
    case "http": {
      if (!options.legacy)
        assertOnlyKeys(
          input,
          [
            "type",
            "url",
            "headers",
            "allowedEnv",
            "maxResponseBytes",
            "maxRedirects",
            "timeout",
            "if",
            "enabled",
          ],
          "http handler",
        );
      const url = requiredNonEmpty(input.url, "url");
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("http handler 仅支持 http/https");
      }
      return {
        type,
        url,
        ...common,
        ...(input.headers === undefined
          ? {}
          : { headers: optionalStringRecord(input.headers, "headers") }),
        ...(input.allowedEnv === undefined
          ? {}
          : { allowedEnv: optionalStringArray(input.allowedEnv, "allowedEnv") }),
        ...(input.maxResponseBytes === undefined
          ? {}
          : {
              maxResponseBytes: requiredPositiveInteger(input.maxResponseBytes, "maxResponseBytes"),
            }),
        ...(input.maxRedirects === undefined
          ? {}
          : { maxRedirects: requiredNonNegativeInteger(input.maxRedirects, "maxRedirects") }),
      } satisfies HttpHookHandler;
    }
    case "mcp_tool":
      if (!options.legacy)
        assertOnlyKeys(
          input,
          ["type", "server", "tool", "input", "timeout", "if", "enabled"],
          "mcp_tool handler",
        );
      return {
        type,
        server: requiredNonEmpty(input.server, "server"),
        tool: requiredNonEmpty(input.tool, "tool"),
        ...common,
        ...(input.input === undefined ? {} : { input: input.input }),
      } satisfies McpToolHookHandler;
    case "prompt":
      if (!options.legacy)
        assertOnlyKeys(
          input,
          ["type", "prompt", "model", "timeout", "if", "enabled"],
          "prompt handler",
        );
      return {
        type,
        prompt: requiredNonEmpty(input.prompt, "prompt"),
        ...common,
        ...(input.model === undefined ? {} : { model: requiredNonEmpty(input.model, "model") }),
      } satisfies PromptHookHandler;
    case "agent": {
      if (!options.legacy)
        assertOnlyKeys(
          input,
          ["type", "prompt", "model", "maxTurns", "timeout", "if", "enabled"],
          "agent handler",
        );
      const maxTurns =
        input.maxTurns === undefined
          ? undefined
          : requiredPositiveInteger(input.maxTurns, "maxTurns");
      if (maxTurns !== undefined && maxTurns > 50) throw new Error("agent.maxTurns 不能超过 50");
      return {
        type,
        prompt: requiredNonEmpty(input.prompt, "prompt"),
        ...common,
        ...(input.model === undefined ? {} : { model: requiredNonEmpty(input.model, "model") }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
      } satisfies AgentHookHandler;
    }
    default:
      throw new Error(`不支持的 handler 类型: ${type}`);
  }
}

function normalizeHandlerCommon(
  input: Record<string, unknown>,
  options: { legacy: boolean },
): Omit<CommandHookHandler, "type" | "command" | "args" | "async" | "asyncRewake" | "env"> {
  const timeout =
    input.timeout === undefined ? undefined : requiredPositiveNumber(input.timeout, "timeout");
  const condition = input.if === undefined ? undefined : normalizeCondition(input.if);
  const enabled =
    input.enabled === undefined ? undefined : requiredBoolean(input.enabled, "enabled");
  return {
    ...(timeout === undefined
      ? {}
      : { timeout, timeoutMs: options.legacy ? timeout : timeout * 1000 }),
    ...(condition === undefined ? {} : { if: condition }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

function normalizeCondition(input: unknown): HookCondition {
  if (!isRecord(input)) throw new Error("if 条件必须是对象");
  const rawOp = requiredString(input.op, "if.op");
  if (!isConditionOperator(rawOp)) throw new Error(`不支持的条件操作符: ${rawOp}`);
  const op = rawOp;
  const path = requiredNonEmpty(input.path, "if.path");
  validateDataPath(path);
  if (op === "exists") {
    assertOnlyKeys(input, ["op", "path", "value"], "exists condition");
    return {
      op,
      path,
      ...(input.value === undefined ? {} : { value: requiredBoolean(input.value, "if.value") }),
    };
  }
  if (op === "regex") {
    assertOnlyKeys(input, ["op", "path", "pattern"], "regex condition");
    const pattern = requiredString(input.pattern, "if.pattern");
    new RegExp(pattern);
    return { op, path, pattern };
  }
  if (op === "contains") {
    assertOnlyKeys(input, ["op", "path", "value"], "contains condition");
    return { op, path, value: requiredString(input.value, "if.value") };
  }
  assertOnlyKeys(input, ["op", "path", "value"], "equals condition");
  if (!isScalar(input.value)) throw new Error("equals.value 必须是标量");
  return { op, path, value: input.value };
}

function normalizedHandlerId(
  source: HookSource,
  event: HookEvent,
  group: HookMatcherGroup,
  handler: HookHandler,
): string {
  return `${source.kind}:${createHash("sha256")
    .update(
      stableStringify({
        source: source.path,
        event,
        matcher: group.matcher,
        if: group.if,
        handler,
      }),
    )
    .digest("hex")}`;
}

function snapshotId(
  workspace: string,
  version: number,
  handlers: Readonly<Record<HookEvent, readonly ResolvedHookHandler[]>>,
): string {
  return createHash("sha256")
    .update(stableStringify({ workspace, version, handlers }))
    .digest("hex");
}

async function executableTrustStatus(
  handler: HookHandler,
  store: HookTrustAuthority,
  workspace: string,
  source: HookSource,
): Promise<HookTrustStatus> {
  if (handler.type === "prompt" || handler.type === "agent") return "active";
  try {
    return await (source.trustAuthority ?? store).status({ workspace, source, handler });
  } catch (error) {
    logger.warn(
      { error: errorMessage(error), path: store.filePath ?? "host trust authority" },
      "Hook 信任库不可用，handler 保持 pending",
    );
    return "pending";
  }
}

function blankHandlers(): Record<HookEvent, ResolvedHookHandler[]> {
  const handlers = {} as Record<HookEvent, ResolvedHookHandler[]>;
  for (const event of HOOK_EVENTS) handlers[event] = [];
  return handlers;
}

function isConditionOperator(input: string): input is HookCondition["op"] {
  return CONDITION_OPERATORS.has(input);
}

function validateRegexOrMatcher(matcher: string): void {
  if (matcher === "*" || /^[A-Za-z0-9_|.-]+$/.test(matcher)) return;
  new RegExp(matcher);
}

function validateDataPath(path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(path) || path.includes("..")) {
    throw new Error(`非法条件路径: ${path}`);
  }
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段: ${unknown.join(", ")}`);
}

function objectField(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

function optionalString(input: unknown, field: string): string | undefined {
  return input === undefined ? undefined : requiredString(input, field);
}

function requiredString(input: unknown, field: string): string {
  if (typeof input !== "string") throw new Error(`${field} 必须是字符串`);
  return input;
}

function requiredNonEmpty(input: unknown, field: string): string {
  const value = requiredString(input, field).trim();
  if (value.length === 0) throw new Error(`${field} 不能为空`);
  return value;
}

function requiredBoolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") throw new Error(`${field} 必须是布尔值`);
  return input;
}

function requiredPositiveNumber(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new Error(`${field} 必须是正数`);
  }
  return input;
}

function requiredPositiveInteger(input: unknown, field: string): number {
  const value = requiredPositiveNumber(input, field);
  if (!Number.isInteger(value)) throw new Error(`${field} 必须是正整数`);
  return value;
}

function requiredNonNegativeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${field} 必须是非负整数`);
  }
  return input;
}

function optionalStringArray(input: unknown, field: string): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return Object.freeze(input.slice() as string[]);
}

function optionalStringRecord(
  input: unknown,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || Object.values(input).some((value) => typeof value !== "string")) {
    throw new Error(`${field} 必须是字符串对象`);
  }
  return Object.freeze({ ...input } as Record<string, string>);
}

function invalidOrEmpty(options: { legacy: boolean }, message: string): [] {
  if (options.legacy) return [];
  throw new Error(message);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isScalar(input: unknown): input is string | number | boolean | null {
  return input === null || ["string", "number", "boolean"].includes(typeof input);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return normalize(absolute);
  }
}

export {
  existingReferencedScripts,
  resolveReferencedScriptCandidates,
  resolveReferencedScripts,
} from "./config/referenced-scripts.js";

export function stableStringify(input: unknown): string {
  return JSON.stringify(sortValue(input));
}

function sortValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sortValue);
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, sortValue(input[key])]),
  );
}

function deepFreeze<T>(input: T): T {
  if (typeof input !== "object" || input === null || Object.isFrozen(input)) return input;
  Object.freeze(input);
  for (const value of Object.values(input)) deepFreeze(value);
  return input;
}

/** 给热重载器在完全无配置时使用的快照。 */
export function emptyLoadedHookSnapshot(): LoadHookSnapshotResult {
  return { snapshot: emptyHookSnapshot(), sources: [], hasErrors: false, watchedPaths: [] };
}

export function parentDirectories(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map(dirname))];
}
