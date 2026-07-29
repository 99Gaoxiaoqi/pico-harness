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

test("Terminal-Bench normalizer refuses to overwrite sealed case evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-sealed-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "passed", {
    reward: 1,
    headless: headless("completed", true),
  });
  await normalizeHarborJob({ jobDir, runDir, runId: "sealed-run", expectedTasks: 1 });

  const resultPath = join(jobDir, "passed", "result.json");
  const changed = JSON.parse(await readFile(resultPath, "utf8"));
  changed.verifier_result.rewards.reward = 0;
  await writeFile(resultPath, JSON.stringify(changed));

  await assert.rejects(
    normalizeHarborJob({ jobDir, runDir, runId: "sealed-run", expectedTasks: 1 }),
    /sealed benchmark artifact changed/u,
  );
});

test("Terminal-Bench normalizer fails closed under concurrent publishers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-concurrent-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "passed", {
    reward: 1,
    headless: headless("completed", true),
  });

  const attempts = await Promise.allSettled([
    normalizeHarborJob({ jobDir, runDir, runId: "publisher-a", expectedTasks: 1 }),
    normalizeHarborJob({ jobDir, runDir, runId: "publisher-b", expectedTasks: 1 }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length <= 1, true);
  const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));
  const normalized = JSON.parse(
    await readFile(join(runDir, "cases", "passed", "passed", "normalized-result.json"), "utf8"),
  );
  assert.equal(normalized.runId, summary.runId);
});

test("Terminal-Bench normalizer requires the expected task attempt matrix", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-attempts-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "attempt-1", {
    reward: 1,
    headless: headless("completed", true),
    taskName: "terminal-bench/example",
  });
  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "attempt-run",
    expectedTasks: 2,
    expectedTaskNames: ["terminal-bench/example"],
    expectedAttempts: 2,
  });
  assert.equal(summary.sealed, false);
});

test("Terminal-Bench normalizer rejects duplicate trial identities", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-trial-id-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "first", {
    reward: 1,
    headless: headless("completed", true),
  });
  await writeTrial(jobDir, "second", {
    reward: 1,
    headless: headless("completed", true),
  });
  const second = JSON.parse(await readFile(join(jobDir, "second", "result.json"), "utf8"));
  second.id = "first";
  await writeFile(join(jobDir, "second", "result.json"), JSON.stringify(second));

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "duplicate-trial-run",
    expectedTasks: 2,
  });
  assert.equal(summary.sealed, false);
});

test("Terminal-Bench normalizer classifies malformed Headless evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-malformed-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "malformed", {
    reward: 0,
    headless: headless("completed", true),
  });
  await writeFile(join(jobDir, "malformed", "agent", "pico-result.json"), "{");
  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "malformed-run",
    expectedTasks: 1,
  });
  assert.equal(summary.trials[0].adapter.code, "headless_result_invalid");
  assert.equal(summary.trials[0].primaryStatus, "adapter_error");
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
    taskName?: string;
  },
) {
  const trialDir = join(jobDir, name);
  await mkdir(join(trialDir, "agent"), { recursive: true });
  await writeFile(
    join(trialDir, "result.json"),
    JSON.stringify({
      id: name,
      task_name: options.taskName ?? `terminal-bench/${name}`,
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
