// McpConnectionManager:管理所有 MCP server 连接的编排器。
//
// 职责:
//   1. 加载配置(从 .claw/mcp.json 或 --mcp-config 指定路径)
//   2. 并行连接所有 server,per-server 失败隔离(一个挂了不影响其他)
//   3. 自动把 server 暴露的工具注册到 ToolRegistry(名 mcp__<server>__<tool>)
//   4. 跟踪连接状态,供 UI/诊断查询
//   5. 优雅关闭:closeAll() 杀所有子进程/关连接
//
// 设计对标 kimi-code 的 McpConnectionManager,但简化:
//   - 不做 OAuth/needs-auth 流程
//   - 不做运行时重连(连接断了就标 failed,重启靠重新 connectAll)
//   - 状态机只有 pending → connected | failed | disabled

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { logger } from "../observability/logger.js";
import type { ToolRegistry } from "../tools/registry-impl.js";
import { StdioMcpClient } from "./stdio-client.js";
import { HttpMcpClient } from "./http-client.js";
import { McpToolBridge } from "./mcp-tool.js";
import {
  assertMcpInputSchema,
  qualifyMcpToolName,
  type McpClient,
  type McpConfig,
  type McpConnectionStatus,
  type McpServerConfig,
} from "./types.js";
import { redactSensitiveText } from "./redact.js";

/** 默认工作区相对配置路径 */
const DEFAULT_CONFIG_RELATIVE = ".claw/mcp.json";
/** 默认启动超时:npx 首次下载可能较慢 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

interface ServerEntry {
  name: string;
  config: McpServerConfig;
  status: McpConnectionStatus;
  client?: McpClient;
  toolCount: number;
  toolNames: string[];
  error?: string;
}

/** 给外部观测的 server 状态快照 */
export interface McpServerStatus {
  name: string;
  transport: string;
  status: McpConnectionStatus;
  toolCount: number;
  toolNames: readonly string[];
  error?: string;
}

export interface McpStatusSummary {
  total: number;
  connected: number;
  failed: number;
  disabled: number;
  pending: number;
  toolCount: number;
}

export interface McpStatusSnapshot {
  configPath?: string;
  loadError?: string;
  servers: readonly McpServerStatus[];
  summary: McpStatusSummary;
}

export interface McpConnectionManagerOptions {
  /** stdio 子进程的默认 cwd(解析相对 command 路径用) */
  stdioCwd?: string;
}

/**
 * McpConnectionManager:每个 CLI/HTTP 进程一个实例。
 *
 * 用法:
 *   const mgr = new McpConnectionManager(registry);
 *   await mgr.loadConfig(".claw/mcp.json");   // 或 --mcp-config 路径
 *   await mgr.connectAll();                    // 并行连接 + 自动注册工具
 *   // ... Agent 运行 ...
 *   await mgr.closeAll();                       // 退出时清理
 */
