import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import { normalizeHarborJob } from "../../scripts/terminal-bench/normalize-results.mjs";

test("Terminal-Bench normalizer separates task failures from infrastructure failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-normalize-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "passed", {
    reward: 1,
    headless: headless("completed", true),
  });
  await writeTrial(jobDir, "task-failed", {
    reward: 0,
    headless: headless("completed", true),
  });
  await writeTrial(jobDir, "unconfirmed", {
    reward: null,
    headless: headless("timed_out", false),
    exception: { exception_type: "RuntimeError" },
  });

  const summary = await normalizeHarborJob({ jobDir, runDir, runId: "fixture-run" });

  assert.equal(summary.observed, 3);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts.task_failed, 1);
  assert.equal(summary.counts.infra_error, 1);
  const normalized = JSON.parse(
    await readFile(
      join(runDir, "cases", "unconfirmed", "unconfirmed", "normalized-result.json"),
      "utf8",
    ),
  );
  assert.equal(normalized.reward.overall, null);
  assert.equal(normalized.infra.code, "termination_unconfirmed");
});

test("Terminal-Bench normalizer records a pre-job infrastructure failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-pre-job-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const summary = await normalizeHarborJob({
    jobDir: join(root, "missing-job"),
    runDir: join(root, "run"),
    runId: "pre-job",
    expectedTasks: 1,
  });
  assert.equal(summary.observed, 0);
  assert.equal(summary.sealed, false);
});

function headless(status: string, terminationConfirmed: boolean) {
  return {
    schemaVersion: 1,
    requestId: "fixture",
    status,
    usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
    durationMs: 1,
    terminationConfirmed,
    error: null,
  };
}

async function writeTrial(
  jobDir: string,
  name: string,
  options: {
    reward: number | null;
    headless: ReturnType<typeof headless>;
    exception?: { exception_type: string };
  },
) {
  const trialDir = join(jobDir, name);
  await mkdir(join(trialDir, "agent"), { recursive: true });
  await writeFile(
    join(trialDir, "result.json"),
    JSON.stringify({
      id: name,
      task_name: `terminal-bench/${name}`,
      task_checksum: `${name}-checksum`,
      config: { job_id: "job" },
      agent_info: { name: "pico-headless", version: "fixture" },
      agent_result: {
        metadata: {
          pico: {
            exitCode:
              options.headless.status === "timed_out"
                ? 124
                : options.headless.status === "invalid_request"
                  ? 2
                  : 0,
          },
        },
      },
      verifier_result: options.reward === null ? null : { rewards: { reward: options.reward } },
      exception_info: options.exception ?? null,
    }),
  );
  await writeFile(join(trialDir, "agent", "pico-result.json"), JSON.stringify(options.headless));
}
