import { StdioLspClient } from "./lsp-client.js";
import {
  discoverLspServer,
  type LspServerConfig,
  type LspServerDiscoveryResult,
} from "./lsp-server-discovery.js";

export type CodeIntelligenceBackend = "lsp" | "repo-map";

export interface CodeIntelligenceStatus {
  readonly backend: CodeIntelligenceBackend;
  readonly reason: string;
  readonly serverId?: string;
}

export interface CodeIntelligenceManagerOptions {
  readonly rootDir: string;
  readonly lspServers?: readonly LspServerConfig[];
  readonly pathEnv?: string;
}

/**
 * 代码智能生命周期入口。LSP 发现/启动任一失败都不阻断宿主，
 * 而是记录可诊断原因并切换到 Repo Map 后端。
 */
export class CodeIntelligenceManager {
  private client: StdioLspClient | undefined;
  private currentStatus: CodeIntelligenceStatus = {
    backend: "repo-map",
    reason: "代码智能尚未启动，使用 Repo Map",
  };

  constructor(private readonly options: CodeIntelligenceManagerOptions) {}

  async start(): Promise<CodeIntelligenceStatus> {
    const discovery = await discoverLspServer({
      rootDir: this.options.rootDir,
      ...(this.options.lspServers ? { configuredServers: this.options.lspServers } : {}),
      ...(this.options.pathEnv !== undefined ? { pathEnv: this.options.pathEnv } : {}),
    });
    if (!discovery.config) return this.fallback(discovery);

    const client = new StdioLspClient(this.options.rootDir, discovery.config);
    try {
      await client.start();
      this.client = client;
      this.currentStatus = {
        backend: "lsp",
        reason: discovery.reason,
        serverId: discovery.config.id,
      };
    } catch (error) {
      this.client = undefined;
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

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private fallback(discovery: LspServerDiscoveryResult): CodeIntelligenceStatus {
    this.currentStatus = { backend: "repo-map", reason: discovery.reason };
    return this.currentStatus;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
