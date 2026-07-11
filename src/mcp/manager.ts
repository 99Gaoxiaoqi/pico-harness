// McpConnectionManager: MCP server 连接、工具桥接与运行时生命周期编排。

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { logger } from "../observability/logger.js";
import type { ToolRegistry } from "../tools/registry-impl.js";
import { HttpMcpClient } from "./http-client.js";
import { McpToolBridge } from "./mcp-tool.js";
import { redactSensitiveText } from "./redact.js";
import { StdioMcpClient } from "./stdio-client.js";
import {
  assertMcpInputSchema,
  qualifyMcpToolName,
  type McpClient,
  type McpConfig,
  type McpConnectionStatus,
  type McpPromptGetResult,
  type McpPromptListResult,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpServerConfig,
  type McpTool,
} from "./types.js";

const DEFAULT_CONFIG_RELATIVE = ".claw/mcp.json";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

interface ServerEntry {
  name: string;
  config: McpServerConfig;
  status: McpConnectionStatus;
  client?: McpClient;
  tools: McpTool[];
  toolNames: string[];
  error?: string;
}

export interface McpServerStatus {
  readonly name: string;
  readonly transport: string;
  readonly status: McpConnectionStatus;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly error?: string;
}

export interface McpStatusSummary {
  readonly total: number;
  readonly connected: number;
  readonly failed: number;
  readonly disabled: number;
  readonly pending: number;
  readonly needsAuth: number;
  readonly toolCount: number;
}

export interface McpStatusSnapshot {
  readonly configPath?: string;
  readonly loadError?: string;
  readonly servers: readonly McpServerStatus[];
  readonly summary: McpStatusSummary;
}

/** OAuth 宿主只能返回可安全合并到 transport 的凭据补丁。 */
export interface McpOAuthCredentials {
  headers?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string>>;
}

/** 授权回调收到的是不含现有凭据的 server 描述。 */
export interface McpOAuthRequest {
  name: string;
  transport: McpServerConfig["transport"];
  url?: string;
}

export type McpOAuthHandler = (request: McpOAuthRequest) => Promise<McpOAuthCredentials>;
export type McpStatusListener = (snapshot: McpStatusSnapshot) => void;

export interface McpConnectionManagerOptions {
  /** stdio 子进程的默认 cwd。 */
  stdioCwd?: string;
  /** 由 TUI 宿主实现的 OAuth 交互，manager 不保存中间 token。 */
  oauthHandler?: McpOAuthHandler;
}

