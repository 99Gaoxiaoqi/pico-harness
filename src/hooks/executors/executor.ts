import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { logger } from "../../observability/logger.js";
import type { LLMProvider } from "../../provider/interface.js";
import type { Message } from "../../schema/message.js";
import { mcpResultToText, type McpToolResult } from "../../mcp/types.js";
import type {
  AgentHookHandler,
  CommandHookHandler,
  HookDiagnostic,
  HookExecutionContext,
  HookInput,
  HookOutput,
  HttpHookHandler,
  McpToolHookHandler,
  PromptHookHandler,
  ResolvedHookHandler,
} from "../types.js";
import type { HookExecutor } from "../service.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_REDIRECTS = 3;
const ABORT_KILL_GRACE_MS = 250;

export interface ConnectedMcpToolInvoker {
  invokeConnectedTool(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    context?: { readonly signal?: AbortSignal },
  ): Promise<McpToolResult>;
}

export interface HookAgentVerifierRequest {
  prompt: string;
  input: HookInput;
  model?: string;
  maxTurns: number;
  readonlyToolsOnly: true;
  suppressHooks: true;
  signal: AbortSignal;
}

export interface HookAgentVerifier {
  verify(request: HookAgentVerifierRequest): Promise<unknown>;
}

export interface HookHandlerExecutorOptions {
  workDir: string;
  provider?: LLMProvider;
  mcpInvoker?: ConnectedMcpToolInvoker;
  agentVerifier?: HookAgentVerifier;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  onAsyncRewake?: (handler: ResolvedHookHandler, output: HookOutput) => void | Promise<void>;
}

/** 五类前台 Hook handler 的统一执行器。普通失败 fail-open，父级取消原样上抛。 */
export class DefaultHookExecutor implements HookExecutor {
  constructor(private readonly options: HookHandlerExecutorOptions) {}

  async execute(
    resolved: ResolvedHookHandler,
    input: HookInput,
    context: HookExecutionContext,
  ): Promise<HookOutput> {
    if (context.signal?.aborted) throw abortReason(context.signal);
    try {
      switch (resolved.handler.type) {
        case "command":
          return await this.executeCommand(resolved, resolved.handler, input, context.signal);
        case "http":
          return await this.executeHttp(resolved, resolved.handler, input, context.signal);
        case "mcp_tool":
          return await this.executeMcp(resolved, resolved.handler, input, context.signal);
        case "prompt":
          return await this.executePrompt(resolved, resolved.handler, input, context.signal);
        case "agent":
          return await this.executeAgent(resolved, resolved.handler, input, context.signal);
      }
    } catch (err) {
      if (context.signal?.aborted) throw abortReason(context.signal);
      return failOpen(resolved, errorMessage(err));
    }
  }

  private async executeCommand(
    resolved: ResolvedHookHandler,
    handler: CommandHookHandler,
    input: HookInput,
    parentSignal?: AbortSignal,
  ): Promise<HookOutput> {
    const signal = handlerSignal(parentSignal, timeoutMs(handler));
    const running = startCommand(
      resolved,
      handler,
      input,
      this.options.workDir,
      this.options.env ?? process.env,
      signal,
    );
    await running.started;
    if (handler.async || handler.asyncRewake) {
      void running.completion.then(
        async (output) => {
          if (handler.asyncRewake && this.options.onAsyncRewake) {
            try {
              await this.options.onAsyncRewake(resolved, output);
            } catch (err) {
              logger.warn(
                { err: errorMessage(err), handlerId: resolved.id },
                "[Hook] asyncRewake 回调失败",
              );
            }
          }
        },
        (err: unknown) => {
          logger.warn(
            {
              err: errorMessage(err),
              handlerId: resolved.id,
              source: resolved.source.path,
            },
            "[Hook] async command 执行失败",
          );
        },
      );
      return { decision: "allow" };
    }
    return await running.completion;
  }

