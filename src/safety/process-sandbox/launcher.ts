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
    const lease: SandboxLease = {
      policy: request.policy,
      backend: plan.backend,
      async release() {},
    };
    return { child, lease, plan };
  }
}
