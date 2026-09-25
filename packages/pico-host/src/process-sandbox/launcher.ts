import { spawn } from "node:child_process";
import { buildManagedSpawnPlan } from "./backend.js";
import { SandboxViolationError } from "./types.js";
import type {
  ManagedLaunchOptions,
  ManagedProcess,
  ManagedSpawnRequest,
  SandboxLease,
} from "./types.js";

export class ManagedProcessLauncher {
  private readonly activeWindowsNetwork = new Map<ChildProcessSandboxLease, string>();
  private readonly blockedWindowsNetworkTasks = new Set<string>();

  blockWindowsNetworkTask(controlRoot: string): void {
    this.blockedWindowsNetworkTasks.add(controlRoot);
  }

  unblockWindowsNetworkTask(controlRoot: string): void {
    this.blockedWindowsNetworkTasks.delete(controlRoot);
  }

  launch(request: ManagedSpawnRequest, options: ManagedLaunchOptions = {}): ManagedProcess {
    if (
      request.policy.windowsNetworkReceipt &&
      request.policy.windowsControlRoot &&
      this.blockedWindowsNetworkTasks.has(request.policy.windowsControlRoot)
    ) {
      throw new SandboxViolationError("sandbox_unavailable", "Windows 任务联网权限正在撤销。");
    }
    const plan = buildManagedSpawnPlan(request);
    const child = spawn(plan.command, plan.args, {
      ...options,
      cwd: request.cwd,
      env: plan.env,
    });
    const lease = new ChildProcessSandboxLease(child, request.policy, plan.backend);
    if (plan.backend === "windows-appcontainer" && request.policy.windowsNetworkReceipt) {
      this.activeWindowsNetwork.set(lease, request.policy.windowsNetworkReceipt);
      child.once("close", () => this.activeWindowsNetwork.delete(lease));
      child.once("error", () => this.activeWindowsNetwork.delete(lease));
    }
    return { child, lease, plan };
  }

  /** Revoke the task's active processes before removing its OS loopback exception. */
  async terminateWindowsNetworkProcesses(receiptDirectory: string): Promise<void> {
    const leases = [...this.activeWindowsNetwork]
      .filter(
        ([, path]) =>
          path.startsWith(`${receiptDirectory}\\`) || path.startsWith(`${receiptDirectory}/`),
      )
      .map(([lease]) => lease);
    await Promise.all(leases.map((lease) => lease.terminate()));
  }
}

class ChildProcessSandboxLease implements SandboxLease {
  released = false;
  private readonly settled: Promise<void>;

  constructor(
    private readonly child: ManagedProcess["child"],
    readonly policy: SandboxLease["policy"],
    readonly backend: SandboxLease["backend"],
  ) {
    this.settled = new Promise((resolve) => {
      child.once("close", resolve);
      child.once("error", resolve);
    });
    void this.settled.then(() => this.release());
  }

  async terminate(signal: NodeJS.Signals | number = "SIGTERM"): Promise<void> {
    if (this.released || this.child.exitCode !== null || this.child.signalCode !== null) {
      await this.release();
      return;
    }
    if (!this.child.kill(signal)) {
      throw new SandboxViolationError(
        "sandbox_cleanup_failed",
        "联网进程未确认终止，任务授权保持阻断。",
      );
    }
    await this.settled;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

export const managedProcessLauncher = new ManagedProcessLauncher();
