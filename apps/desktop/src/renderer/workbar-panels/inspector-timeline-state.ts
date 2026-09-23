import type { RuntimeExecutionPage, RuntimeExecutionRun } from "@pico/protocol";

/** Only complete, covered runs without a reason may join the quiet empty group. */
export function partitionTimelineRuns(execution: RuntimeExecutionPage) {
  const gaps = new Set([
    ...execution.coverage.oversizedRunIds,
    ...execution.coverage.missingModelCallRunIds,
    ...execution.coverage.incompleteRunIds,
  ]);
  const visible: RuntimeExecutionRun[] = [];
  const empty: RuntimeExecutionRun[] = [];
  for (const run of execution.runs) {
    (run.status === "completed" && !run.reason && run.steps.length === 0 && !gaps.has(run.runId)
      ? empty
      : visible
    ).push(run);
  }
  return { visible, empty };
}