  private async executeHttp(
    resolved: ResolvedHookHandler,
    handler: HttpHookHandler,
    input: HookInput,
    parentSignal?: AbortSignal,
  ): Promise<HookOutput> {
    const signal = handlerSignal(parentSignal, timeoutMs(handler));
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const env = this.options.env ?? process.env;
    const headers = resolveHeaders(handler.headers ?? {}, new Set(handler.allowedEnv ?? []), env);
    headers.set("content-type", "application/json");
    const body = JSON.stringify(input);
    let url = new URL(handler.url);
    assertHttpUrl(url);
    const maxRedirects = boundedInteger(handler.maxRedirects, DEFAULT_REDIRECTS, 0, 10);
    const maxBytes = boundedInteger(
      handler.maxResponseBytes,
      MAX_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
    );

    for (let redirect = 0; ; redirect++) {
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal,
      });
      if (isRedirect(response.status)) {
        if (redirect >= maxRedirects) throw new Error(`HTTP redirect 超过上限 ${maxRedirects}`);
        const location = response.headers.get("location");
        if (!location) throw new Error("HTTP redirect 缺少 Location");
        const next = new URL(location, url);
        assertHttpUrl(next);
        if (next.origin !== url.origin) stripSensitiveHeaders(headers);
        url = next;
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const text = await readLimitedText(response, maxBytes, signal);
      return parseProtocolOutput(text, resolved, "HTTP handler 返回了非法输出");
    }
  }

  private async executeMcp(
    resolved: ResolvedHookHandler,
    handler: McpToolHookHandler,
    input: HookInput,
    parentSignal?: AbortSignal,
  ): Promise<HookOutput> {
    if (!this.options.mcpInvoker) return failOpen(resolved, "MCP handler 未配置连接管理器");
    const signal = handlerSignal(parentSignal, timeoutMs(handler));
    const toolInput = asRecord(handler.input ?? input);
    const result = await this.options.mcpInvoker.invokeConnectedTool(
      handler.server,
      handler.tool,
      toolInput,
      { signal },
    );
    if (result.isError)
      return failOpen(resolved, `MCP tool 返回 isError: ${mcpResultToText(result)}`);
    return parseProtocolOutput(mcpResultToText(result), resolved, "MCP handler 返回了非法输出");
  }

  private async executePrompt(
    resolved: ResolvedHookHandler,
    handler: PromptHookHandler,
    input: HookInput,
    parentSignal?: AbortSignal,
  ): Promise<HookOutput> {
    if (!this.options.provider) return failOpen(resolved, "prompt handler 未配置 Provider");
    const signal = handlerSignal(parentSignal, timeoutMs(handler));
    const messages: Message[] = [
      {
        role: "system",
        content:
          '你是 Pico Hook 判定器。只输出单个 JSON 对象：{"ok":boolean,"reason":string}，不要 Markdown。',
      },
      { role: "user", content: `${handler.prompt}\n\nHook input:\n${JSON.stringify(input)}` },
    ];
    const response = await this.options.provider.generate(messages, [], {
      signal,
      purpose: "hook",
    });
    return parseVerifierOutput(response.content, resolved, "prompt handler 模型输出非法");
  }

  private async executeAgent(
    resolved: ResolvedHookHandler,
    handler: AgentHookHandler,
    input: HookInput,
    parentSignal?: AbortSignal,
  ): Promise<HookOutput> {
    if (!this.options.agentVerifier) return failOpen(resolved, "agent handler 未配置只读 verifier");
    const signal = handlerSignal(parentSignal, timeoutMs(handler));
    const raw = await this.options.agentVerifier.verify({
      prompt: handler.prompt,
      input,
      ...(handler.model ? { model: handler.model } : {}),
      maxTurns: boundedInteger(handler.maxTurns, 50, 1, 50),
      readonlyToolsOnly: true,
      suppressHooks: true,
      signal,
    });
    return parseVerifierOutput(raw, resolved, "agent handler 结构化输出非法");
  }
}

interface RunningCommand {
  started: Promise<void>;
  completion: Promise<HookOutput>;
}

