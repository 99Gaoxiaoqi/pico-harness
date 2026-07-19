import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isHardlineCommand } from "../approval/manager.js";
import { normalizeCanonicalHooksConfig } from "../hooks/config.js";
import { HookTrustStore } from "../hooks/trust/store.js";
import type {
  HookHandler,
  HookInput,
  HookMatcherGroup,
  HooksConfig,
  HookSource,
} from "../hooks/types.js";
import { logger } from "../observability/logger.js";
import type { ToolCall } from "../schema/message.js";
import type {
  ExecutionMiddleware,
  RequestMiddleware,
  RequestMiddlewareResult,
} from "../tools/registry.js";
import { WorkspaceRoots, workspaceAccessesFromCall } from "../tools/workspace-roots.js";
import type { WorkspaceTrustStore } from "../security/workspace-trust.js";
import { verifyBackgroundMcpConfig } from "./background-mcp-policy.js";
import {
  buildSandboxSpawnPlan,
  evaluateYoloToolCall,
  type SandboxNetworkPolicy,
  type SandboxSpawnPlan,
} from "./yolo-sandbox.js";
import {
  BackgroundYoloPolicySnapshotError,
  normalizeExactHostname,
  parseBackgroundYoloPolicySnapshot,
  type BackgroundYoloPolicySnapshotData,
} from "./background-yolo-policy-schema.js";

export const BACKGROUND_HARDLINE_VERSION = "builtin-v1" as const;
export const BACKGROUND_HOOK_VERSION = "workspace-v1" as const;

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
const UNSAFE_BACKGROUND_TOOLS = new Set([
  "ask_user",
  "delegate_task",
  "delegate_status",
  "spawn_subagent",
  "schedule_task",
]);

export type BackgroundYoloPolicySnapshot = BackgroundYoloPolicySnapshotData;

export function filterBackgroundEligibleTools(tools: readonly string[]): string[] {
  return [...new Set(tools.filter((tool) => tool && !UNSAFE_BACKGROUND_TOOLS.has(tool)))].sort();
}

export interface BackgroundWorkspaceTrustVerifier {
  canonicalize(workspacePath: string): Promise<string>;
  isTrusted(canonicalWorkspacePath: string): Promise<boolean>;
}

export interface PreparedBackgroundYoloPolicy {
  readonly snapshot: BackgroundYoloPolicySnapshot;
  readonly workspacePath: string;
  readonly allowedTools: ReadonlySet<string>;
  readonly allowedToolNetworkHosts: ReadonlySet<string>;
  readonly mcpConfigPath?: string;
  readonly hookRunner?: BackgroundHookRunner;
}

export interface BackgroundHookRunner {
  runPreToolUse(toolName: string, toolInput: unknown, sessionId: string): Promise<StrictHookResult>;
  runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResponse: string,
    sessionId: string,
  ): Promise<void>;
}

export type BackgroundPolicyViolationCode =
  | "missing_policy"
  | "invalid_policy"
  | "policy_version_mismatch"
  | "workspace_untrusted"
  | "mcp_config_invalid"
  | "mcp_unavailable"
  | "tool_unavailable"
  | "hook_config_invalid"
  | "hook_unavailable";

export class BackgroundPolicyViolationError extends Error {
  override readonly name = "BackgroundPolicyViolationError";

