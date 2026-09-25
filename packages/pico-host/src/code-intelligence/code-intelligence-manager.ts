import { StdioLspClient, type LspDiagnosticLogger } from "./lsp-client.js";
import {
  discoverLspServer,
  type LspServerConfig,
  type LspServerDiscoveryResult,
} from "./lsp-server-discovery.js";
import { LspCodeIntelligenceService } from "./lsp-service.js";
import { RepoMapService, type RepoMapSnapshot } from "./repo-map.js";
import { ReadOnlyCodeWorker } from "./worker-client.js";
import type { CodeIntelligenceService } from "./types.js";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  type SandboxConfig,
} from "@pico/pico-host/process-sandbox";

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
  readonly logger?: LspDiagnosticLogger;
  readonly processSandbox?: {
    bypass?: boolean;
    config?: Partial<SandboxConfig>;
    scratchRoot?: string;
    generation?: number;
    workspaceRoots?: readonly string[];
    readRoots?: readonly string[];
    readFiles?: readonly string[];
  };
}

/**
 * 代码智能生命周期入口。LSP 发现/启动任一失败都不阻断宿主，
 * 而是记录可诊断原因并切换到 Repo Map 后端。
 */
export class CodeIntelligenceManager {
  private client: StdioLspClient | undefined;
  private worker: ReadOnlyCodeWorker | undefined;
  private repoMapService: RepoMapService | ReadOnlyCodeWorker | undefined;
  private currentService: CodeIntelligenceService | undefined;
  private startPromise: Promise<CodeIntelligenceStatus> | undefined;
  private lspEnabled: boolean;
  private processSandbox: CodeIntelligenceManagerOptions["processSandbox"];
  private readonly serviceProxy: CodeIntelligenceService;
  private serviceGeneration: number | undefined;
  private lifecycleRevision = 0;
  private currentStatus: CodeIntelligenceStatus = {
    backend: "repo-map",
    reason: "代码智能尚未启动，使用 Repo Map",
  };

