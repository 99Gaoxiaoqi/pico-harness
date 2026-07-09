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
import {
  MCP_PROTOCOL_VERSION,
  PICO_MCP_CLIENT_INFO,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClient,
  type McpServerConfig,
  type McpTool,
  type McpToolResult,
} from "./types.js";
import { redactSensitiveText, redactSensitiveValue } from "./redact.js";

/** 默认请求超时:30s。MCP server 可能启动慢(如 npx 首次下载) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_SIGTERM_TIMEOUT_MS = 200;
const CLOSE_SIGKILL_TIMEOUT_MS = 1000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * StdioMcpClient:把一个 MCP server 子进程封装成 McpClient 接口。
 *
 * 不依赖 @modelcontextprotocol/sdk —— 直接手写 JSON-RPC 2.0 over stdio,
 * 保持 pico-harness 零外部依赖的风格。
 */
export class StdioMcpClient implements McpClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** stdout 行缓冲:JSON-RPC 消息以 \n 分隔,跨 chunk 拼接不完整行 */
  private stdoutBuffer = "";
  /** stderr 尾部(最近 4KB),用于失败时给用户诊断信息 */
  private stderrBuffer = "";
  private connected = false;
  private closed = false;
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

    const { args = [], env, cwd } = this.config;
    const command = this.config.command;
    if (!command) {
      throw new Error(`MCP server "${this.config.name}" 缺少 command(stdio 模式必填)`);
    }
    // 合并父进程 env,再覆盖 config.env —— 否则 npx/uvx 找不到 PATH
    const childEnv = { ...process.env, ...env };

    const safeCommand = redactSensitiveText(command);
    const safeArgs = args.map((arg) => redactSensitiveText(arg));
    logger.info(
      { server: this.config.name, command: safeCommand, args: safeArgs, env: redactSensitiveValue(env) },
      `[MCP] 启动 stdio server: ${safeCommand} ${safeArgs.join(" ")}`,
    );
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
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

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return this.normalizeToolResult(result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    // 拒绝所有 pending 请求,让调用方尽快感知关闭
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP server "${this.config.name}" 已关闭`));
    }
    this.pending.clear();

    const child = this.child;
    if (child) {
      this.removeAllListeners();
      this.child = undefined;
      child.stdin?.end();
      if (!isChildExited(child)) {
        child.kill("SIGTERM");
      }
      if (!(await waitForChildExit(child, CLOSE_SIGTERM_TIMEOUT_MS)) && !isChildExited(child)) {
        child.kill("SIGKILL");
        await waitForChildExit(child, CLOSE_SIGKILL_TIMEOUT_MS).catch(() => false);
      }
    }
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
      this.drainStdoutLines();
    });

    child.stderr?.on("data", (chunk: string) => {
      // 累积 stderr 尾部(最多 4KB),不直接打印避免噪音
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - 4096);
      }
    });

    child.on("error", (err) => {
      const safeError = new Error(redactSensitiveText(`MCP server "${this.config.name}" 子进程错误: ${err.message}`));
      logger.error({ server: this.config.name, err: safeError.message }, `[MCP] 子进程 error: ${safeError.message}`);
      this.failAllPending(safeError);
      this.emitError(safeError);
    });

    child.on("exit", (code, signal) => {
      logger.warn({ server: this.config.name, code, signal }, `[MCP] 子进程退出 code=${code} signal=${signal}`);
      if (!this.closed) {
        // 非主动关闭 → 异常退出,拒绝所有 pending
        const msg = `MCP server "${this.config.name}" 子进程意外退出(code=${code} signal=${signal})`;
        const err = new Error(redactSensitiveText(msg));
        if (this.stderrBuffer.length > 0) {
          err.message += `\nstderr: ${redactSensitiveText(this.stderrBuffer.trimEnd())}`;
        }
        this.failAllPending(err);
        this.connected = false;
        this.emitClose(err);
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
  private drainStdoutLines(): void {
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn({ server: this.config.name, line }, `[MCP] 无法解析 stdout 行为 JSON,已忽略`);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const response = msg as JsonRpcResponse;
    // 只处理有 id 的 response;notification(无 id)忽略
    if (response.id === undefined) {
      logger.debug({ server: this.config.name, method: (msg as { method?: string }).method }, `[MCP] 收到 notification`);
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
    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (response.error) {
      pending.reject(
        new Error(`MCP server "${this.config.name}" 返回错误: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /** 拒绝所有 pending(子进程挂了时调用) */
  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
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

  /**
   * 发送 JSON-RPC request 并等待对应 id 的响应。
   * 超时拒绝,防子进程卡死。
   */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server "${this.config.name}" stdin 不可写`));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.config.toolTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.config.name}" 请求 ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify(req) + "\n";
      this.child!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`MCP server "${this.config.name}" 写入 stdin 失败: ${err.message}`));
        }
      });
    });
  }

  /** 发送 notification(无 id,不等待响应) */
  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    const msg = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(msg) + "\n");
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
