// StdioMcpClient:通过子进程 stdin/stdout 通信的 MCP 客户端。
//
// MCP stdio transport 约定:每条 JSON-RPC 消息占一行(以 \n 分隔)。
// 客户端把请求写进子进程 stdin,从 stdout 读响应;stderr 留作诊断日志。
//
// 核心:请求/响应按 JSON-RPC 的 id 字段做关联。每发一个 request,
// 就在 pending map 里挂一个 Promise,收到对应 id 的 response 时 resolve。
// notification(无 id)不挂 Promise,直接忽略或交给可选回调。
//
// 生命周期:
//   connect()  → spawn 子进程 → 发 initialize → 收响应 → 发 initialized 通知
//   listTools() → 发 tools/list → 收响应 → 解析工具数组
//   callTool()  → 发 tools/call → 收响应 → 解析 content 块
//   close()     → kill 子进程 + 清理 pending

import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../observability/logger.js";
import { buildMinimalChildProcessEnv } from "../os/child-process-env.js";
import { signalProcessTree } from "../os/process-tree.js";
import { isWindows } from "../os/shell.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import {
  MCP_PROTOCOL_VERSION,
  PICO_MCP_CLIENT_INFO,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClient,
  type McpPromptGetResult,
  type McpPromptListResult,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpServerConfig,
  type McpTool,
  type McpToolResult,
} from "./types.js";
import { redactSensitiveArgs, redactSensitiveText, redactSensitiveValue } from "./redact.js";

/** 默认请求超时:30s。MCP server 可能启动慢(如 npx 首次下载) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_SIGTERM_TIMEOUT_MS = 200;
const CLOSE_SIGKILL_TIMEOUT_MS = 1000;
const CANCELLATION_FLUSH_TIMEOUT_MS = 25;
const MAX_STDIO_MESSAGE_BYTES = 8 * 1024 * 1024;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  abortReason?: Error;
}

/**
 * StdioMcpClient:把一个 MCP server 子进程封装成 McpClient 接口。
 *
 * 不依赖 @modelcontextprotocol/sdk —— 直接手写 JSON-RPC 2.0 over stdio,
 * 保持 pico-harness 零外部依赖的风格。
 */