  constructor(
    readonly code: BackgroundPolicyViolationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[background:${code}] ${message}`, options);
  }
}

export async function prepareBackgroundYoloPolicy(input: {
  workDir: string;
  policy: unknown;
  trustStore: BackgroundWorkspaceTrustVerifier | WorkspaceTrustStore;
  hookTrustStore?: HookTrustStore;
}): Promise<PreparedBackgroundYoloPolicy> {
  const snapshot = assertBackgroundYoloPolicy(input.policy);
  if (snapshot.hardlineVersion !== BACKGROUND_HARDLINE_VERSION) {
    throw new BackgroundPolicyViolationError(
      "policy_version_mismatch",
      `hardline 策略版本不匹配: ${snapshot.hardlineVersion}`,
    );
  }
  if (snapshot.hookVersion !== BACKGROUND_HOOK_VERSION) {
    throw new BackgroundPolicyViolationError(
      "policy_version_mismatch",
      `Hook 策略版本不匹配: ${snapshot.hookVersion}`,
    );
  }

  let workspacePath: string;
  let trusted: boolean;
  try {
    workspacePath = await input.trustStore.canonicalize(input.workDir);
    trusted = await input.trustStore.isTrusted(workspacePath);
  } catch (error) {
    throw new BackgroundPolicyViolationError(
      "workspace_untrusted",
      "无法验证工作区信任状态，后台执行已停止。",
      { cause: error },
    );
  }
  if (!trusted) {
    throw new BackgroundPolicyViolationError(
      "workspace_untrusted",
      `工作区已不再受信任: ${workspacePath}`,
    );
  }

  let mcpConfigPath: string | undefined;
  if (snapshot.mcpConfigFingerprint) {
    try {
      mcpConfigPath = await verifyBackgroundMcpConfig({
        workspacePath,
        expectedFingerprint: snapshot.mcpConfigFingerprint,
      });
    } catch (error) {
      throw new BackgroundPolicyViolationError(
        "mcp_config_invalid",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  const loadedHooks = await loadStrictHooksConfig(workspacePath);
  const hooks = loadedHooks.config;
  if (loadedHooks.nativeSource && hasToolHooks(hooks)) {
    await assertNativeHooksTrusted(
      workspacePath,
      loadedHooks.nativeSource,
      hooks,
      input.hookTrustStore ?? new HookTrustStore(),
    );
  }
  let hookRunner: StrictBackgroundHookRunner | undefined;
  if (hasToolHooks(hooks)) {
    try {
      hookRunner = new StrictBackgroundHookRunner(
        workspacePath,
        hooks,
        backgroundNetworkPolicy(snapshot),
      );
    } catch (error) {
      throw new BackgroundPolicyViolationError(
        "hook_unavailable",
        "当前环境无法为后台 Hook 建立强制沙箱。",
        { cause: error },
      );
    }
  }

  return {
    snapshot,
    workspacePath,
    // Delegation/交互工具尚不能把同一 policy 传递给下一执行边界，后台不可暴露。
    allowedTools: new Set(filterBackgroundEligibleTools(snapshot.allowedTools)),
    allowedToolNetworkHosts: new Set(snapshot.allowedToolNetworkHosts ?? []),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(hookRunner ? { hookRunner } : {}),
  };
}

export function buildBackgroundYoloMiddleware(input: {
  policy: PreparedBackgroundYoloPolicy;
  workspaceRoots: WorkspaceRoots;
  sessionId: string;
}): RequestMiddleware {
  return async (call) => {
    const initial = validateBackgroundToolCall(call, input.policy, input.workspaceRoots);
    if (!initial.allowed) return initial;

    const hookResult = await input.policy.hookRunner?.runPreToolUse(
      call.name,
      parseToolInput(call.arguments),
      input.sessionId,
    );
    if (!hookResult) return initial;
    if (hookResult.decision === "deny") {
      return {
        allowed: false,
        reason: `[background:hook_denied] ${hookResult.reason ?? "PreToolUse Hook 已阻断"}`,
      };
    }
    if (hookResult.modifiedInput === undefined) return initial;

    let rewrittenArguments: string;
    try {
      rewrittenArguments = JSON.stringify(hookResult.modifiedInput);
      if (rewrittenArguments === undefined) throw new Error("modifiedInput 无法序列化");
    } catch (error) {
      return {
        allowed: false,
        reason: `[background:hook_invalid] Hook 返回了无法验证的 modifiedInput: ${errorMessage(error)}`,
      };
    }
    const rewrittenCall = { ...call, arguments: rewrittenArguments };
    const rewritten = validateBackgroundToolCall(rewrittenCall, input.policy, input.workspaceRoots);
    return rewritten.allowed ? { ...rewritten, call: rewrittenCall } : rewritten;
  };
}

/**
 * 后台 Hook 的执行阶段边界：不改写工具结果，且 PostToolUse 失败不能
 * 把已经发生的工具副作用伪装成失败或成功。
 */
export function buildBackgroundYoloHookExecutionMiddleware(input: {
  policy: Pick<PreparedBackgroundYoloPolicy, "hookRunner">;
  sessionId: string;
}): ExecutionMiddleware {
  return async (call, next) => {
    const notify = async (toolResponse: string): Promise<void> => {
      try {
        await input.policy.hookRunner?.runPostToolUse(
          call.name,
          parseToolInput(call.arguments),
          toolResponse,
          input.sessionId,
        );
      } catch (error) {
        logger.warn(
          { error: errorMessage(error), tool: call.name },
          "[Hook] 后台 PostToolUse 执行失败，保留原工具结果",
        );
      }
    };
    try {
      const output = await next(call);
      await notify(output);
      return output;
    } catch (error) {
      await notify(`[tool_error] ${errorMessage(error)}`);
      throw error;
    }
  };
}

function validateBackgroundToolCall(
  call: ToolCall,
  policy: PreparedBackgroundYoloPolicy,
  workspaceRoots: WorkspaceRoots,
): RequestMiddlewareResult {
  if (!policy.allowedTools.has(call.name)) {
    return {
      allowed: false,
      reason: `[background:tool_denied] 工具 ${call.name} 不在 Job 的 allowedTools 中。`,
    };
  }
  if (UNSAFE_BACKGROUND_TOOLS.has(call.name)) {
    return {
      allowed: false,
      reason: `[background:tool_denied] 工具 ${call.name} 尚未支持继承后台安全策略。`,
    };
  }
  if (isHardlineCommand(call.name, call.arguments, policy.workspacePath)) {
    return {
      allowed: false,
      reason: "[background:hardline_denied] Hardline 高危命令不可由后台 YOLO 绕过。",
    };
  }
  for (const access of workspaceAccessesFromCall(call)) {
    if (!workspaceRoots.isAllowedPath(access.path)) {
      return {
        allowed: false,
        reason: `[background:workspace_denied] 路径不在后台 Job 的真实工作区: ${access.path}`,
      };
    }
  }

  const sandboxDecision = evaluateYoloToolCall(call, policy.workspacePath, workspaceRoots, {
    // allow 是用户明确确认的无人值守网络边界；allowlist 仍只开放可验证 URL 工具。
    network: backgroundNetworkPolicy(policy.snapshot),
  });
  if (!sandboxDecision.allowed) {
    return { allowed: false, reason: sandboxDecision.reason ?? "后台沙箱拒绝工具调用" };
  }
  return validateNetworkToolCall(call, policy);
}

function validateNetworkToolCall(
  call: ToolCall,
  policy: PreparedBackgroundYoloPolicy,
): RequestMiddlewareResult {
  if (policy.snapshot.toolNetworkPolicy === "allow") return { allowed: true };
  if (call.name === "web_search") {
    return {
      allowed: false,
      reason:
        policy.snapshot.toolNetworkPolicy === "disabled"
          ? "[background:network_denied] 当前 Job 禁止工具网络访问。"
          : "[background:network_denied] web_search 无法证明仅访问 allowlist，已安全拒绝。",
    };
  }
  if (call.name !== "fetch_url") return { allowed: true };
  if (policy.snapshot.toolNetworkPolicy === "disabled") {
    return { allowed: false, reason: "[background:network_denied] 当前 Job 禁止工具网络访问。" };
  }
  const rawUrl = jsonStringField(call.arguments, "url");
  if (!rawUrl) {
    return { allowed: false, reason: "[background:network_denied] fetch_url 缺少可验证 URL。" };
  }
  let hostname: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("协议不受支持");
    hostname = normalizeExactHostname(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return { allowed: false, reason: "[background:network_denied] fetch_url URL 无法验证。" };
  }
  if (!policy.allowedToolNetworkHosts.has(hostname)) {
    return {
      allowed: false,
      reason: `[background:network_denied] 主机 ${hostname} 不在 Job 网络 allowlist 中。`,
    };
  }
  // 这里只做首跳快速拒绝；FetchURLTool 自身会在 DNS 与请求前逐跳重复授权。
  return { allowed: true };
}

function assertBackgroundYoloPolicy(value: unknown): BackgroundYoloPolicySnapshot {
  if (!isRecord(value)) {
    throw new BackgroundPolicyViolationError("missing_policy", "后台执行缺少 policySnapshot。 ");
  }
  try {
    return parseBackgroundYoloPolicySnapshot(value);
  } catch (error) {
    if (!(error instanceof BackgroundYoloPolicySnapshotError)) throw error;
    throw new BackgroundPolicyViolationError("invalid_policy", error.message, { cause: error });
  }
}

interface StrictHooksConfigLoad {
  readonly config: HooksConfig;
  readonly nativeSource?: HookSource;
}

async function loadStrictHooksConfig(workDir: string): Promise<StrictHooksConfigLoad> {
  const nativePath = join(workDir, ".pico", "hooks.json");
  let nativeRaw: string | undefined;
  try {
    nativeRaw = await readFile(nativePath, "utf8");
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      throw new BackgroundPolicyViolationError(
        "hook_config_invalid",
        `无法读取原生 Hook 配置: ${nativePath}`,
        { cause: error },
      );
    }
  }
  if (nativeRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(nativeRaw) as unknown;
      const config = strictNativeToolHooks(normalizeCanonicalHooksConfig(parsed) ?? {});
      return {
        config,
        nativeSource: { kind: "project", path: nativePath, version: 1 },
      };
    } catch (error) {
      throw new BackgroundPolicyViolationError(
        "hook_config_invalid",
        `原生 Hook 配置无效: ${nativePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  const settingsPath = join(workDir, ".claw", "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return { config: {} };
    throw new BackgroundPolicyViolationError(
      "hook_config_invalid",
      `无法读取 Hook 配置: ${settingsPath}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BackgroundPolicyViolationError(
      "hook_config_invalid",
      `Hook 配置不是合法 JSON: ${settingsPath}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new BackgroundPolicyViolationError("hook_config_invalid", "settings.json 必须是对象。");
  }
  const hooks = parsed["hooks"];
  if (hooks === undefined || hooks === null) return { config: {} };
  if (!isRecord(hooks)) {
    throw new BackgroundPolicyViolationError("hook_config_invalid", "hooks 必须是对象。");
  }

  const result: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (event !== "PreToolUse" && event !== "PostToolUse") {
      throw new BackgroundPolicyViolationError(
        "hook_config_invalid",
        `无法验证的 Hook 事件: ${event}`,
      );
    }
    result[event] = assertHookGroups(groups, event);
  }
  return { config: result };
}

function strictNativeToolHooks(config: HooksConfig): HooksConfig {
  const result: HooksConfig = {};
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const groups: HookMatcherGroup[] = [];
    for (const group of config[event] ?? []) {
      if (group.if !== undefined) {
        throw new Error(`后台 ${event} 暂不支持 matcher group 条件`);
      }
      const handlers = group.hooks.filter((handler) => handler.enabled !== false);
      for (const handler of handlers) {
        if (handler.type !== "command") {
          throw new Error(`后台模式仅支持 command hook，收到 ${handler.type}`);
        }
        if (
          handler.if !== undefined ||
          handler.args !== undefined ||
          handler.env !== undefined ||
          handler.async !== undefined ||
          handler.asyncRewake !== undefined
        ) {
          throw new Error("后台 command hook 仅支持 command、timeout 与 enabled 字段");
        }
      }
      if (handlers.length > 0) {
        groups.push({
          ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
          hooks: handlers,
        });
      }
    }
    if (groups.length > 0) result[event] = groups;
  }
  return result;
}

async function assertNativeHooksTrusted(
  workspace: string,
  source: HookSource,
  config: HooksConfig,
  trustStore: HookTrustStore,
): Promise<void> {
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    for (const group of config[event] ?? []) {
      for (const handler of group.hooks) {
        if (handler.type !== "command") {
          throw new BackgroundPolicyViolationError(
            "hook_config_invalid",
            `后台模式仅支持 command hook，收到 ${handler.type}。`,
          );
        }
        let status: "active" | "pending";
        try {
          status = await trustStore.status({ workspace, source, handler });
        } catch (error) {
          throw new BackgroundPolicyViolationError(
            "hook_unavailable",
            "无法验证原生 Hook 信任状态，后台执行已停止。",
            { cause: error },
          );
        }
        if (status !== "active") {
          throw new BackgroundPolicyViolationError(
            "hook_unavailable",
            `原生 Hook 尚未受信任: ${source.path}`,
          );
        }
      }
    }
  }
}

