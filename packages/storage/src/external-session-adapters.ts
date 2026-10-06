import {
  ExternalSessionNotFoundError,
  EXTERNAL_SESSION_ADAPTER_IDS,
  type ExternalSessionAdapter,
  type ExternalSessionAdapterId,
  type ExternalSessionPage,
  type ExternalSessionPageQuery,
  type ExternalSessionSnapshot,
} from "./external-sessions.js";
import { ClaudeCodeSessionAdapter } from "./claude-code-session-adapter.js";
import { CodexSessionAdapter } from "./codex-session-adapter.js";
import { OpenCodeSessionAdapter } from "./opencode-session-adapter.js";

export { ClaudeCodeSessionAdapter, CodexSessionAdapter, OpenCodeSessionAdapter };

export interface ExternalSessionSource {
  readonly id: ExternalSessionAdapterId;
  readonly name: string;
  readonly available: boolean;
}

export class ExternalSessionAdapterRegistry {
  private readonly adapters: ReadonlyMap<ExternalSessionAdapterId, ExternalSessionAdapter>;

  constructor(adapters: readonly ExternalSessionAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  async listSources(): Promise<readonly ExternalSessionSource[]> {
    return Promise.all(
      EXTERNAL_SESSION_ADAPTER_IDS.map(async (id) => {
        const adapter = this.adapters.get(id);
        if (!adapter) return { id, name: id, available: false };
        try {
          return { id, name: adapter.name, available: await adapter.detect() };
        } catch {
          return { id, name: adapter.name, available: false };
        }
      }),
    );
  }

  async listPage(
    adapterId: ExternalSessionAdapterId,
    query: ExternalSessionPageQuery,
  ): Promise<ExternalSessionPage> {
    return this.require(adapterId).listPage(query);
  }

  async readSession(
    adapterId: ExternalSessionAdapterId,
    sessionId: string,
  ): Promise<ExternalSessionSnapshot> {
    return this.require(adapterId).readSession(sessionId);
  }

  private require(adapterId: ExternalSessionAdapterId): ExternalSessionAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new ExternalSessionNotFoundError();
    return adapter;
  }
}

export function createExternalSessionAdapterRegistry(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([
    new CodexSessionAdapter(env["CODEX_HOME"]),
    new ClaudeCodeSessionAdapter(env["CLAUDE_CONFIG_DIR"] ?? env["CLAUDE_HOME"]),
    new OpenCodeSessionAdapter(env["OPENCODE_DB_PATH"]),
  ]);
}