export class StdioMcpClient implements McpClient {
  readonly toolCancellationScope: "process_tree" | "transport" = isWindows
    ? "transport"
    : "process_tree";
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** stdout 行缓冲:JSON-RPC 消息以 \n 分隔,跨 chunk 拼接不完整行 */
  private stdoutBuffer = "";
  /** stderr 尾部(最近 4KB),用于失败时给用户诊断信息 */
  private stderrBuffer = "";
  private connected = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private abortTermination: Promise<void> | undefined;
  private readonly closeHandlers: Array<(err?: Error) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  constructor(private readonly config: McpServerConfig) {
    if (config.transport !== "stdio") {
      throw new Error(`StdioMcpClient 不支持 transport=${config.transport},仅支持 stdio`);
    }
    if (!config.command) {
      throw new Error(`MCP server "${config.name}" 缺少 command 字段(stdio 模式必填)`);
    }
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error(`MCP server "${this.config.name}" 已关闭,无法重连`);
    if (this.connected) return;
    if (this.closing) throw new Error(`MCP server "${this.config.name}" 正在关闭`);
    if (this.abortTermination || this.pending.size > 0 || this.child) {
      throw new Error(`MCP server "${this.config.name}" 上一个进程树尚未收口,拒绝重连`);
    }

    // 同一 client 在非主动退出后重连时，不复用上一个进程的终止状态。
    this.abortTermination = undefined;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    const { args = [], env, cwd } = this.config;
    const command = this.config.command;
    if (!command) {
      throw new Error(`MCP server "${this.config.name}" 缺少 command(stdio 模式必填)`);
    }
    const childEnv = buildMinimalChildProcessEnv(env);

    const safeCommand = redactSensitiveText(command);
    const safeArgs = redactSensitiveArgs(args);
    logger.info(
      {
        server: this.config.name,
        command: safeCommand,
        args: safeArgs,
        env: redactSensitiveValue(env),
      },
      `[MCP] 启动 stdio server: ${safeCommand} ${safeArgs.join(" ")}`,
    );
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      detached: !isWindows,
      ...(cwd !== undefined ? { cwd } : {}),
    });

    this.wireStreams();

    // 等子进程 stdout 就绪后做 initialize 握手
    await this.initialize();
    this.connected = true;
    logger.info({ server: this.config.name }, `[MCP] stdio server "${this.config.name}" 连接成功`);
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t) => this.normalizeTool(t));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, context?.signal);
    return this.normalizeToolResult(result);
  }

  async listResources(cursor?: string): Promise<McpResourceListResult> {
    const result = (await this.request("resources/list", cursor ? { cursor } : {})) as {
      resources?: unknown;
      nextCursor?: unknown;
    };
    return {
      resources: Array.isArray(result.resources)
        ? (result.resources as McpResourceListResult["resources"])
        : [],
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    const result = (await this.request("resources/read", { uri })) as { contents?: unknown };
    return {
      contents: Array.isArray(result.contents)
        ? (result.contents as McpResourceReadResult["contents"])
        : [],
    };
  }

  async listPrompts(cursor?: string): Promise<McpPromptListResult> {
    const result = (await this.request("prompts/list", cursor ? { cursor } : {})) as {
      prompts?: unknown;
      nextCursor?: unknown;
    };
    return {
      prompts: Array.isArray(result.prompts)
        ? (result.prompts as McpPromptListResult["prompts"])
        : [],
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    const result = (await this.request("prompts/get", {
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    })) as { description?: unknown; messages?: unknown };
    return {
      ...(typeof result.description === "string" ? { description: result.description } : {}),
      messages: Array.isArray(result.messages)
        ? (result.messages as McpPromptGetResult["messages"])
        : [],
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    let resolveClose!: () => void;
    let rejectClose!: (reason?: unknown) => void;
    const closing = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveClose = resolvePromise;
      rejectClose = rejectPromise;
    });
    this.closing = closing;
    void this.closeInternal().then(resolveClose, rejectClose);
    void closing.then(
      () => {
        if (this.closing === closing) this.closing = undefined;
      },
      () => {
        if (this.closing === closing) this.closing = undefined;
      },
    );
    return closing;
  }

  private async closeInternal(): Promise<void> {
    this.connected = false;

    const child = this.child;
    if (child) {
      child.stdin?.end();
      // 主动 close 可以是 reconnect 的前置；必须确认整树收口才能放行新实例。
      const stopped = await terminateProcessTree(child, true);
      if (!stopped) {
        throw new Error(`MCP server "${this.config.name}" 进程树未能物理收口`);
      }
      this.removeAllListeners();
      this.child = undefined;
    }
    this.failAllPending(new Error(`MCP server "${this.config.name}" 已关闭`));
    this.closed = true;
  }

  /** 返回 stderr 尾部快照(失败诊断用) */
  stderrSnapshot(): string {
    return redactSensitiveText(this.stderrBuffer);
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  // ---------- 内部实现 ----------

  private wireStreams(): void {
    const child = this.child!;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      if (!this.drainStdoutLines()) {
        this.failProtocol(`stdout JSON-RPC 消息超过 ${MAX_STDIO_MESSAGE_BYTES} 字节上限`);
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      // 累积 stderr 尾部(最多 4KB),不直接打印避免噪音
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - 4096);
      }
    });

    const stdin = child.stdin;
    const onStdinError = (err: Error): void => {
      const safeError = new Error(
        redactSensitiveText(`MCP server "${this.config.name}" stdin 错误: ${err.message}`),
      );
      if (this.child !== child || this.closed || this.closing || this.hasAbortingRequest()) {
        // close/abort 主动关闭 pipe 时 EPIPE 是预期竞态；吸收 error 事件避免崩溃。
        logger.debug(
          { server: this.config.name, err: safeError.message },
          `[MCP] 关闭期间 stdin error 已吸收`,
        );
        return;
      }
      logger.error(
        { server: this.config.name, err: safeError.message },
        `[MCP] stdin error: ${safeError.message}`,
      );
      this.connected = false;
      this.startPhysicalTermination(safeError, Promise.resolve(), "error");
    };
    stdin?.on("error", onStdinError);
    stdin?.once("close", () => stdin.removeListener("error", onStdinError));

    child.on("error", (err) => {
      const safeError = new Error(
        redactSensitiveText(`MCP server "${this.config.name}" 子进程错误: ${err.message}`),
      );
      logger.error(
        { server: this.config.name, err: safeError.message },
        `[MCP] 子进程 error: ${safeError.message}`,
      );
      this.connected = false;
      if (this.closing || this.hasAbortingRequest()) return;
      this.startPhysicalTermination(safeError, Promise.resolve(), "error");
    });

    child.on("exit", (code, signal) => {
      logger.warn(
        { server: this.config.name, code, signal },
        `[MCP] 子进程退出 code=${code} signal=${signal}`,
      );
      this.connected = false;
      if (!this.closed && !this.closing) {
        if (this.hasAbortingRequest()) return;
        // server 主进程退出不代表孙进程已停止；先收口进程组再拒绝 pending。
        const msg = `MCP server "${this.config.name}" 子进程意外退出(code=${code} signal=${signal})`;
        const err = new Error(redactSensitiveText(msg));
        if (this.stderrBuffer.length > 0) {
          err.message += `\nstderr: ${redactSensitiveText(this.stderrBuffer.trimEnd())}`;
        }
        this.startPhysicalTermination(err, Promise.resolve(), "close");
      }
    });
  }

  private removeAllListeners(): void {
    if (!this.child) return;
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.removeAllListeners("error");
    this.child.removeAllListeners("exit");
  }

  /** 把 stdout 缓冲按 \n 切分,每行尝试解析为 JSON-RPC 消息 */
  private drainStdoutLines(): boolean {
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (Buffer.byteLength(rawLine, "utf8") > MAX_STDIO_MESSAGE_BYTES) return false;
      const line = rawLine.trim();
      if (line.length === 0) continue;
      this.handleMessage(line);
    }
    return Buffer.byteLength(this.stdoutBuffer, "utf8") <= MAX_STDIO_MESSAGE_BYTES;
  }

  private handleMessage(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn(
        { server: this.config.name, preview: redactSensitiveText(line.slice(0, 512)) },
        `[MCP] 无法解析 stdout 行为 JSON,已忽略`,
      );
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const response = msg as JsonRpcResponse;
    // 只处理有 id 的 response;notification(无 id)忽略
    if (response.id === undefined) {
      logger.debug(
        { server: this.config.name, method: (msg as { method?: string }).method },
        `[MCP] 收到 notification`,
      );
      return;
    }
    this.resolvePending(response);
  }

  /** 把 JSON-RPC response 派发给对应的 pending Promise */
  private resolvePending(response: JsonRpcResponse): void {
    const id = typeof response.id === "number" ? response.id : Number(response.id);
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warn({ server: this.config.name, id }, `[MCP] 收到未知 id=${id} 的响应,已忽略`);
      return;
    }
    // abort 后即使 server 抢先回复，也必须等进程树退出，不得伪造已收口。
    if (pending.abortReason) return;
    this.takePending(id);

    if (response.error) {
      pending.reject(
        new Error(
          redactSensitiveText(
            `MCP server "${this.config.name}" 返回错误: ${response.error.message}`.slice(0, 4096),
          ),
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /** 拒绝所有 pending(子进程挂了时调用) */
  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.takePending(id);
      pending.reject(pending.abortReason ?? err);
    }
  }

  private emitClose(err?: Error): void {
    for (const handler of this.closeHandlers) {
      handler(err);
    }
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      handler(err);
    }
  }

  private failProtocol(reason: string): void {
    const error = new Error(redactSensitiveText(`MCP server "${this.config.name}" ${reason}`));
    this.stdoutBuffer = "";
    this.connected = false;
    this.startPhysicalTermination(error, Promise.resolve(), "error");
  }

  /**
   * 发送 JSON-RPC request 并等待对应 id 的响应。
   * 超时拒绝,防子进程卡死。
   */
  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" stdin 不可写`));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.config.toolTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const line = JSON.stringify(req) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_STDIO_MESSAGE_BYTES) {
      return Promise.reject(
        new Error(`MCP server "${this.config.name}" 请求 ${method} 超过大小上限`),
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abortPendingRequest(
          id,
          new Error(`MCP server "${this.config.name}" 请求 ${method} 超时(${timeoutMs}ms)`),
        );
      }, timeoutMs);

      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abortListener = () => this.abortPendingRequest(id, abortReason(signal));
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      if (signal?.aborted) {
        pending.abortListener?.();
        return;
      }
      this.child!.stdin!.write(line, (err) => {
        if (err) {
          const current = this.pending.get(id);
          if (current?.abortReason) return;
          this.abortPendingRequest(
            id,
            new Error(
              redactSensitiveText(
                `MCP server "${this.config.name}" 写入 stdin 失败: ${err.message}`,
              ),
            ),
          );
        }
      });
    });
  }

  /** 发送 notification(无 id,不等待响应) */
  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    const msg = { jsonrpc: "2.0", method, params };
    const line = JSON.stringify(msg) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_STDIO_MESSAGE_BYTES) {
      logger.warn({ server: this.config.name, method }, `[MCP] notification 超过大小上限,已忽略`);
      return;
    }
    this.child.stdin.write(line);
  }

  /** 将 cancellation notification 交给 OS pipe；具体终止顺序由平台边界决定。 */
  private notifyFlushed(method: string, params: Record<string, unknown>): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return Promise.resolve();
    const line = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_STDIO_MESSAGE_BYTES) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, CANCELLATION_FLUSH_TIMEOUT_MS);
      stdin.write(line, finish);
    });
  }

  /** stdio 工具中止会发 MCP cancellation 并收口本地 server 进程树。 */
  private abortPendingRequest(id: number, reason: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.abortReason) return;
    pending.abortReason = reason;
    clearTimeout(pending.timer);
    const cancellation = this.notifyFlushed("notifications/cancelled", {
      requestId: id,
      reason: reason.message,
    });
    this.startPhysicalTermination(reason, cancellation, "close");
  }

  private startPhysicalTermination(
    reason: Error,
    cancellation: Promise<void>,
    event: "close" | "error",
  ): void {
    if (this.abortTermination) return;
    const termination = this.terminateAndSettle(reason, cancellation, event);
    this.abortTermination = termination;
    void termination.then(
      () => {
        if (this.abortTermination === termination) this.abortTermination = undefined;
      },
      () => {
        if (this.abortTermination === termination) this.abortTermination = undefined;
      },
    );
  }

  private async terminateAndSettle(
    reason: Error,
    cancellation: Promise<void>,
    event: "close" | "error",
  ): Promise<void> {
    const child = this.child;
    if (!child) {
      this.failAllPending(reason);
      if (!this.closed && !this.closing) {
        if (event === "error") this.emitError(reason);
        else this.emitClose(reason);
      }
      return;
    }
    const requireTreeProof = this.hasPendingToolCall();
    // POSIX 先把 cancellation 交给 pipe 再终止进程组。Windows tools/call
    // 为避免根进程先退出而无法 taskkill /T，与 cancellation flush 并行启动。
    const concurrentTermination =
      isWindows && requireTreeProof ? terminateProcessTree(child, requireTreeProof) : undefined;
    await cancellation;
    const stopped = await (concurrentTermination ?? terminateProcessTree(child, requireTreeProof));
    if (!stopped) {
      // 不能证明物理副作已停止时 fail-closed：保持 pending，不伪造完成。
      logger.error(
        { server: this.config.name },
        `[MCP] 中止后 server 进程树未能物理收口，保持调用挂起`,
      );
      return;
    }
    // exit/error listener 在终止期间故意不 settle；只有进程组消失后才收口。
    this.removeAllListeners();
    this.failAllPending(reason);
    if (this.child === child) this.child = undefined;
    if (!this.closed && !this.closing) {
      if (event === "error") this.emitError(reason);
      else this.emitClose(reason);
    }
  }

  private hasAbortingRequest(): boolean {
    return (
      this.abortTermination !== undefined || [...this.pending.values()].some((p) => p.abortReason)
    );
  }

  private hasPendingToolCall(): boolean {
    return [...this.pending.values()].some((pending) => pending.method === "tools/call");
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
    return pending;
  }

  /** MCP initialize 握手:声明客户端身份 + 协议版本 */
  private async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: PICO_MCP_CLIENT_INFO,
    });
    const serverInfo = (result as { serverInfo?: { name?: string; version?: string } }).serverInfo;
    logger.info(
      { server: this.config.name, serverInfo },
      `[MCP] 握手成功: ${serverInfo?.name ?? "unknown"} v${serverInfo?.version ?? "?"}`,
    );
    // 握手后必须发 initialized 通知,server 才会响应后续请求
    this.notify("notifications/initialized", {});
  }

  /** 把 server 返回的工具对象归一化,补全缺失字段 */
  private normalizeTool(raw: unknown): McpTool {
    const t = raw as { name?: string; description?: string; inputSchema?: unknown };
    return {
      name: t.name ?? "",
      description: t.description ?? "",
      inputSchema:
        typeof t.inputSchema === "object" && t.inputSchema !== null
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object" },
    };
  }

  /** 把 tools/call 返回值归一化为 McpToolResult */
  private normalizeToolResult(raw: unknown): McpToolResult {
    const r = raw as { content?: unknown; isError?: unknown };
    const content = Array.isArray(r.content) ? r.content : [];
    return {
      content: content as McpToolResult["content"],
      isError: r.isError === true,
    };
  }
}

function isChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("MCP tool call aborted", "AbortError");
}

async function terminateProcessTree(
  child: ChildProcess,
  requireWindowsTreeProof: boolean,
): Promise<boolean> {
  if (isWindows) {
    const signalled = await signalProcessTree(child, "SIGTERM", {
      requireWindowsTreeProof,
    }).catch(() => false);
    if (!signalled) return false;
    return waitForChildExit(child, CLOSE_SIGKILL_TIMEOUT_MS);
  }

  const pid = child.pid;
  if (pid === undefined) return isChildExited(child);
  if (isChildExited(child) && !isProcessGroupAlive(pid)) return true;

  signalDetachedProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(child, pid, CLOSE_SIGTERM_TIMEOUT_MS)) return true;
  signalDetachedProcessGroup(pid, "SIGKILL");
  return waitForProcessGroupExit(child, pid, CLOSE_SIGKILL_TIMEOUT_MS);
}

function signalDetachedProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH 表示进程组已消失；其它失败会在后续存活检查中 fail-closed。
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitForProcessGroupExit(
  child: ChildProcess,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (isChildExited(child) && !isProcessGroupAlive(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const poll = setInterval(check, 10);
    const timer = setTimeout(
      () => finish(isChildExited(child) && !isProcessGroupAlive(pid)),
      timeoutMs,
    );
    const onExit = () => check();
    child.once("exit", onExit);

    function check(): void {
      if (isChildExited(child) && !isProcessGroupAlive(pid)) finish(true);
    }
    function finish(stopped: boolean): void {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(stopped);
    }
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}
