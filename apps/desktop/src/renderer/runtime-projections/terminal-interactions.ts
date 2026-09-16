import { isTerminalRunStatus } from "@pico/protocol";
import type { AppData, RunView } from "../model.js";

/** Remember observed terminal runs even if later snapshots omit them or fail. */
export class TerminalInteractions {
  private readonly runs = new Map<string, Set<string>>();

  record(runs: readonly RunView[]): void {
    for (const run of runs) {
      if (!isTerminalRunStatus(run.status)) continue;
      const ids = this.runs.get(run.workspacePath) ?? new Set<string>();
      ids.add(run.id);
      this.runs.set(run.workspacePath, ids);
    }
  }

  has(workspacePath: string, runId: string): boolean {
    return this.runs.get(workspacePath)?.has(runId) ?? false;
  }

  reconcile(data: AppData): AppData {
    const ids = data.workspacePath ? this.runs.get(data.workspacePath) : undefined;
    if (!ids?.size) return data;
    return {
      ...data,
      approvals: data.approvals.filter((item) => item.kind === "plan" || !ids.has(item.runId)),
      prompts: data.prompts.filter((item) => !ids.has(item.runId)),
    };
  }
}