function startCommand(
  resolved: ResolvedHookHandler,
  handler: CommandHookHandler,
  input: HookInput,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
): RunningCommand {
  let child: ChildProcess;
  const spawnOptions: SpawnOptions = {
    cwd,
    env: { ...baseEnv, ...handler.env },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  };
  try {
    child =
      handler.args === undefined
        ? spawn(handler.command, { ...spawnOptions, shell: true })
        : spawn(handler.command, [...handler.args], { ...spawnOptions, shell: false });
  } catch (err) {
    const rejected = Promise.reject(err);
    rejected.catch(() => undefined);
    return { started: rejected, completion: rejected };
  }

  let startResolve: (() => void) | undefined;
  let startReject: ((reason: unknown) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
  });
  const completion = new Promise<HookOutput>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (result: HookOutput) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    };
    const onAbort = () => {
      terminateProcessTree(child);
      startReject?.(abortReason(signal));
      fail(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.once("spawn", () => startResolve?.());
    child.once("error", (err) => {
      startReject?.(err);
      fail(err);
    });
    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminateProcessTree(child);
        fail(new Error(`command handler 输出超过 ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.stdin?.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      try {
        finish(interpretCommandExit(resolved, code, stdout, stderr));
      } catch (err) {
        fail(err);
      }
    });
    try {
      child.stdin?.end(JSON.stringify(input));
    } catch (err) {
      terminateProcessTree(child);
      fail(err);
    }
  });
  // async handler 的 completion 也必须有默认 rejection observer，避免后台 unhandled rejection。
  completion.catch(() => undefined);
  return { started, completion };
}

function interpretCommandExit(
  resolved: ResolvedHookHandler,
  code: number | null,
  stdout: string,
  stderr: string,
): HookOutput {
  if (code === 2) {
    return { decision: "deny", reason: stderr.trim() || "command hook 阻断(exit 2)" };
  }
  if (code !== 0) throw new Error(`command hook 退出码 ${String(code)}: ${stderr.trim()}`);
  return parseProtocolOutput(stdout, resolved, "command handler 返回了非法输出");
}

function parseProtocolOutput(
  raw: unknown,
  resolved?: ResolvedHookHandler,
  invalidMessage = "handler 返回了非法输出",
): HookOutput {
  if (typeof raw !== "string") return parseProtocolObject(raw, resolved, invalidMessage);
  const text = raw.trim();
  if (text === "") return { decision: "allow" };
  try {
    return parseProtocolObject(JSON.parse(text), resolved, invalidMessage);
  } catch {
    return resolved ? failOpen(resolved, invalidMessage) : { decision: "allow" };
  }
}

function parseProtocolObject(
  raw: unknown,
  resolved?: ResolvedHookHandler,
  invalidMessage = "handler 返回了非法输出",
): HookOutput {
  if (!isRecord(raw)) return resolved ? failOpen(resolved, invalidMessage) : { decision: "allow" };
  const protocolDecision = raw.permissionDecision ?? raw.decision;
  let decision: HookOutput["decision"] = "allow";
  if (protocolDecision === "deny" || protocolDecision === "block") decision = "deny";
  else if (protocolDecision === "ask") decision = "ask";
  else if (protocolDecision === "defer") decision = "defer";
  else if (protocolDecision !== undefined && protocolDecision !== "allow") {
    return resolved ? failOpen(resolved, invalidMessage) : { decision: "allow" };
  }
  const reason = firstString(raw.permissionDecisionReason, raw.reason);
  return {
    decision,
    ...(reason ? { reason } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, "modifiedInput")
      ? { modifiedInput: raw.modifiedInput }
      : {}),
    ...(typeof raw.additionalContext === "string"
      ? { additionalContext: raw.additionalContext }
      : {}),
  };
}

function parseVerifierOutput(
  raw: unknown,
  resolved: ResolvedHookHandler,
  invalidMessage: string,
): HookOutput {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return failOpen(resolved, invalidMessage);
    }
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    return failOpen(resolved, invalidMessage);
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    return failOpen(resolved, invalidMessage);
  }
  return {
    decision: parsed.ok ? "allow" : "deny",
    ...(typeof parsed.reason === "string" && parsed.reason ? { reason: parsed.reason } : {}),
  };
}

function failOpen(resolved: ResolvedHookHandler, message: string): HookOutput {
  const diagnostic: HookDiagnostic = {
    handlerId: resolved.id,
    source: resolved.source,
    level: "warn",
    message,
  };
  logger.warn(
    { handlerId: resolved.id, source: resolved.source.path, message },
    "[Hook] fail-open",
  );
  return { decision: "allow", diagnostics: [diagnostic] };
}

function handlerSignal(parent: AbortSignal | undefined, timeout: number): AbortSignal {
  const timer = AbortSignal.timeout(timeout);
  return parent ? AbortSignal.any([parent, timer]) : timer;
}

function timeoutMs(handler: { timeoutMs?: number }): number {
  return boundedInteger(handler.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 24 * 60 * 60 * 1000);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const signalProcess = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") {
        if (signal === "SIGKILL") {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        }
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      // 进程可能已经退出，kill 保持幂等。
    }
  };
  signalProcess("SIGTERM");
  const forceTimer = setTimeout(() => signalProcess("SIGKILL"), ABORT_KILL_GRACE_MS);
  forceTimer.unref();
}

function resolveHeaders(
  configured: Readonly<Record<string, string>>,
  allowedEnv: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(configured)) {
    if (["host", "content-length"].includes(name.toLowerCase())) {
      throw new Error(`HTTP handler 不允许设置 header: ${name}`);
    }
    const value = raw.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, braced: string | undefined, plain: string | undefined) => {
        const variable = braced ?? plain;
        if (!variable || !allowedEnv.has(variable)) {
          throw new Error(`HTTP handler header 引用未授权环境变量: ${String(variable)}`);
        }
        const value = env[variable];
        if (value === undefined) throw new Error(`HTTP handler header 环境变量不存在: ${variable}`);
        return value;
      },
    );
    headers.set(name, value);
  }
  return headers;
}

function stripSensitiveHeaders(headers: Headers): void {
  for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HTTP handler 不支持协议: ${url.protocol}`);
  }
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readLimitedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`HTTP handler 响应超过 ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error(`HTTP handler 响应超过 ${maxBytes} bytes`);
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error("MCP hook input 必须是 JSON 对象");
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Hook handler aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
