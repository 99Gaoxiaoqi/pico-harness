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
  /**
   * 宿主配置明确授权给目标进程的环境变量名。受限 profile 只继承安全系统变量，
   * 再从 env 恢复这些显式值；动态加载/启动注入变量即使列出也不会放行。
   */
  explicitEnvKeys?: readonly string[];
  origin: ManagedProcessOrigin;
  policy: SandboxPolicy;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** Windows Broker 的宿主控制/恢复目录；绝不能包含在目标进程读写根中。 */
  controlRoot?: string;
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
  readonly released: boolean;
  terminate(signal?: NodeJS.Signals | number): Promise<void>;
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
