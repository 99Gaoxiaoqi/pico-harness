import {
  HostBackgroundTaskManager,
  type BackgroundChildProcess,
  type BackgroundTaskManagerOptions as HostBackgroundTaskManagerOptions,
} from "./background-task-manager.js";
import {
  isWindows,
  resolveShell,
  sanitizeShellProcessEnvironment,
  shellCommandArgs,
} from "@pico/runtime/host-shell";
import { signalProcessTree } from "@pico/runtime/process-tree";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  managedProcessLauncher,
  type ManagedSpawnRequest,
} from "./process-sandbox/index.js";

export type {
  BackgroundTaskOutput,
  BackgroundTaskRecord,
  BackgroundTaskStatus,
} from "@pico/pico-host/background-task-manager";

export interface BackgroundTaskSpawnOptions {
  /** 可信宿主生成的实际执行文件与参数，任务记录仍保留原始 command。 */
  request?: ManagedSpawnRequest;
  /** 可信宿主为隔离子进程注入的最小环境。 */
  env?: NodeJS.ProcessEnv;
}

export type BackgroundManagerOptions = Omit<
  HostBackgroundTaskManagerOptions<BackgroundTaskSpawnOptions>,
  "launch" | "signalProcessTree"
>;

/** @deprecated 后台任务生命周期已迁至 Pico Host；此类仅绑定本机 Shell/Sandbox 适配。 */
export class BackgroundManager extends HostBackgroundTaskManager<BackgroundTaskSpawnOptions> {
  constructor(options: BackgroundManagerOptions = {}) {
    super({
      ...options,
      launch: (command, cwd, spawnOptions) => {
        const shell = resolveShell();
        return managedProcessLauncher.launch(
          spawnOptions?.request ?? {
            command: shell,
            args: shellCommandArgs(shell, command),
            cwd,
            env: sanitizeShellProcessEnvironment(spawnOptions?.env ?? process.env),
            origin: "background-bash",
            policy: createSandboxPolicy({
              profile: "danger-full-access",
              workspaceRoots: [cwd],
              scratchRoot: defaultSandboxScratchRoot(cwd),
            }),
          },
          {
            detached: !isWindows,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ).child as BackgroundChildProcess;
      },
      signalProcessTree,
    });
  }
}
