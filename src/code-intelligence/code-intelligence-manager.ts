import { StdioLspClient } from "./lsp-client.js";
import {
  discoverLspServer,
  type LspServerConfig,
  type LspServerDiscoveryResult,
} from "./lsp-server-discovery.js";
import { LspCodeIntelligenceService } from "./lsp-service.js";
import { RepoMapService } from "./repo-map.js";
import type { CodeIntelligenceService } from "./types.js";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  type SandboxConfig,
} from "../safety/process-sandbox/index.js";

export type CodeIntelligenceBackend = "lsp" | "repo-map";

export interface CodeIntelligenceStatus {
  readonly backend: CodeIntelligenceBackend;
  readonly reason: string;
  readonly serverId?: string;
}

export interface CodeIntelligenceManagerOptions {
  readonly rootDir: string;
  /** Explicit process boundary for background/Plan runtimes; false skips discovery and spawn. */
  readonly lspEnabled?: boolean;
  readonly lspServers?: readonly LspServerConfig[];
  readonly pathEnv?: string;
  readonly processSandbox?: {
    config?: Partial<SandboxConfig>;
    scratchRoot?: string;
    generation?: number;
    workspaceRoots?: readonly string[];
  };
}

/**
 * 代码智能生命周期入口。LSP 发现/启动任一失败都不阻断宿主，
 * 而是记录可诊断原因并切换到 Repo Map 后端。
 */
export class CodeIntelligenceManager {
  private client: StdioLspClient | undefined;
  private currentService: CodeIntelligenceService | undefined;
  private startPromise: Promise<CodeIntelligenceStatus> | undefined;
  private lspEnabled: boolean;
  private processSandbox: CodeIntelligenceManagerOptions["processSandbox"];
  private readonly serviceProxy: CodeIntelligenceService;
  private currentStatus: CodeIntelligenceStatus = {
    backend: "repo-map",
    reason: "代码智能尚未启动，使用 Repo Map",
  };

  constructor(private readonly options: CodeIntelligenceManagerOptions) {
    this.lspEnabled = options.lspEnabled !== false;
    this.processSandbox = options.processSandbox;
    const serviceProxy: CodeIntelligenceService = {
      backend: "repo-map",
      definitions: (query, requestOptions) =>
        this.requireService().definitions(query, requestOptions),
      references: (query, requestOptions) =>
        this.requireService().references(query, requestOptions),
      symbols: (query, requestOptions) => this.requireService().symbols(query, requestOptions),
      diagnostics: (filePath, requestOptions) =>
        this.requireService().diagnostics(filePath, requestOptions),
      callHierarchy: (query, direction, requestOptions) =>
        this.requireService().callHierarchy(query, direction, requestOptions),
      close: async () => undefined,
    };
    Object.defineProperty(serviceProxy, "backend", {
      enumerable: true,
      get: () => this.requireService().backend,
    });
    this.serviceProxy = serviceProxy;
  }

  start(): Promise<CodeIntelligenceStatus> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<CodeIntelligenceStatus> {
    if (!this.lspEnabled) {
      return this.fallback({ source: "none", reason: "LSP 已由运行时策略禁用" });
    }
    const discovery = await discoverLspServer({
      rootDir: this.options.rootDir,
      ...(this.options.lspServers ? { configuredServers: this.options.lspServers } : {}),
      ...(this.options.pathEnv !== undefined ? { pathEnv: this.options.pathEnv } : {}),
    });
    if (!discovery.config) return this.fallback(discovery);

    const client = new StdioLspClient(
      this.options.rootDir,
      discovery.config,
      createSandboxPolicy({
        profile: "read-only",
        workspaceRoots: this.processSandbox?.workspaceRoots ?? [this.options.rootDir],
        scratchRoot:
          this.processSandbox?.scratchRoot ?? defaultSandboxScratchRoot(this.options.rootDir),
        ...(this.processSandbox?.config ? { config: this.processSandbox.config } : {}),
        ...(this.processSandbox?.generation !== undefined
          ? { generation: this.processSandbox.generation }
          : {}),
      }),
    );
    try {
      await client.start();
      this.client = client;
      this.currentService = new LspCodeIntelligenceService(this.options.rootDir, client);
      this.currentStatus = {
        backend: "lsp",
        reason: discovery.reason,
        serverId: discovery.config.id,
      };
    } catch (error) {
      this.client = undefined;
      this.currentService = new RepoMapService(this.options.rootDir);
      this.currentStatus = {
        backend: "repo-map",
        reason: `LSP server ${discovery.config.id} 启动失败，已降级为 Repo Map: ${errorMessage(error)}`,
      };
    }
    return this.currentStatus;
  }

  status(): CodeIntelligenceStatus {
    return this.currentStatus;
  }

  lspClient(): StdioLspClient | undefined {
    return this.client?.isReady() ? this.client : undefined;
  }

  service(): CodeIntelligenceService | undefined {
    return this.currentService ? this.serviceProxy : undefined;
  }

  async updateProcessSandbox(
    processSandbox: NonNullable<CodeIntelligenceManagerOptions["processSandbox"]>,
  ): Promise<CodeIntelligenceStatus> {
    if (this.processSandbox?.generation === processSandbox.generation) return this.currentStatus;
    this.processSandbox = processSandbox;
    await this.close();
    return await this.start();
  }

  /** Switch process policy while retaining a safe Repo Map service when LSP is disabled. */
  async setLspEnabled(enabled: boolean): Promise<CodeIntelligenceStatus> {
    if (enabled === this.lspEnabled && this.currentService) return this.currentStatus;
    await this.close();
    this.lspEnabled = enabled;
    return await this.start();
  }

  async close(): Promise<void> {
    if (this.currentService) await this.currentService.close();
    else await this.client?.close();
    this.currentService = undefined;
    this.client = undefined;
    this.startPromise = undefined;
  }

  private fallback(discovery: LspServerDiscoveryResult): CodeIntelligenceStatus {
    this.currentService = new RepoMapService(this.options.rootDir);
    this.currentStatus = { backend: "repo-map", reason: discovery.reason };
    return this.currentStatus;
  }

  private requireService(): CodeIntelligenceService {
    if (!this.currentService) throw new Error("代码智能服务当前不可用");
    return this.currentService;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