  constructor(private readonly options: CodeIntelligenceManagerOptions) {
    this.lspEnabled = options.lspEnabled !== false;
    this.processSandbox = options.processSandbox;
    const serviceProxy: CodeIntelligenceService & {
      snapshot(options?: {
        readonly query?: string;
        readonly maxFiles?: number;
        readonly signal?: AbortSignal;
      }): Promise<RepoMapSnapshot>;
    } = {
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
      snapshot: (options) => {
        this.requireService();
        return this.repoMap().snapshot(options);
      },
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
    const lifecycleRevision = this.lifecycleRevision;
    const managed = this.processSandbox?.bypass === false;
    let workspaceEntries: readonly string[] | undefined;
    if (managed) {
      const sandbox = this.processSandbox!;
      this.worker = new ReadOnlyCodeWorker({
        rootDir: this.options.rootDir,
        generation: sandbox.generation ?? 0,
        workspaceRoots: sandbox.workspaceRoots ?? [this.options.rootDir],
        ...(sandbox.readRoots ? { readRoots: sandbox.readRoots } : {}),
        ...(sandbox.readFiles ? { readFiles: sandbox.readFiles } : {}),
      });
      this.repoMapService = this.worker;
      try {
        await this.worker.start();
        workspaceEntries = await this.worker.rootEntries();
        if (this.lifecycleRevision !== lifecycleRevision) return this.currentStatus;
      } catch (error) {
        if (this.lifecycleRevision !== lifecycleRevision) return this.currentStatus;
        this.currentService = this.worker;
        this.serviceGeneration = sandbox.generation ?? 0;
        this.currentStatus = {
          backend: "repo-map",
          reason: `只读代码智能 Worker 不可用: ${errorMessage(error)}`,
        };
        return this.currentStatus;
      }
    }
    if (!this.lspEnabled) {
      return this.fallback({ source: "none", reason: "LSP 已由运行时策略禁用" });
    }
    const discovery = await discoverLspServer({
      rootDir: this.options.rootDir,
      ...(workspaceEntries ? { workspaceEntries } : {}),
      ...(this.options.lspServers ? { configuredServers: this.options.lspServers } : {}),
      ...(this.options.pathEnv !== undefined ? { pathEnv: this.options.pathEnv } : {}),
    });
    if (this.lifecycleRevision !== lifecycleRevision) return this.currentStatus;
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
        ...(this.processSandbox?.readRoots ? { readRoots: this.processSandbox.readRoots } : {}),
        ...(this.processSandbox?.readFiles ? { readFiles: this.processSandbox.readFiles } : {}),
        ...(this.processSandbox?.generation !== undefined
          ? { generation: this.processSandbox.generation }
          : {}),
      }),
      this.options.logger,
    );
    this.client = client;
    try {
      await client.start();
      if (this.lifecycleRevision !== lifecycleRevision) {
        await client.close();
        return this.currentStatus;
      }
      this.currentService = new LspCodeIntelligenceService(
        this.options.rootDir,
        client,
        this.worker ? (filePath) => this.worker!.readDocument(filePath) : undefined,
      );
      this.serviceGeneration = this.processSandbox?.generation ?? 0;
      this.currentStatus = {
        backend: "lsp",
        reason: discovery.reason,
        serverId: discovery.config.id,
      };
    } catch (error) {
      if (this.lifecycleRevision !== lifecycleRevision) return this.currentStatus;
      this.client = undefined;
      this.currentService = this.repoMap();
      this.serviceGeneration = this.processSandbox?.generation ?? 0;
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

  /** Explicit Repo Map owner used by the repo_map tool even while LSP is active. */
  repoMap(): RepoMapService | ReadOnlyCodeWorker {
    if (this.processSandbox?.bypass === false) {
      if (!this.worker) throw new Error("受限 Repo Map Worker 尚未就绪");
      return this.worker;
    }
    this.repoMapService ??= new RepoMapService(this.options.rootDir);
    return this.repoMapService;
  }

  /** The registry may expose managed reads only after this exact generation is attested. */
  canRunManagedReads(generation: number): boolean {
    return (
      this.processSandbox?.bypass === false &&
      this.processSandbox.generation === generation &&
      this.serviceGeneration === generation &&
      this.worker?.isReady() === true &&
      this.currentService !== undefined &&
      (this.currentService.backend !== "lsp" || this.client?.isReady() === true)
    );
  }

  async updateProcessSandbox(
    processSandbox: NonNullable<CodeIntelligenceManagerOptions["processSandbox"]>,
  ): Promise<CodeIntelligenceStatus> {
    if (
      this.processSandbox?.generation === processSandbox.generation &&
      this.processSandbox?.bypass === processSandbox.bypass
    )
      return this.currentStatus;
    await this.close();
    this.processSandbox = processSandbox;
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
    this.lifecycleRevision++;
    const service = this.currentService;
    const client = this.client;
    const worker = this.worker;
    const repoMap = this.repoMapService;
    this.currentService = undefined;
    this.client = undefined;
    this.worker = undefined;
    this.repoMapService = undefined;
    this.serviceGeneration = undefined;
    this.startPromise = undefined;
    await worker?.close();
    if (service && service !== worker) await service.close();
    else await client?.close();
    if (repoMap && repoMap !== service && repoMap !== worker) {
      await repoMap.close();
    }
  }

  private fallback(discovery: LspServerDiscoveryResult): CodeIntelligenceStatus {
    this.currentService = this.repoMap();
    this.serviceGeneration = this.processSandbox?.generation ?? 0;
    this.currentStatus = { backend: "repo-map", reason: discovery.reason };
    return this.currentStatus;
  }

  private requireService(): CodeIntelligenceService {
    if (!this.currentService) throw new Error("代码智能服务当前不可用");
    if (
      this.processSandbox?.bypass === false &&
      !this.canRunManagedReads(this.processSandbox.generation ?? 0)
    ) {
      throw new Error("受限代码智能 Worker 与当前任务边界不匹配或不可用");
    }
    return this.currentService;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
