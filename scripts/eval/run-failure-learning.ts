import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runRealFailureLearningExperiment } from "./failure-learning-real-model.js";

if (process.argv.length !== 2)
  throw new Error(
    "Usage: node --import tsx --import @pico/cli/tui/preload-env scripts/eval/run-failure-learning.ts",
  );
await mkdir(resolve("output"), { recursive: true });
const directory = resolve("output", `failure-learning-${randomUUID()}`);
const report = await runRealFailureLearningExperiment(directory);
process.stdout.write(
  JSON.stringify(
    {
      status: report.status,
      model: report.model,
      report: resolve(directory, "report.json"),
      modelCalls: report.modelCalls,
      trials: report.trials.map(({ step, cwd, exitCode, passed }) => ({
        step,
        cwd,
        exitCode,
        passed,
      })),
      memoryDelivered: report.memoryDelivered,
      scopeIsolated: report.scopeIsolated,
    },
    null,
    2,
  ) + "\n",
);
if (report.status !== "learned") process.exitCode = 1;
