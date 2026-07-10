import type { Reporter, TestRunEndReason } from "vitest/reporters";
import type { TestCase } from "vitest/node";

const SENTINEL = "[real-llm-gate]";

/** Prevent filtered/misconfigured runs from reporting green after executing zero model tests. */
export default class RealLlmExecutionReporter implements Reporter {
  private executedSentinels = 0;

  onTestCaseResult(testCase: TestCase): void {
    if (testCase.fullName.includes(SENTINEL) && testCase.result().state !== "skipped") {
      this.executedSentinels += 1;
    }
  }

  onTestRunEnd(_modules: unknown, _errors: unknown, reason: TestRunEndReason): void {
    if (reason === "passed" && this.executedSentinels === 0) {
      throw new Error(
        `Real LLM E2E executed zero sentinel tests. Ensure ${SENTINEL} is included and not filtered.`,
      );
    }
  }
}
