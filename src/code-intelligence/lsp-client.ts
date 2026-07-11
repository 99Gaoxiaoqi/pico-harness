import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { logger } from "../observability/logger.js";
import type { LspServerConfig } from "./lsp-server-discovery.js";
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcId,
  type LspJsonRpcNotification,
  type LspJsonRpcRequest,
  type LspJsonRpcResponse,
  type LspServerMessage,
} from "./lsp-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 500;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly abortHandler?: () => void;
}

export interface LspRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type LspNotificationHandler = (params: unknown) => void;

/** LSP 3.17 stdio transport：Content-Length 帧 + JSON-RPC 请求关联。 */
export class StdioLspClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private inputBuffer = Buffer.alloc(0);
  private expectedBodyLength: number | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<LspNotificationHandler>>();
  private state: "new" | "starting" | "ready" | "closing" | "closed" = "new";
  private terminalError: Error | undefined;

  constructor(
    private readonly rootDir: string,
    private readonly config: LspServerConfig,
  ) {}

  async start(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state !== "new") throw new Error(`LSP client 当前状态为 ${this.state}，无法启动`);
    this.state = "starting";
    this.child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.rootDir,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.wireChild(this.child);

    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(this.rootDir).href,
          capabilities: {
            workspace: { workspaceFolders: true },
            textDocument: {
              definition: {},
              references: {},
              documentSymbol: {},
              publishDiagnostics: {},
              callHierarchy: {},
            },
          },
          workspaceFolders: [{ uri: pathToFileURL(this.rootDir).href, name: this.rootDir }],
          clientInfo: { name: "pico-harness", version: "0.1.0" },
        },
        { timeoutMs: this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS },
      );
      this.notify("initialized", {});
      this.state = "ready";
    } catch (error) {
      const startupError = toError(error, `LSP server ${this.config.id} 启动失败`);
      await this.forceClose(startupError);
      throw startupError;
    }
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  request(method: string, params?: unknown, options: LspRequestOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`LSP 请求 ${method} 已取消`));
    }
    const child = this.child;
    if (!child?.stdin.writable || this.state === "closing" || this.state === "closed") {
      return Promise.reject(this.terminalError ?? new Error(`LSP server ${this.config.id} 不可用`));
    }

    const id = this.nextId++;
    const timeoutMs =
      options.timeoutMs ?? this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancelPending(id, new Error(`LSP 请求 ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const abortHandler = options.signal
        ? (): void => this.cancelPending(id, new Error(`LSP 请求 ${method} 已取消`))
        : undefined;
      if (abortHandler) options.signal?.addEventListener("abort", abortHandler, { once: true });
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(abortHandler ? { abortHandler } : {}),
      });
      try {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.settlePending(id, toError(error, `LSP 请求 ${method} 写入失败`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(method: string, handler: LspNotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<LspNotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "new") {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    try {
      if (this.child?.stdin.writable) {
        await this.requestDuringClose("shutdown", undefined, CLOSE_TIMEOUT_MS).catch(
          () => undefined,
        );
        if (this.child?.stdin.writable) this.notify("exit");
      }
    } finally {
      await this.forceClose(new Error(`LSP server ${this.config.id} 已关闭`));
    }
  }

  private requestDuringClose(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    this.state = "ready";
    const promise = this.request(method, params, { timeoutMs });
    this.state = "closing";
    return promise;
  }

  private wireChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      this.inputBuffer = Buffer.concat([this.inputBuffer, chunk]);
      this.drainFrames();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      logger.debug({ server: this.config.id, stderr: chunk.trimEnd() }, "[LSP] server stderr");
    });
    child.once("error", (error) => {
      void this.forceClose(toError(error, `LSP server ${this.config.id} 子进程错误`));
    });
    child.once("exit", (code, signal) => {
      if (this.state === "closed") return;
      void this.forceClose(
        new Error(
          `LSP server ${this.config.id} 已退出(code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  }

  private drainFrames(): void {
    while (true) {
      if (this.expectedBodyLength === undefined) {
        const separator = this.inputBuffer.indexOf("\r\n\r\n");
        if (separator < 0) return;
        const headers = this.inputBuffer.subarray(0, separator).toString("ascii");
        this.inputBuffer = this.inputBuffer.subarray(separator + 4);
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headers);
        if (!match?.[1]) {
          void this.forceClose(
            new Error(`LSP server ${this.config.id} 返回的消息缺少 Content-Length`),
          );
          return;
        }
        this.expectedBodyLength = Number(match[1]);
      }
      if (this.inputBuffer.length < this.expectedBodyLength) return;
      const body = this.inputBuffer.subarray(0, this.expectedBodyLength).toString("utf8");
      this.inputBuffer = this.inputBuffer.subarray(this.expectedBodyLength);
      this.expectedBodyLength = undefined;
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: LspServerMessage;
    try {
      message = JSON.parse(body) as LspServerMessage;
    } catch {
      logger.warn({ server: this.config.id }, "[LSP] 忽略无法解析的 JSON-RPC 消息");
      return;
    }
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        this.settlePending(
          message.id,
          new Error(`LSP 请求 ${pending.method} 失败: ${message.error.message}`),
        );
      } else {
        this.settlePending(message.id, undefined, message.result);
      }
      return;
    }
    if (isJsonRpcNotification(message)) {
      for (const handler of this.notificationHandlers.get(message.method) ?? []) {
        handler(message.params);
      }
      return;
    }
    if ("method" in message && "id" in message) {
      this.handleServerRequest(message);
    }
  }

  private handleServerRequest(request: LspJsonRpcRequest): void {
    const result = this.serverRequestResult(request.method, request.params);
    if (result.supported) {
      this.writeMessage({ jsonrpc: "2.0", id: request.id, result: result.value });
      return;
    }
    this.writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `pico 不支持 LSP server 请求: ${request.method}` },
    });
  }

  private serverRequestResult(
    method: string,
    params: unknown,
  ): { supported: true; value: unknown } | { supported: false } {
    switch (method) {
      case "workspace/configuration": {
        const count =
          typeof params === "object" &&
          params !== null &&
          "items" in params &&
          Array.isArray(params.items)
            ? params.items.length
            : 0;
        return { supported: true, value: Array.from({ length: count }, () => null) };
      }
      case "workspace/workspaceFolders":
        return {
          supported: true,
          value: [{ uri: pathToFileURL(this.rootDir).href, name: this.rootDir }],
        };
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        return { supported: true, value: null };
      case "workspace/applyEdit":
        return {
          supported: true,
          value: { applied: false, failureReason: "pico 代码智能客户端仅提供只读导航" },
        };
      default:
        return { supported: false };
    }
  }

  private cancelPending(id: JsonRpcId, error: Error): void {
    if (!this.pending.has(id)) return;
    try {
      this.notify("$/cancelRequest", { id });
    } catch {
      // server 已退出时仍需立即 settle 本地 Promise。
    }
    this.settlePending(id, error);
  }

  private settlePending(id: JsonRpcId, error?: Error, result?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private writeMessage(
    message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
  ): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error(`LSP server ${this.config.id} stdin 不可写`);
    const body = Buffer.from(JSON.stringify(message), "utf8");
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  }

  private async forceClose(error: Error): Promise<void> {
    if (this.state === "closed") return;
    this.terminalError = error;
    this.state = "closed";
    for (const id of [...this.pending.keys()]) this.settlePending(id, error);
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, CLOSE_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function toError(value: unknown, prefix: string): Error {
  return value instanceof Error ? new Error(`${prefix}: ${value.message}`) : new Error(prefix);
}
