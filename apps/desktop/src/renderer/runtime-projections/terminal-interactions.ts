import { isActiveRunStatus, isTerminalRunStatus } from "@pico/protocol";
import type { AppData, RunView } from "../model.js";

/** Missing snapshots do not settle runs; newer active revisions may recover failed runs. */
export class TerminalInteractions {
  private readonly runs = new Map<string, Map<string, RunView>>();

  record(runs: readonly RunView[]): void {
    for (const run of runs) {
      if (!isTerminalRunStatus(run.status) && !isActiveRunStatus(run.status)) continue;
      const workspaceRuns = this.runs.get(run.workspacePath) ?? new Map<string, RunView>();
      const previous = workspaceRuns.get(run.id);
      if (previous) {
        const newer =
          run.version !== undefined && previous.version !== undefined
            ? run.version > previous.version
            : run.updatedAt > previous.updatedAt;
        if (!newer) continue;
      }
      workspaceRuns.set(run.id, run);
      this.runs.set(run.workspacePath, workspaceRuns);
    }
  }

  has(workspacePath: string, runId: string): boolean {
    const run = this.runs.get(workspacePath)?.get(runId);
    return !!run && isTerminalRunStatus(run.status);
  }

  reconcile(data: AppData): AppData {
    const workspacePath = data.workspacePath;
    if (!workspacePath) return data;
    return {
      ...data,
      approvals: data.approvals.filter(
        (item) => item.kind === "plan" || !this.has(workspacePath, item.runId),
      ),
      prompts: data.prompts.filter((item) => !this.has(workspacePath, item.runId)),
    };
  }
}
