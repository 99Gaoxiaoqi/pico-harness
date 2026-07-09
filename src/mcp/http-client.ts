// HttpMcpClient:通过 HTTP/SSE 与 MCP server 通信的客户端。
//
// 支持两种 transport:
//   1. http (Streamable HTTP):每个 JSON-RPC 请求 POST 一次,响应可能是
//      application/json(单响应)或 text/event-stream(SSE 流,含本次响应)。
//   2. sse (legacy SSE):先 GET 建立 SSE 长连接收响应,POST 发请求;
//      server 首个 `endpoint` 事件告知 POST 地址。
//
// 不依赖 EventSource —— Node 的 fetch 已支持 streaming response,
// 手写 SSE 行解析即可,保持零外部依赖。
//
// 接口与 StdioMcpClient 一致(McpClient),让 McpConnectionManager 无感切换。

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
import { redactSensitiveText } from "./redact.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  controller: AbortController;
}

/**
 * HttpMcpClient:把一个远程 MCP server 封装成 McpClient 接口。
 *
 * 对 http transport:无状态,每个请求独立 POST。
 * 对 sse transport:connect() 时建立持久 SSE 连接,所有响应走该流;
 *   请求 POST 到 server 告知的 endpoint。
 */
export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private connected = false;
  private closed = false;
  /** sse 模式:POST 请求的目标地址(由 server 的 endpoint 事件告知) */
  private postEndpoint: string | undefined;
  /** sse 模式:读 SSE 流的 AbortController,close() 时中止 */
  private sseAbort: AbortController | undefined;
  private readonly activeControllers = new Set<AbortController>();
  private readonly closeHandlers: Array<(err?: Error) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  constructor(private readonly config: McpServerConfig) {
    if (config.transport !== "http" && config.transport !== "sse") {
      throw new Error(`HttpMcpClient 不支持 transport=${config.transport}`);
    }
    if (!config.url) {
      throw new Error(`MCP server "${config.name}" 缺少 url 字段(http/sse 模式必填)`);
    }
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error(`MCP server "${this.config.name}" 已关闭,无法重连`);
    if (this.connected) return;

    if (this.config.transport === "sse") {
      // sse:先建立持久连接,等 endpoint 事件
      await this.startSseStream();
    }
    // http transport 无需预连接,initialize 时直接 POST

    await this.initialize();
    this.connected = true;
    logger.info({ server: this.config.name, transport: this.config.transport }, `[MCP] ${this.config.transport} server "${this.config.name}" 连接成功`);
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

    // 中止 SSE 流
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = undefined;
    }
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    // 拒绝所有 pending
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
      pending.reject(new Error(`MCP server "${this.config.name}" 已关闭`));
    }
    this.pending.clear();
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  // ---------- 内部实现 ----------

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
    // Streamable HTTP 不强制要求 initialized 通知,但发了无害;sse 通道下用 POST 发
    if (this.config.transport === "sse" && this.postEndpoint) {
      await this.sendHttpPost({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }).catch(() => {
        /* notification 失败不影响后续 */
      });
    } else {
      // http transport:尽力发 notification,失败静默
      await this.sendHttpPost({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }).catch(() => {});
    }
  }

  /**
   * 发送 JSON-RPC request 并等待响应。
   * - http:POST 本次请求,直接从响应体(JSON 或 SSE)拿结果。
   * - sse:POST 到 endpoint,响应走已建立的 SSE 流。
   */
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.config.toolTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        controller.abort();
        reject(new Error(`MCP server "${this.config.name}" 请求 ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, controller });

      const send = this.config.transport === "sse" ? this.postEndpoint : undefined;
      // http:sendHttpPost 会从响应体直接 resolve;sse:仅 POST,响应走 SSE 流
      this.sendHttpPost(req, send, controller)
        .then((directResult) => {
          // http transport:响应体已包含结果,直接 resolve
          if (directResult !== undefined) {
            clearTimeout(timer);
            this.pending.delete(id);
            if (directResult.error) {
              reject(new Error(`MCP server "${this.config.name}" 返回错误: ${directResult.error.message}`));
            } else {
              resolve(directResult.result);
            }
          }
          // sse transport:directResult 为 undefined,等 SSE 流 resolve
        })
        .catch((err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(redactSensitiveText(`MCP server "${this.config.name}" 发送请求失败: ${err.message}`)));
        });
    });
  }

  /**
   * POST 一个 JSON-RPC 消息。
   * @param targetUrl 目标地址;sse 模式用 server 告知的 endpoint,http 模式就是 config.url
   * @returns http 模式返回解析后的 JsonRpcResponse;sse 模式返回 undefined(响应走 SSE 流)
   */
  private async sendHttpPost(
    msg: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> },
    targetUrl?: string,
    controller = new AbortController(),
  ): Promise<JsonRpcResponse | undefined> {
    const url = targetUrl ?? this.config.url!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
    };

    try {
      this.activeControllers.add(controller);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get("content-type") ?? "";

      // SSE 响应:读流直到拿到对应 id 的 response
      if (contentType.includes("text/event-stream")) {
        return await this.readSseResponse(res, msg);
      }

      // JSON 响应:直接解析
      if (contentType.includes("application/json")) {
        const body = (await res.json()) as JsonRpcResponse;
        return body;
      }

      // 兜底:当纯文本解析
      const text = await res.text();
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new Error(`MCP server "${this.config.name}" 返回无法解析的响应: ${text.slice(0, 200)}`);
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * 从 HTTP 响应的 SSE 流中读取,直到拿到匹配本次请求 id 的 response。
   * (适用于 http transport 的 SSE 响应模式)
   */
  private async readSseResponse(
    res: Response,
    msg: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> },
  ): Promise<JsonRpcResponse | undefined> {
    const body = res.body;
    const wantId = "id" in msg ? msg.id : undefined;
    if (!body) {
      if (wantId !== undefined) {
        throw new Error(`missing response id ${String(wantId)} in HTTP SSE response`);
      }
      return undefined;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = findSseSeparator(buffer)) !== -1) {
          const separatorLength = sseSeparatorLength(buffer, sep);
          const eventBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + separatorLength);
          const parsed = this.parseSseEvent(eventBlock);
          if (parsed !== null && parsed.id === wantId) {
            return parsed;
          }
        }
      }
      if (wantId !== undefined) {
        throw new Error(`missing response id ${String(wantId)} in HTTP SSE response`);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return undefined;
  }

  /** 解析一个 SSE 事件块(以空行分隔),提取 data 里的 JSON-RPC 消息 */
  private parseSseEvent(block: string): JsonRpcResponse | null {
    const lines = splitSseLines(block);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return null;
    try {
      const msg = JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      return msg;
    } catch {
      return null;
    }
  }

  /**
   * sse transport:建立持久 SSE 连接,持续读流并把 response 派发给 pending。
   * 首个 `endpoint` 事件告知 POST 地址。
   */
  private async startSseStream(): Promise<void> {
    this.sseAbort = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.config.headers ?? {}),
    };

    // 不 await:读流是无限循环,只在 endpoint 到达后 resolve
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      fetch(this.config.url!, {
        method: "GET",
        headers,
        signal: this.sseAbort!.signal,
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            rejectReady(new Error(`SSE 连接失败: HTTP ${res.status}`));
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let sep: number;
              while ((sep = findSseSeparator(buffer)) !== -1) {
                const separatorLength = sseSeparatorLength(buffer, sep);
                const eventBlock = buffer.slice(0, sep);
                buffer = buffer.slice(sep + separatorLength);
                this.handleSseEvent(eventBlock, resolveReady);
              }
            }
          } catch (err) {
            if (!this.closed) {
              const safeError = new Error(redactSensitiveText(`SSE 流中断: ${err instanceof Error ? err.message : String(err)}`));
              this.failAllPending(safeError);
              this.emitError(safeError);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            if (!this.closed && this.connected) {
              this.emitClose(new Error(`MCP server "${this.config.name}" SSE 流已关闭`));
            }
          }
        })
        .catch((err) => {
          if (!this.closed) {
            const safeError = new Error(redactSensitiveText(`SSE 连接失败: ${err instanceof Error ? err.message : String(err)}`));
            rejectReady(safeError);
            this.emitError(safeError);
          }
        });
    });

    // 等 endpoint 事件到达(带超时)
    await Promise.race([
      ready,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`等待 SSE endpoint 事件超时`)), this.config.startupTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      ),
    ]);
  }

  /** 处理 SSE 事件块:endpoint 事件设 POST 地址;message 事件派发给 pending */
  private handleSseEvent(block: string, onEndpoint: () => void): void {
    const lines = splitSseLines(block);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (event === "endpoint" && dataLines.length > 0) {
      // endpoint 事件:data 是 POST 地址(可能相对 URL)
      this.postEndpoint = this.resolveUrl(dataLines[0]!);
      onEndpoint();
      return;
    }
    if (dataLines.length === 0) return;
    try {
      const msg = JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      if (msg.id !== undefined) {
        this.resolvePending(msg);
      }
    } catch {
      /* 忽略无法解析的事件 */
    }
  }

  private resolvePending(response: JsonRpcResponse): void {
    const id = typeof response.id === "number" ? response.id : Number(response.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (response.error) {
      pending.reject(new Error(`MCP server "${this.config.name}" 返回错误: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
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

  /** 把相对 URL 解析成绝对(sse endpoint 可能是相对路径) */
  private resolveUrl(maybeRelative: string): string {
    try {
      return new URL(maybeRelative, this.config.url).toString();
    } catch {
      return maybeRelative;
    }
  }

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

  private normalizeToolResult(raw: unknown): McpToolResult {
    const r = raw as { content?: unknown; isError?: unknown };
    const content = Array.isArray(r.content) ? r.content : [];
    return {
      content: content as McpToolResult["content"],
      isError: r.isError === true,
    };
  }
}

function findSseSeparator(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function sseSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function splitSseLines(block: string): string[] {
  return block.split(/\r?\n/);
}