export class McpConnectionManager {
  private readonly entries = new Map<string, ServerEntry>();
  private configPath: string | undefined;
  private loadError: string | undefined;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: McpConnectionManagerOptions = {},
  ) {}

  /**
   * 加载 MCP 配置文件。
   * @param configPath 配置文件路径;若相对路径,锚定到 cwd
   */
  async loadConfig(configPath: string): Promise<void> {
    const baseDir = this.options.stdioCwd ?? process.cwd();
    const absPath = isAbsolute(configPath) ? configPath : resolve(baseDir, configPath);
    this.configPath = absPath;
    this.loadError = undefined;
    let text: string;
    try {
      text = await readFile(absPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.loadError = `配置文件不存在: ${absPath}`;
        logger.warn({ path: absPath }, `[MCP] 配置文件不存在: ${absPath},跳过 MCP 加载`);
        return;
      }
      this.loadError = `读取 MCP 配置失败: ${absPath}: ${(err as Error).message}`;
      throw new Error(this.loadError, { cause: err });
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.loadError = `MCP 配置不是合法 JSON: ${absPath}`;
      throw new Error(this.loadError);
    }

    let config: McpConfig;
    try {
      config = this.validateConfig(data, absPath);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      // 补全 name 字段(配置里 key 就是 server 名)
      serverConfig.name = name;
      const disabled = serverConfig.enabled === false;
      this.entries.set(name, {
        name,
        config: serverConfig,
        status: disabled ? "disabled" : "pending",
        toolCount: 0,
        toolNames: [],
      });
    }
    logger.info(
      { count: this.entries.size },
      `[MCP] 已加载 ${this.entries.size} 个 server 配置(${absPath})`,
    );
  }

  /**
   * 并行连接所有 pending 的 server,失败隔离。
   * 每个 server 独立 try/catch,一个失败不影响其他。
   * 成功的 server 自动把工具注册到 registry。
   */
  async connectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== "pending") continue;
      tasks.push(this.connectOne(entry));
    }
    await Promise.allSettled(tasks);
    this.logSummary();
  }

  /** 连接单个 server + 发现工具 + 注册到 registry */
  private async connectOne(entry: ServerEntry): Promise<void> {
    const timeoutMs = entry.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      const client = this.createClient(entry.config);
      entry.client = client;
      this.attachLifecycle(entry, client);
      // connect + listTools 在超时内完成,防子进程卡死
      await this.withTimeout(this.connectAndList(client), timeoutMs, entry.name);
      // 注:connectAndList 成功时已把工具注册,这里只更新状态
    } catch (err) {
      const msg = redactSensitiveText(err instanceof Error ? err.message : String(err));
      entry.status = "failed";
      entry.error = msg;
      entry.toolCount = 0;
      this.unregisterEntryTools(entry);
      // 失败时关掉 client,防句柄泄漏
      if (entry.client) {
        await entry.client.close().catch(() => {});
        entry.client = undefined;
      }
      logger.error(
        { server: entry.name, err: msg },
        `[MCP] server "${entry.name}" 连接失败: ${msg}`,
      );
    }
  }

  /** connect + listTools + 注册工具 */
  private async connectAndList(client: McpClient): Promise<void> {
    // 找到对应 entry(client 已被赋值到 entry 上)
    let entry: ServerEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.client === client) {
        entry = e;
        break;
      }
    }
    if (!entry) return;

    await client.connect();
    const tools = await client.listTools();
    const registeredToolNames: string[] = [];
    // 注册每个工具到 registry
    for (const tool of tools) {
      try {
        assertMcpInputSchema(tool.name, tool.inputSchema);
        const bridge = new McpToolBridge(client, entry.name, tool);
        this.registry.register(bridge);
        registeredToolNames.push(tool.name);
      } catch (err) {
        // 单个工具注册失败(inputSchema 非法等)不影响其他工具
        logger.warn(
          {
            server: entry.name,
            tool: tool.name,
            err: err instanceof Error ? err.message : String(err),
          },
          `[MCP] 工具注册失败,已跳过`,
        );
      }
    }
    entry.status = "connected";
    entry.toolCount = registeredToolNames.length;
    entry.toolNames = registeredToolNames;
    entry.error = undefined;
    logger.info(
      { server: entry.name, tools: registeredToolNames.length },
      `[MCP] server "${entry.name}" 连接成功,注册 ${registeredToolNames.length} 个工具`,
    );
  }

  /** 关闭所有连接(进程退出时调用) */
  async closeAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    const closingEntries: ServerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.client) {
        const client = entry.client;
        entry.client = undefined;
        closingEntries.push(entry);
        tasks.push(client.close().catch(() => {}));
      }
    }
    await Promise.allSettled(tasks);
    for (const entry of closingEntries) {
      if (entry.status === "connected") {
        entry.status = "pending";
        entry.toolCount = 0;
        this.unregisterEntryTools(entry);
        entry.error = undefined;
      }
    }
    logger.info(`[MCP] 所有 server 连接已关闭`);
  }

  /** 返回所有 server 的状态快照(诊断/UI 用) */
  getStatus(): Map<string, McpServerStatus> {
    const result = new Map<string, McpServerStatus>();
    for (const entry of this.entries.values()) {
      result.set(entry.name, {
        name: entry.name,
        transport: entry.config.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        toolNames: [...entry.toolNames],
        error: entry.error,
      });
    }
    return result;
  }

  /** 返回完整状态快照(TUI/诊断用) */
  getStatusSnapshot(): McpStatusSnapshot {
    const servers = [...this.getStatus().values()];
    const summary = summarizeServers(servers);
    return {
      ...(this.configPath !== undefined ? { configPath: this.configPath } : {}),
      ...(this.loadError !== undefined ? { loadError: this.loadError } : {}),
      servers,
      summary,
    };
  }

  /** 已连接 server 数(成功 + 失败 + 禁用 = 总数) */
  getConnectedCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "connected") count++;
    }
    return count;
  }

  /** 根据 transport 创建对应 client */
  private createClient(config: McpServerConfig): McpClient {
    switch (config.transport) {
      case "stdio": {
        // 若 config 未指定 cwd 且 options 提供了 stdioCwd,用它锚定子进程工作目录
        const stdioCwd = this.options.stdioCwd;
        const merged =
          config.cwd === undefined && stdioCwd !== undefined
            ? { ...config, cwd: stdioCwd }
            : config;
        return new StdioMcpClient(merged);
      }
      case "http":
      case "sse":
        return new HttpMcpClient(config);
      default:
        throw new Error(
          `MCP server "${config.name}" 不支持的 transport: ${(config as { transport: string }).transport}`,
        );
    }
  }

  /** 带超时执行 Promise */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    serverName: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`server "${serverName}" 启动超时(${timeoutMs}ms)`));
        }, timeoutMs);
        promise.then(resolve, reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 校验配置结构,补全 transport 默认值 */
  private validateConfig(data: unknown, source: string): McpConfig {
    if (typeof data !== "object" || data === null) {
      throw new Error(`MCP 配置 ${source} 根结构必须是对象`);
    }
    const raw = data as { mcpServers?: unknown };
    if (!raw.mcpServers || typeof raw.mcpServers !== "object") {
      throw new Error(`MCP 配置 ${source} 缺少 mcpServers 字段或非对象`);
    }
    const servers = raw.mcpServers as Record<string, unknown>;
    const result: McpConfig = { mcpServers: {} };
    for (const [name, cfg] of Object.entries(servers)) {
      if (typeof cfg !== "object" || cfg === null) {
        throw new Error(`MCP 配置 ${source} 中 server "${name}" 必须是对象`);
      }
      const serverCfg = cfg as Partial<McpServerConfig>;
      const transport = serverCfg.transport ?? "stdio";
      if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
        throw new Error(`MCP server "${name}" 的 transport 必须是 stdio/http/sse`);
      }
      if (transport === "stdio" && !serverCfg.command) {
        throw new Error(`MCP server "${name}" 是 stdio 模式但缺少 command`);
      }
      if ((transport === "http" || transport === "sse") && !serverCfg.url) {
        throw new Error(`MCP server "${name}" 是 ${transport} 模式但缺少 url`);
      }
      result.mcpServers[name] = {
        name,
        transport,
        ...(serverCfg.command !== undefined ? { command: serverCfg.command } : {}),
        ...(serverCfg.args !== undefined ? { args: serverCfg.args } : {}),
        ...(serverCfg.url !== undefined ? { url: serverCfg.url } : {}),
        ...(serverCfg.env !== undefined ? { env: serverCfg.env } : {}),
        ...(serverCfg.cwd !== undefined ? { cwd: serverCfg.cwd } : {}),
        ...(serverCfg.headers !== undefined ? { headers: serverCfg.headers } : {}),
        ...(serverCfg.startupTimeoutMs !== undefined
          ? { startupTimeoutMs: serverCfg.startupTimeoutMs }
          : {}),
        ...(serverCfg.toolTimeoutMs !== undefined
          ? { toolTimeoutMs: serverCfg.toolTimeoutMs }
          : {}),
        ...(serverCfg.enabled !== undefined ? { enabled: serverCfg.enabled } : {}),
      };
    }
    return result;
  }

  private logSummary(): void {
    let connected = 0;
    let failed = 0;
    let disabled = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "connected") connected++;
      else if (entry.status === "failed") failed++;
      else if (entry.status === "disabled") disabled++;
    }
    const total = this.entries.size;
    logger.info(
      { total, connected, failed, disabled },
      `[MCP] 连接完成: ${connected}/${total} 成功, ${failed} 失败, ${disabled} 禁用`,
    );
  }

  private attachLifecycle(entry: ServerEntry, client: McpClient): void {
    const markFailed = (err?: Error) => {
      if (entry.status !== "connected") return;
      const msg = redactSensitiveText(err?.message ?? `MCP server "${entry.name}" 连接已关闭`);
      entry.status = "failed";
      entry.error = msg;
      entry.toolCount = 0;
      entry.client = undefined;
      this.unregisterEntryTools(entry);
      logger.warn(
        { server: entry.name, err: msg },
        `[MCP] server "${entry.name}" 连接断开: ${msg}`,
      );
    };
    client.onClose?.(markFailed);
    client.onError?.(markFailed);
  }

  private unregisterEntryTools(entry: ServerEntry): void {
    for (const toolName of entry.toolNames) {
      this.registry.unregister(qualifyMcpToolName(entry.name, toolName));
    }
    entry.toolNames = [];
  }
}

function summarizeServers(servers: readonly McpServerStatus[]): McpStatusSummary {
  let connected = 0;
  let failed = 0;
  let disabled = 0;
  let pending = 0;
  let toolCount = 0;

  for (const server of servers) {
    if (server.status === "connected") connected++;
    else if (server.status === "failed") failed++;
    else if (server.status === "disabled") disabled++;
    else if (server.status === "pending") pending++;
    toolCount += server.toolCount;
  }

  return {
    total: servers.length,
    connected,
    failed,
    disabled,
    pending,
    toolCount,
  };
}

/** 默认配置文件相对路径(.claw/mcp.json) */
export { DEFAULT_CONFIG_RELATIVE };