function assertHookGroups(value: unknown, event: string): HookMatcherGroup[] {
  if (!Array.isArray(value)) {
    throw new BackgroundPolicyViolationError("hook_config_invalid", `${event} Hook 必须是数组。`);
  }
  return value.map((group, groupIndex) => {
    if (!isRecord(group) || !Array.isArray(group["hooks"]) || group["hooks"].length === 0) {
      throw new BackgroundPolicyViolationError(
        "hook_config_invalid",
        `${event}[${groupIndex}] 必须包含非空 hooks 数组。`,
      );
    }
    const matcher = group["matcher"];
    if (matcher !== undefined && typeof matcher !== "string") {
      throw new BackgroundPolicyViolationError(
        "hook_config_invalid",
        `${event}[${groupIndex}].matcher 必须是字符串。`,
      );
    }
    if (
      typeof matcher === "string" &&
      matcher !== "" &&
      matcher !== "*" &&
      !/^[A-Za-z0-9_|]+$/.test(matcher)
    ) {
      try {
        new RegExp(matcher);
      } catch (error) {
        throw new BackgroundPolicyViolationError(
          "hook_config_invalid",
          `${event}[${groupIndex}].matcher 不是合法正则。`,
          { cause: error },
        );
      }
    }
    return {
      ...(typeof matcher === "string" ? { matcher } : {}),
      hooks: group["hooks"].map((handler, handlerIndex) =>
        assertHookHandler(handler, event, groupIndex, handlerIndex),
      ),
    };
  });
}

