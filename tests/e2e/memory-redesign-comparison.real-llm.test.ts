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
const redact = (value: string): string =>
  value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu,
      "$1[redacted]",
    );
const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
function outcomeScore(report: Record<string, unknown> | undefined): number | null {
  if (!report || typeof report.answer !== "string") return null;
  if (report.scenario === "expired" || report.scenario === "scope")
    return !report.anyRequestContainsMarker && !report.answerContainsMarker ? 1 : 0;
  if (report.scenario === "method" || report.scenario === "case")
    return report.answerContainsMarker === true ? 1 : 0;
  return report.answer === report.marker ? 1 : 0;
}
function compare(
  newer: Record<string, unknown> | undefined,
  older: Record<string, unknown> | undefined,
): "win" | "tie" | "loss" | "unknown" {
  const left = outcomeScore(newer),
    right = outcomeScore(older);
  return left === null || right === null
    ? "unknown"
    : left > right
      ? "win"
      : left < right
        ? "loss"
        : "tie";
}

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
        const frozenAt = Date.now();
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
            JSON.stringify({
              scenario,
              variant,
              arm,
              root: taskRoot,
              marker,
              frozenAt,
              reportPath,
            }),
          );
          const codeRoot = arm === "baseline" ? baseline : current;
          const started = performance.now();
          let processFailure: string | undefined;
          let stdout = "",
            stderr = "";
          try {
            const output = await execute(
              process.execPath,
              ["--import", "tsx", arm === "baseline" ? legacyDriver : driver, inputPath],
              {
                cwd: codeRoot,
                timeout: 180_000,
                maxBuffer: 1024 * 1024,
                encoding: "utf8",
                env: { ...process.env, RUN_LLM_E2E: "1" },
              },
            );
            stdout = output.stdout;
            stderr = output.stderr;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            processFailure = redact(detail).slice(0, 5000);
            const output = error as { stdout?: string; stderr?: string };
            stdout = output.stdout ?? "";
            stderr = output.stderr ?? "";
          }
          await writeFile(join(root, `${task}.stdout.log`), redact(stdout));
          await writeFile(join(root, `${task}.stderr.log`), redact(stderr));
          let observed: Record<string, unknown> = {};
          try {
            observed = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
          } catch (error) {
            processFailure ??= `missing or invalid report: ${redact(String(error)).slice(0, 1000)}`;
          }
          const report: Record<string, unknown> = {
            scenario,
            variant,
            arm,
            marker,
            frozenAt,
            seed: "controlled frozen memory fixture, not natural learning",
            ...observed,
            ...(processFailure ? { status: "failed", processFailure } : {}),
            processElapsedMs: Math.round(performance.now() - started),
            attempt: 1,
            scriptRetries: 0,
          };
          await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
          reports.push(report);
          await writeFile(
            join(root, "comparison-progress.json"),
            JSON.stringify({ completed: reports.length, planned: 36, reports }, null, 2) + "\n",
          );
          t.diagnostic(
            `${reports.length}/36 ${task}: ${JSON.stringify({ status: report.status, schema: report.schema, initialMemory: report.initialMemoryContainsMarker, answerMarker: report.answerContainsMarker, calls: report.modelCalls })}`,
          );
        }
      }
    assert.equal(reports.length, 36);
    const method = reports.filter((report) => report.scenario === "method" && report.arm === "new");
    assert.equal(method.length, 2);
    const methodObserved = method.some(
      (report) =>
        report.status === "passed" &&
        report.initialMemoryContainsMarker === true &&
        report.answerContainsMarker === true,
    );
    const failures = reports.filter((report) => report.status !== "passed");
    const pairs = scenarios.flatMap((scenario) =>
      [1, 2].map((variant) => {
        const arms = reports.filter(
          (report) => report.scenario === scenario && report.variant === variant,
        );
        const newer = arms.find((report) => report.arm === "new"),
          legacy = arms.find((report) => report.arm === "baseline"),
          off = arms.find((report) => report.arm === "off");
        return {
          scenario,
          variant,
          comparableToBaseline: scenario !== "case",
          newVsBaseline: scenario === "case" ? "capability_difference" : compare(newer, legacy),
          newVsOff: compare(newer, off),
          failedArms: arms
            .filter((report) => report.status !== "passed")
            .map((report) => report.arm),
          outcomes: Object.fromEntries(
            arms.map((report) => [
              String(report.arm),
              {
                status: report.status,
                score: outcomeScore(report),
                initialMemory: report.initialMemoryContainsMarker,
                answerMarker: report.answerContainsMarker,
                elapsedMs: report.elapsedMs,
                usage: report.usage,
                modelCalls: report.modelCalls,
              },
            ]),
          ),
        };
      }),
    );
    const totals = Object.fromEntries(
      ["off", "baseline", "new"].map((arm) => {
        const runs = reports.filter((report) => report.arm === arm);
        const usageReports = runs.filter(
          (report) => report.usage && typeof report.usage === "object",
        );
        const ledgerReports = runs.filter(
          (report) =>
            (report.providerLedger as Record<string, unknown> | undefined)?.status === "reported",
        );
        const providerEntries = ledgerReports.flatMap(
          (report) => (report.providerLedger as { entries: Record<string, unknown>[] }).entries,
        );
        const measuredEntries = providerEntries.filter(
          (entry) => entry.usage && typeof entry.usage === "object",
        );
        return [
          arm,
          {
            runs: runs.length,
            passed: runs.filter((report) => report.status === "passed").length,
            reportedUsageRuns: usageReports.length,
            missingUsageRuns: runs.length - usageReports.length,
            modelCalls: runs.reduce((sum, report) => sum + numeric(report.modelCalls), 0),
            elapsedMs: runs.reduce(
              (sum, report) => sum + numeric(report.elapsedMs ?? report.processElapsedMs),
              0,
            ),
            promptTokens: usageReports.reduce(
              (sum, report) =>
                sum + numeric((report.usage as Record<string, unknown>).promptTokens),
              0,
            ),
            completionTokens: usageReports.reduce(
              (sum, report) =>
                sum + numeric((report.usage as Record<string, unknown>).completionTokens),
              0,
            ),
            providerLedgerRuns: ledgerReports.length,
            providerEntries: providerEntries.length,
            measuredProviderEntries: measuredEntries.length,
            physicalPromptTokens: measuredEntries.reduce(
              (sum, entry) => sum + numeric((entry.usage as Record<string, unknown>).promptTokens),
              0,
            ),
            physicalCompletionTokens: measuredEntries.reduce(
              (sum, entry) =>
                sum + numeric((entry.usage as Record<string, unknown>).completionTokens),
              0,
            ),
            costCNY: null,
            costStatus: "unpriced",
          },
        ];
      }),
    );
    const summary = {
      status: failures.length || !methodObserved ? "failed" : "passed",
      runs: 36,
      sourceBaseline: "cef587d11f2cdfb9240946e87d283f37a30c22d5",
      seed: "controlled frozen memory fixture, not natural learning",
      scope:
        "retrieval/permissions/outcomes; generic adoption remains unknown without tool evidence",
      limitations: [
        "Controlled source fixtures compare retrieval and observable marker behavior; they do not prove causal usefulness or natural learning.",
        "Case representation differs between v15 and v16, so case results are a capability check rather than a like-for-like ranking win.",
        "Usage totals include reported runs only; missing usage is unavailable, not zero.",
        "OAuth/default-route zero cost values do not establish actual free usage. Monetary cost is unpriced; physical Provider entries preserve reported tokens and timing.",
      ],
      methodObserved,
      failedRuns: failures.map((report) => `${report.scenario}-${report.variant}-${report.arm}`),
      pairs,
      totals,
      reports,
    };
    await writeFile(join(root, "comparison-report.json"), JSON.stringify(summary, null, 2) + "\n");
    t.diagnostic(`comparison evidence: ${root}`);
    assert.equal(failures.length, 0, `failed comparison runs: ${summary.failedRuns.join(", ")}`);
    assert.ok(methodObserved, "no observable generic-method behavior difference");
  },
);