/**
 * 连接 manager 与 ToolRegistry 解耦：server 只连一次，每轮新 registry 只重新桥接已发现工具。
 * 所有修改生命周期的公开操作经同一队列串行，避免 reload/reconnect/close 交叉。
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private registry: ToolRegistry | undefined;
  private configPath: string | undefined;
  private loadError: string | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private reloadPromise: Promise<void> | undefined;

  constructor(
    registry?: ToolRegistry,
    private readonly options: McpConnectionManagerOptions = {},
  ) {
    this.registry = registry;
  }

  /** 订阅不可变状态快照；订阅时立即推送一次当前状态。 */
  subscribe(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getStatusSnapshot());
    } catch (err) {
      logger.warn({ err: safeErrorMessage(err) }, `[MCP] 状态订阅者执行失败`);
    }
    return () => this.listeners.delete(listener);
  }

  /** 切换每轮 Agent 的 registry，不重连 server。 */
  attachRegistry(registry: ToolRegistry): void {
    if (this.registry === registry) {
      this.emitSnapshot();
      return;
    }
    this.detachRegistry();
    this.registry = registry;
    for (const entry of this.entries.values()) this.registerEntryTools(entry);
    this.emitSnapshot();
  }

  /** 从指定/当前 registry 卸载 MCP 桥接，保留 server 连接与工具定义。 */
  detachRegistry(registry?: ToolRegistry): void {
    if (!this.registry || (registry !== undefined && registry !== this.registry)) return;
    for (const entry of this.entries.values()) this.unregisterEntryTools(entry, this.registry);
    this.registry = undefined;
    this.emitSnapshot();
  }

  async loadConfig(configPath: string): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.closeEntries();
      this.entries.clear();
      await this.loadConfigInternal(configPath);
    });
  }

  async connectAll(): Promise<void> {
    return this.enqueueLifecycle(async () => this.connectAllInternal());
  }

  /** 关闭旧连接并从磁盘重读配置；同时多次 reload 复用同一次执行。 */
  reload(configPath?: string): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    const target = configPath ?? this.configPath ?? DEFAULT_CONFIG_RELATIVE;
    const running = this.enqueueLifecycle(async () => {
      await this.closeEntries();
      this.entries.clear();
      await this.loadConfigInternal(target);
      await this.connectAllInternal();
    });
    const tracked = running.finally(() => {
      if (this.reloadPromise === tracked) this.reloadPromise = undefined;
    });
    this.reloadPromise = tracked;
    return tracked;
  }

  async enable(name: string): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const entry = this.requireEntry(name);
      entry.config = { ...entry.config, enabled: true };
      if (entry.status === "connected") {
        this.emitSnapshot();
        return;
      }
      entry.status = "pending";
      entry.error = undefined;
      this.emitSnapshot();
      await this.connectOne(entry);
    });
  }

  async disable(name: string): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const entry = this.requireEntry(name);
      entry.config = { ...entry.config, enabled: false };
      await this.closeEntryClient(entry);
      this.clearEntryTools(entry);
      entry.status = "disabled";
      entry.error = undefined;
      this.emitSnapshot();
    });
  }

  async reconnect(name: string): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const entry = this.requireEntry(name);
      if (entry.config.enabled === false) {
        throw new Error(`MCP server "${name}" 已禁用，请先 enable`);
      }
      await this.closeEntryClient(entry);
      this.clearEntryTools(entry);
      entry.status = "pending";
      entry.error = undefined;
      this.emitSnapshot();
      await this.connectOne(entry);
    });
  }

  /** 由宿主完成 OAuth 交互后将凭据补丁合并进内存配置并重连。 */
  async authenticate(name: string): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const entry = this.requireEntry(name);
      const handler = this.options.oauthHandler;
      if (!handler) {
        throw new Error(`MCP server "${name}" 需要授权，但当前宿主未配置 OAuth handler`);
      }
      const credentials = await handler({
        name: entry.name,
        transport: entry.config.transport,
        ...(entry.config.url !== undefined ? { url: entry.config.url } : {}),
      });
      entry.config = {
        ...entry.config,
        ...(credentials.headers !== undefined
          ? { headers: { ...entry.config.headers, ...credentials.headers } }
          : {}),
        ...(credentials.env !== undefined
          ? { env: { ...entry.config.env, ...credentials.env } }
          : {}),
        enabled: true,
      };
      await this.closeEntryClient(entry);
      this.clearEntryTools(entry);
      entry.status = "pending";
      entry.error = undefined;
      this.emitSnapshot();
      await this.connectOne(entry);
    });
  }

  async listResources(name: string, cursor?: string): Promise<McpResourceListResult> {
    return this.callServer(name, (client) => client.listResources(cursor));
  }

  async readResource(name: string, uri: string): Promise<McpResourceReadResult> {
    return this.callServer(name, (client) => client.readResource(uri));
  }

  async listPrompts(name: string, cursor?: string): Promise<McpPromptListResult> {
    return this.callServer(name, (client) => client.listPrompts(cursor));
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<McpPromptGetResult> {
    return this.callServer(serverName, (client) => client.getPrompt(promptName, args));
  }

  /** 幂等关闭全部连接，保留配置以便后续 connectAll。 */
  async closeAll(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.closeEntries();
      logger.info(`[MCP] 所有 server 连接已关闭`);
    });
  }

  getStatus(): Map<string, McpServerStatus> {
    const result = new Map<string, McpServerStatus>();
    for (const entry of this.entries.values()) {
      result.set(entry.name, freezeServerStatus(entry));
    }
    return result;
  }

  getStatusSnapshot(): McpStatusSnapshot {
    const servers = Object.freeze([...this.entries.values()].map(freezeServerStatus));
    const summary = Object.freeze(summarizeServers(servers));
    return Object.freeze({
      ...(this.configPath !== undefined ? { configPath: this.configPath } : {}),
      ...(this.loadError !== undefined ? { loadError: this.loadError } : {}),
      servers,
      summary,
    });
  }

  getConnectedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "connected") count++;
    }
    return count;
  }

  private async loadConfigInternal(configPath: string): Promise<void> {
    const baseDir = this.options.stdioCwd ?? process.cwd();
    const absPath = isAbsolute(configPath) ? configPath : resolve(baseDir, configPath);
    this.configPath = absPath;
    this.loadError = undefined;
    this.emitSnapshot();
    let text: string;
    try {
      text = await readFile(absPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.loadError = `配置文件不存在: ${absPath}`;
        this.emitSnapshot();
        logger.warn({ path: absPath }, `[MCP] 配置文件不存在，跳过 MCP 加载`);
        return;
      }
      this.loadError = redactSensitiveText(
        `读取 MCP 配置失败: ${absPath}: ${(err as Error).message}`,
      );
      this.emitSnapshot();
      throw new Error(this.loadError, { cause: err });
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.loadError = `MCP 配置不是合法 JSON: ${absPath}`;
      this.emitSnapshot();
      throw new Error(this.loadError);
    }

    try {
      const config = this.validateConfig(data, absPath);
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        const disabled = serverConfig.enabled === false;
        this.entries.set(name, {
          name,
          config: { ...serverConfig, name },
          status: disabled ? "disabled" : "pending",
          tools: [],
          toolNames: [],
        });
      }
    } catch (err) {
      this.loadError = redactSensitiveText(err instanceof Error ? err.message : String(err));
      this.emitSnapshot();
      throw err;
    }
    this.emitSnapshot();
    logger.info(
      { count: this.entries.size },
      `[MCP] 已加载 ${this.entries.size} 个 server 配置(${absPath})`,
    );
  }

  private async connectAllInternal(): Promise<void> {
    const tasks = [...this.entries.values()]
      .filter((entry) => entry.status === "pending")
      .map((entry) => this.connectOne(entry));
    await Promise.allSettled(tasks);
    this.emitSnapshot();
    this.logSummary();
  }

  private async connectOne(entry: ServerEntry): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const client = this.createClient(entry.config);
    entry.client = client;
    entry.status = "pending";
    entry.error = undefined;
    this.attachLifecycle(entry, client);
    this.emitSnapshot();
    try {
      await this.withTimeout(client.connect(), timeoutMs, entry.name);
      const discovered = await this.withTimeout(client.listTools(), timeoutMs, entry.name);
      if (entry.client !== client) {
        await client.close().catch(() => {});
        return;
      }
      entry.tools = discovered.filter((tool) => {
        try {
          assertMcpInputSchema(tool.name, tool.inputSchema);
          return true;
        } catch (err) {
          logger.warn(
            { server: entry.name, tool: tool.name, err: safeErrorMessage(err) },
            `[MCP] 工具注册失败，已跳过`,
          );
          return false;
        }
      });
      entry.toolNames = entry.tools.map((tool) => tool.name);
      entry.status = "connected";
      this.registerEntryTools(entry);
      this.emitSnapshot();
      logger.info(
        { server: entry.name, tools: entry.tools.length },
        `[MCP] server "${entry.name}" 连接成功，发现 ${entry.tools.length} 个工具`,
      );
    } catch (err) {
      if (entry.client !== client) return;
      entry.client = undefined;
      await client.close().catch(() => {});
      this.clearEntryTools(entry);
      const message = safeErrorMessage(err);
      entry.status = isAuthenticationError(message) ? "needs_auth" : "failed";
      entry.error = message;
      this.emitSnapshot();
      logger.error(
        { server: entry.name, err: message },
        `[MCP] server "${entry.name}" 连接失败: ${message}`,
      );
    }
  }

  private async closeEntries(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map(async (entry) => {
        await this.closeEntryClient(entry);
        this.clearEntryTools(entry);
        entry.status = entry.config.enabled === false ? "disabled" : "pending";
        entry.error = undefined;
      }),
    );
    this.emitSnapshot();
  }

  private async closeEntryClient(entry: ServerEntry): Promise<void> {
    const client = entry.client;
    entry.client = undefined;
    if (client) await client.close().catch(() => {});
  }

  private clearEntryTools(entry: ServerEntry): void {
    this.unregisterEntryTools(entry);
    entry.tools = [];
    entry.toolNames = [];
  }

  private registerEntryTools(entry: ServerEntry): void {
    const registry = this.registry;
    const client = entry.client;
    if (!registry || !client || entry.status !== "connected") return;
    for (const tool of entry.tools) {
      registry.register(new McpToolBridge(client, entry.name, tool));
    }
  }

  private unregisterEntryTools(entry: ServerEntry, registry = this.registry): void {
    if (!registry) return;
    for (const toolName of entry.toolNames) {
      registry.unregister(qualifyMcpToolName(entry.name, toolName));
    }
  }

  private attachLifecycle(entry: ServerEntry, client: McpClient): void {
    const markFailed = (err?: Error) => {
      if (entry.client !== client || entry.status !== "connected") return;
      entry.client = undefined;
      this.clearEntryTools(entry);
      const message = safeErrorMessage(err ?? new Error(`MCP server "${entry.name}" 连接已关闭`));
      entry.status = isAuthenticationError(message) ? "needs_auth" : "failed";
      entry.error = message;
      this.emitSnapshot();
      logger.warn(
        { server: entry.name, err: message },
        `[MCP] server "${entry.name}" 连接断开: ${message}`,
      );
    };
    client.onClose?.(markFailed);
    client.onError?.(markFailed);
  }

  private async callServer<T>(
    name: string,
    operation: (client: McpClient) => Promise<T>,
  ): Promise<T> {
    const entry = this.requireEntry(name);
    if (entry.status !== "connected" || !entry.client) {
      throw new Error(`MCP server "${name}" 未连接(当前状态: ${entry.status})`);
    }
    try {
      return await operation(entry.client);
    } catch (err) {
      // method not found 只影响本次请求，不把整个 server 标记为失败。
      throw new Error(safeErrorMessage(err), { cause: err });
    }
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`未知 MCP server "${name}"`);
    return entry;
  }

  private createClient(config: McpServerConfig): McpClient {
    switch (config.transport) {
      case "stdio": {
        const merged =
          config.cwd === undefined && this.options.stdioCwd !== undefined
            ? { ...config, cwd: this.options.stdioCwd }
            : config;
        return new StdioMcpClient(merged);
      }
      case "http":
      case "sse":
        return new HttpMcpClient(config);
    }
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    serverName: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolvePromise, reject) => {
        timer = setTimeout(
          () => reject(new Error(`server "${serverName}" 启动超时(${timeoutMs}ms)`)),
          timeoutMs,
        );
        promise.then(resolvePromise, reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private validateConfig(data: unknown, source: string): McpConfig {
    if (typeof data !== "object" || data === null) {
      throw new Error(`MCP 配置 ${source} 根结构必须是对象`);
    }
    const raw = data as { mcpServers?: unknown };
    if (!raw.mcpServers || typeof raw.mcpServers !== "object") {
      throw new Error(`MCP 配置 ${source} 缺少 mcpServers 字段或非对象`);
    }
    const result: McpConfig = { mcpServers: {} };
    for (const [name, config] of Object.entries(raw.mcpServers as Record<string, unknown>)) {
      if (typeof config !== "object" || config === null) {
        throw new Error(`MCP 配置 ${source} 中 server "${name}" 必须是对象`);
      }
      const input = config as Partial<McpServerConfig>;
      const transport = input.transport ?? "stdio";
      if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
        throw new Error(`MCP server "${name}" 的 transport 必须是 stdio/http/sse`);
      }
      if (transport === "stdio" && !input.command) {
        throw new Error(`MCP server "${name}" 是 stdio 模式但缺少 command`);
      }
      if ((transport === "http" || transport === "sse") && !input.url) {
        throw new Error(`MCP server "${name}" 是 ${transport} 模式但缺少 url`);
      }
      result.mcpServers[name] = {
        name,
        transport,
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.startupTimeoutMs !== undefined
          ? { startupTimeoutMs: input.startupTimeoutMs }
          : {}),
        ...(input.toolTimeoutMs !== undefined ? { toolTimeoutMs: input.toolTimeoutMs } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      };
    }
    return result;
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getStatusSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn({ err: safeErrorMessage(err) }, `[MCP] 状态订阅者执行失败`);
      }
    }
  }

  private logSummary(): void {
    const summary = this.getStatusSnapshot().summary;
    logger.info(
      summary,
      `[MCP] 连接完成: ${summary.connected}/${summary.total} 成功, ${summary.failed} 失败, ${summary.needsAuth} 待授权, ${summary.disabled} 禁用`,
    );
  }
}

function freezeServerStatus(entry: ServerEntry): McpServerStatus {
  return Object.freeze({
    name: entry.name,
    transport: entry.config.transport,
    status: entry.status,
    toolCount: entry.toolNames.length,
    toolNames: Object.freeze([...entry.toolNames]),
    ...(entry.error !== undefined ? { error: redactSensitiveText(entry.error) } : {}),
  });
}

function summarizeServers(servers: readonly McpServerStatus[]): McpStatusSummary {
  let connected = 0;
  let failed = 0;
  let disabled = 0;
  let pending = 0;
  let needsAuth = 0;
  let toolCount = 0;
  for (const server of servers) {
    if (server.status === "connected") connected++;
    else if (server.status === "failed") failed++;
    else if (server.status === "disabled") disabled++;
    else if (server.status === "pending") pending++;
    else if (server.status === "needs_auth") needsAuth++;
    toolCount += server.toolCount;
  }
  return {
    total: servers.length,
    connected,
    failed,
    disabled,
    pending,
    needsAuth,
    toolCount,
  };
}

function safeErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function isAuthenticationError(message: string): boolean {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|needs?[ _-]?auth|authentication required)/i.test(
    message,
  );
}

export { DEFAULT_CONFIG_RELATIVE };