function assertHookHandler(
  value: unknown,
  event: string,
  groupIndex: number,
  handlerIndex: number,
): HookHandler {
  if (
    !isRecord(value) ||
    value["type"] !== "command" ||
    !isNonEmptyString(value["command"]) ||
    (value["timeout"] !== undefined &&
      (typeof value["timeout"] !== "number" ||
        !Number.isFinite(value["timeout"]) ||
        value["timeout"] <= 0))
  ) {
    throw new BackgroundPolicyViolationError(
      "hook_config_invalid",
      `${event}[${groupIndex}].hooks[${handlerIndex}] 无法验证。`,
    );
  }
  return {
    type: "command",
    command: value["command"],
    ...(typeof value["timeout"] === "number" ? { timeout: value["timeout"] } : {}),
  };
}

export interface StrictHookResult {
  decision: "allow" | "deny";
  reason?: string;
  modifiedInput?: unknown;
}

function matcherMatches(group: HookMatcherGroup, toolName: string): boolean {
  const matcher = group.matcher;
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(toolName);
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

export class StrictBackgroundHookRunner {
  private readonly plans = new Map<HookHandler, SandboxSpawnPlan>();

  constructor(
    private readonly workDir: string,
    private readonly config: HooksConfig,
    network: SandboxNetworkPolicy = "deny",
  ) {
    for (const groups of Object.values(config)) {
      for (const group of groups ?? []) {
        for (const handler of group.hooks) {
          if (handler.type !== "command") {
            throw new BackgroundPolicyViolationError(
              "hook_config_invalid",
              `后台模式仅支持 command hook，收到 ${handler.type}。`,
            );
          }
          this.plans.set(
            handler,
            buildSandboxSpawnPlan({
              command: handler.command,
              shell: "/bin/sh",
              shellArgs: ["-lc", handler.command],
              cwd: workDir,
              writableRoots: [workDir],
              config: { network },
            }),
          );
        }
      }
    }
  }

  async runPreToolUse(
    toolName: string,
    toolInput: unknown,
    sessionId: string,
  ): Promise<StrictHookResult> {
    let modifiedInput: unknown;
    for (const group of this.config.PreToolUse ?? []) {
      if (!matcherMatches(group, toolName)) continue;
      for (const handler of group.hooks) {
        const result = await this.execute(handler, {
          session_id: sessionId,
          cwd: this.workDir,
          hook_event_name: "PreToolUse",
          payload: {
            tool_name: toolName,
            tool_input: modifiedInput ?? toolInput,
          },
          tool_name: toolName,
          tool_input: modifiedInput ?? toolInput,
        });
        if (result.decision === "deny") return result;
        if (modifiedInput === undefined && result.modifiedInput !== undefined) {
          modifiedInput = result.modifiedInput;
        }
      }
    }
    return {
      decision: "allow",
      ...(modifiedInput !== undefined ? { modifiedInput } : {}),
    };
  }

  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResponse: string,
    sessionId: string,
  ): Promise<void> {
    for (const group of this.config.PostToolUse ?? []) {
      if (!matcherMatches(group, toolName)) continue;
      for (const handler of group.hooks) {
        const result = await this.execute(handler, {
          session_id: sessionId,
          cwd: this.workDir,
          hook_event_name: "PostToolUse",
          payload: {
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResponse,
          },
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
        });
        if (result.decision === "deny") {
          logger.warn(
            { tool: toolName, reason: result.reason },
            "[Hook] 后台 PostToolUse 返回 deny，工具结果保持不变",
          );
        }
      }
    }
  }

  private execute(handler: HookHandler, input: HookInput): Promise<StrictHookResult> {
    const plan = this.plans.get(handler);
    if (!plan) {
      return Promise.resolve({
        decision: "deny",
        reason: "Hook 执行计划缺失，已按 fail-closed 阻断。",
      });
    }
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(plan.command, plan.args, {
          cwd: this.workDir,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ decision: "deny", reason: `Hook 无法启动: ${errorMessage(error)}` });
        return;
      }
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (result: StrictHookResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (reason: string) => {
        killChild(child);
        finish({ decision: "deny", reason });
      };
      const timer = setTimeout(
        () => fail("Hook 超时，已按 fail-closed 阻断。"),
        handler.timeoutMs ?? handler.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
      );
      const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
          fail("Hook 输出超过限制，已按 fail-closed 阻断。");
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error) => fail(`Hook 执行失败: ${errorMessage(error)}`));
      child.once("close", (code) => finish(interpretStrictHookExit(code, stdout, stderr)));
      child.stdin?.once("error", (error) => fail(`Hook stdin 失败: ${errorMessage(error)}`));
      try {
        child.stdin?.end(JSON.stringify(input));
      } catch (error) {
        fail(`Hook 输入失败: ${errorMessage(error)}`);
      }
    });
  }
}

