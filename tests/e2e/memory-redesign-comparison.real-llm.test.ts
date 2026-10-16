import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const enabled = process.env.RUN_LLM_E2E === "1" && process.env.RUN_MEMORY_COMPARISON === "1";
const runTest = enabled ? test : test.skip;

runTest(
  "frozen v15/new/off production Runtime comparison has 36 isolated real-model runs",
  { timeout: 60 * 60_000 },
  async (t) => {
    const current = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const baseline = process.env.PICO_MEMORY_BASELINE_ROOT;
    assert.ok(baseline, "comparison requires the separate frozen v15 checkout");
    const root =
      process.env.PICO_MEMORY_VALIDATION_DIR ??
      (await mkdtemp(join(tmpdir(), "pico-memory-comparison-")));
    await mkdir(root, { recursive: true });
    const driver = join(current, "tests/e2e/memory-redesign-replay-driver.ts");
    const legacyDriver = join(baseline, "tests/e2e/memory-redesign-replay-driver.ts");
    await copyFile(driver, legacyDriver);
    const reports: Record<string, unknown>[] = [];
    const scenarios = ["fact", "method", "case", "expired", "correction", "scope"] as const;
    for (const scenario of scenarios)
      for (const variant of [1, 2]) {
        const marker = `Replay${scenario}${variant}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        // Rotate the condition order; no run reads another condition's answer or mutable DB.
        const arms =
          variant === 1
            ? (["off", "baseline", "new"] as const)
            : (["new", "off", "baseline"] as const);
        for (const arm of arms) {
          const task = `${scenario}-${variant}-${arm}`;
          const taskRoot = join(root, task);
          const reportPath = join(root, `${task}.result.json`);
          const inputPath = join(root, `${task}.input.json`);
          await writeFile(
            inputPath,
            JSON.stringify({ scenario, variant, arm, root: taskRoot, marker, reportPath }),
          );
          const codeRoot = arm === "baseline" ? baseline : current;
          try {
            await execute(
              process.execPath,
              ["--import", "tsx", arm === "baseline" ? legacyDriver : driver, inputPath],
              {
                cwd: codeRoot,
                timeout: 180_000,
                maxBuffer: 1024 * 1024,
                env: { ...process.env, RUN_LLM_E2E: "1" },
              },
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `comparison ${task} failed: ${detail.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 5000)}`,
            );
          }
          const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
          reports.push(report);
          await writeFile(
            join(root, "comparison-progress.json"),
            JSON.stringify({ completed: reports.length, planned: 36, reports }, null, 2) + "\n",
          );
          t.diagnostic(
            `${reports.length}/36 ${task}: ${JSON.stringify({ schema: report.schema, initialMemory: report.initialMemoryContainsMarker, answerMarker: report.answerContainsMarker, calls: report.modelCalls })}`,
          );
        }
      }
    assert.equal(reports.length, 36);
    const method = reports.filter((report) => report.scenario === "method" && report.arm === "new");
    assert.equal(method.length, 2);
    assert.ok(
      method.some((report) => report.answerContainsMarker === true),
      "no observable generic-method behavior difference",
    );
    const summary = {
      status: "passed",
      runs: 36,
      sourceBaseline: "cef587d11f2cdfb9240946e87d283f37a30c22d5",
      seed: "controlled frozen memory fixture, not natural learning",
      scope:
        "retrieval/permissions/outcomes; generic adoption remains unknown without tool evidence",
      reports,
    };
    await writeFile(join(root, "comparison-report.json"), JSON.stringify(summary, null, 2) + "\n");
    t.diagnostic(`comparison evidence: ${root}`);
  },
);
