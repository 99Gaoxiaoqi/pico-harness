import type { ChildProcess, SpawnOptions } from "node:child_process";

export type SandboxProfile = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxNetworkPolicy = "deny" | "allow";
export type ManagedProcessOrigin =
  | "bash"
  | "background-bash"
  | "stdio-mcp"
  | "command-hook"
  | "lsp"
  | "grep"
  | "subagent";

export type SandboxBackend =
  | "none"
  | "macos-seatbelt"
  | "linux-bubblewrap"
  | "windows-appcontainer"
  | "unavailable";

export interface SandboxConfig {
  /** workspace-write 的网络策略；read-only 固定拒绝，danger-full-access 不读取。 */
  network: SandboxNetworkPolicy;
}

export const DEFAULT_SANDBOX_CONFIG: Readonly<SandboxConfig> = Object.freeze({
  network: "allow",
});

export interface SandboxPolicy {
  profile: SandboxProfile;
  network: SandboxNetworkPolicy;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  scratchRoot: string;
  generation: number;
}

export interface ManagedSpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  origin: ManagedProcessOrigin;
  policy: SandboxPolicy;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** 仅测试与可信宿主可注入；项目配置和模型输入不得控制。 */
  backendExecutable?: string;
}

export interface SandboxSpawnPlan {
  backend: SandboxBackend;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  profile: SandboxProfile;
}

export interface ManagedProcess {
  child: ChildProcess;
  lease: SandboxLease;
  plan: SandboxSpawnPlan;
}

export interface SandboxLease {
  readonly policy: SandboxPolicy;
  readonly backend: SandboxBackend;
  release(): Promise<void>;
}

export interface ManagedLaunchOptions extends Omit<SpawnOptions, "cwd" | "env"> {
  cwd?: never;
  env?: never;
}

export type SandboxViolationCode =
  | "sandbox_unavailable"
  | "policy_compilation_failed"
  | "workspace_write_denied"
  | "network_denied"
  | "sandbox_runtime_denied"
  | "sandbox_cleanup_failed";

export class SandboxViolationError extends Error {
  override readonly name = "SandboxViolationError";

  constructor(
    readonly code: SandboxViolationCode,
    message: string,
  ) {
    super(`[sandbox:${code}] ${message}`);
  }
}