function backgroundNetworkPolicy(snapshot: BackgroundYoloPolicySnapshot): SandboxNetworkPolicy {
  return snapshot.toolNetworkPolicy === "allow" ? "allow" : "deny";
}

function interpretStrictHookExit(
  code: number | null,
  stdout: string,
  stderr: string,
): StrictHookResult {
  if (code === 2) {
    return { decision: "deny", reason: stderr.trim() || "PreToolUse Hook 阻断(exit 2)" };
  }
  if (code !== 0) {
    return {
      decision: "deny",
      reason: `Hook 异常退出(${code === null ? "signal" : code})，已按 fail-closed 阻断。`,
    };
  }
  const trimmed = stdout.trim();
  if (!trimmed) return { decision: "allow" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { decision: "deny", reason: "Hook stdout 不是合法 JSON，已按 fail-closed 阻断。" };
  }
  if (!isRecord(parsed)) {
    return { decision: "deny", reason: "Hook stdout 不是对象，已按 fail-closed 阻断。" };
  }
  if (parsed["permissionDecision"] === "deny" || parsed["decision"] === "block") {
    return {
      decision: "deny",
      reason:
        stringValue(parsed["permissionDecisionReason"]) ??
        stringValue(parsed["reason"]) ??
        "PreToolUse Hook 阻断",
    };
  }
  return {
    decision: "allow",
    ...(Object.hasOwn(parsed, "modifiedInput") ? { modifiedInput: parsed["modifiedInput"] } : {}),
  };
}

function hasToolHooks(config: HooksConfig): boolean {
  return (config.PreToolUse?.length ?? 0) > 0 || (config.PostToolUse?.length ?? 0) > 0;
}

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

function jsonStringField(argumentsJson: string, field: string): string | undefined {
  const input = parseToolInput(argumentsJson);
  return isRecord(input) && typeof input[field] === "string" ? input[field] : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killChild(child: ChildProcess): void {
  if (child.killed) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The child already exited; the close event will settle the promise.
  }
}
