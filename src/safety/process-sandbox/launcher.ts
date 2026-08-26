import { spawn } from "node:child_process";
import { buildManagedSpawnPlan } from "./backend.js";
import type {
  ManagedLaunchOptions,
  ManagedProcess,
  ManagedSpawnRequest,
  SandboxLease,
} from "./types.js";

export class ManagedProcessLauncher {
  launch(request: ManagedSpawnRequest, options: ManagedLaunchOptions = {}): ManagedProcess {
    const plan = buildManagedSpawnPlan(request);
    const child = spawn(plan.command, plan.args, {
      ...options,
      cwd: request.cwd,
      env: plan.env,
    });
    const lease = new ChildProcessSandboxLease(child, request.policy, plan.backend);
    return { child, lease, plan };
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
    if (!this.child.kill(signal)) return;
    await this.settled;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

export const managedProcessLauncher = new ManagedProcessLauncher();
