import type { WorkspaceTrustPrompt } from "@pico/core/workspace-trust-contract";
import { WorkspaceTrustStore as StorageWorkspaceTrustStore } from "@pico/storage/workspace-trust-store";
import { resolvePicoHome } from "./pico-paths.js";

export type {
  WorkspaceTrustDecision,
  WorkspaceTrustPrompt,
  WorkspaceTrustPromptRequest,
} from "@pico/core/workspace-trust-contract";

export const WORKSPACE_TRUST_RISKS = Object.freeze([
  "读取 AGENTS.md 以及项目 Skills，并把它们作为 Agent 指令",
  "启动 .pico/config.json 配置的 LSP 进程",
  "启动项目配置的 MCP 服务与 Hook 命令",
  "使用项目配置的额外工作区目录",
] as const);

export interface WorkspaceTrustStoreOptions {
  /** Omitted in production to use the Host-controlled PICO_HOME. */
  readonly userStateDirectory?: string;
  readonly now?: () => Date;
}

/** Host adapter that supplies the product-owned default user state directory. */
export class WorkspaceTrustStore extends StorageWorkspaceTrustStore {
  constructor(options: WorkspaceTrustStoreOptions = {}) {
    super({
      userStateDirectory: options.userStateDirectory ?? resolvePicoHome(),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
}

export interface EnsureWorkspaceTrustedOptions {
  readonly store?: WorkspaceTrustStore;
  /** Missing interactive UI must fail closed rather than auto-trust a project. */
  readonly prompt?: WorkspaceTrustPrompt;
}

export type WorkspaceTrustResult =
  | { readonly status: "already-trusted"; readonly workspacePath: string }
  | { readonly status: "trusted-now"; readonly workspacePath: string };

/** Run before any project-level configuration, instructions, or executable hooks are read. */
export async function ensureWorkspaceTrusted(
  workspacePath: string,
  options: EnsureWorkspaceTrustedOptions = {},
): Promise<WorkspaceTrustResult> {
  const store = options.store ?? new WorkspaceTrustStore();
  const canonicalWorkspacePath = await store.canonicalize(workspacePath);
  if (await store.isTrusted(canonicalWorkspacePath)) {
    return { status: "already-trusted", workspacePath: canonicalWorkspacePath };
  }

  if (!options.prompt) {
    throw new Error(
      `工作区尚未信任: ${canonicalWorkspacePath}。非交互环境不会自动信任项目；请先在交互式终端运行 pico 并确认工作区信任。`,
    );
  }

  const decision = await options.prompt.requestTrust({
    workspacePath: canonicalWorkspacePath,
    risks: WORKSPACE_TRUST_RISKS,
  });
  if (decision !== "trust") {
    throw new Error(`已取消启动：工作区未被信任 (${canonicalWorkspacePath})`);
  }

  await store.trust(canonicalWorkspacePath);
  return { status: "trusted-now", workspacePath: canonicalWorkspacePath };
}
