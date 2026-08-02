import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import { normalizeHarborJob as normalizeHarborJobRaw } from "../../scripts/terminal-bench/normalize-results.mjs";

const gatewayCapabilitySeed = "b".repeat(64);

function normalizeHarborJob(options: Record<string, unknown>) {
  return normalizeHarborJobRaw({ ...options, gatewayCapabilitySeed });
}

test("Terminal-Bench normalizer separates task failures from infrastructure failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-normalize-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "passed", {
    reward: 1,
    headless: headless("completed", true),
    runId: "fixture-run",
  });
  await writeTrial(jobDir, "task-failed", {
    reward: 0,
    headless: headless("completed", true),
    runId: "fixture-run",
  });
  await writeTrial(jobDir, "unconfirmed", {
    reward: null,
    headless: headless("timed_out", false),
    exception: { exception_type: "RuntimeError" },
    runId: "fixture-run",
  });

  const summary = await normalizeHarborJob({ jobDir, runDir, runId: "fixture-run" });

  assert.equal(summary.observed, 3);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts.task_failed, 1);
  assert.equal(summary.counts.infra_error, 1);
  assert.equal(summary.verifierPassCount, 1);
  assert.equal(summary.verifierPassRate, 1 / 3);
  assert.equal(summary.cleanCompletionCount, 2);
  assert.equal(summary.cleanCompletionRate, 2 / 3);
  assert.equal(summary.cleanPassCount, 1);
  assert.equal(summary.cleanPassRate, 1 / 3);
  assert.equal(summary.policyIncidentCount, 0);
  assert.equal(summary.policyIncidentRate, 0);
  const normalized = JSON.parse(
    await readFile(
      join(runDir, "cases", "unconfirmed", "unconfirmed", "normalized-result.json"),
      "utf8",
    ),
  );
  assert.equal(normalized.reward.overall, null);
  assert.equal(normalized.infra.code, "termination_unconfirmed");
  assert.equal(normalized.verifierPassed, false);
  assert.equal(normalized.verifierOutcome, "error");
  assert.equal(normalized.executionOutcome, "infra_error");
  assert.equal(normalized.policyIncident, false);
});

test("Terminal-Bench normalizer preserves verifier passes with policy incidents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-policy-pass-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "policy-pass", {
    reward: 1,
    headless: headless("policy_blocked", true),
    runId: "policy-pass-run",
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "policy-pass-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.verifierPassCount, 1);
  assert.equal(summary.verifierPassRate, 1);
  assert.equal(summary.cleanCompletionCount, 0);
  assert.equal(summary.cleanCompletionRate, 0);
  assert.equal(summary.cleanPassCount, 0);
  assert.equal(summary.cleanPassRate, 0);
  assert.equal(summary.policyIncidentCount, 1);
  assert.equal(summary.policyIncidentRate, 1);
  assert.equal(summary.verifierPassWithPolicyIncidentCount, 1);
  assert.equal(summary.verifierPassWithPolicyIncidentRate, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.counts.policy_blocked, 1);
  assert.deepEqual(
    {
      primaryStatus: summary.trials[0].primaryStatus,
      verifierPassed: summary.trials[0].verifierPassed,
      verifierOutcome: summary.trials[0].verifierOutcome,
      executionOutcome: summary.trials[0].executionOutcome,
      policyIncident: summary.trials[0].policyIncident,
    },
    {
      primaryStatus: "policy_blocked",
      verifierPassed: true,
      verifierOutcome: "passed",
      executionOutcome: "policy_blocked",
      policyIncident: true,
    },
  );
});

test("Terminal-Bench normalizer keeps completed outcomes orthogonal to recovered policy incidents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-recovered-policy-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "recovered-policy", {
    reward: 1,
    headless: headless("completed", true, policyDenials("approval")),
    runId: "recovered-policy-run",
  });
  await writeTrial(jobDir, "failed-after-recovered-policy", {
    reward: 0,
    headless: headless("completed", true, policyDenials("hardline")),
    runId: "recovered-policy-run",
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "recovered-policy-run",
    expectedTasks: 2,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.verifierPassCount, 1);
  assert.equal(summary.cleanCompletionCount, 0);
  assert.equal(summary.cleanPassCount, 0);
  assert.equal(summary.policyIncidentCount, 2);
  assert.equal(summary.verifierPassWithPolicyIncidentCount, 1);
  assert.equal(summary.verifierPassWithPolicyIncidentRate, 1 / 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts.task_failed, 1);
  assert.equal(summary.counts.policy_blocked ?? 0, 0);
  assert.deepEqual(summary.policyReasonKindCounts, {
    ...policyDenials("approval").byReasonKind,
    protected_destination: 1,
  });
  const passedTrial = summary.trials.find(
    (trial: { primaryStatus: string }) => trial.primaryStatus === "passed",
  );
  assert.equal(passedTrial?.verifierPassed, true);
  assert.equal(passedTrial?.verifierOutcome, "passed");
  assert.equal(passedTrial?.executionOutcome, "completed");
  assert.equal(passedTrial?.policyIncident, true);
  assert.deepEqual(passedTrial?.agent.policyDenials, policyDenials("approval"));
  const failedTrial = summary.trials.find(
    (trial: { primaryStatus: string }) => trial.primaryStatus === "task_failed",
  );
  assert.equal(failedTrial?.verifierPassed, false);
  assert.equal(failedTrial?.verifierOutcome, "failed");
  assert.equal(failedTrial?.executionOutcome, "completed");
  assert.equal(failedTrial?.policyIncident, true);
  assert.deepEqual(failedTrial?.agent.policyDenials, policyDenials("hardline"));
});

test("Terminal-Bench normalizer preserves terminal failures alongside policy incidents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-policy-terminal-state-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { task: "failed-after-policy", status: "failed", primaryStatus: "agent_error" },
    { task: "timeout-after-policy", status: "timed_out", primaryStatus: "agent_timeout" },
    { task: "canceled-after-policy", status: "canceled", primaryStatus: "agent_canceled" },
  ];
  for (const entry of cases) {
    await writeTrial(jobDir, entry.task, {
      reward: 0,
      headless: {
        ...headless(entry.status, true, policyDenials("hardline")),
        error: { code: "fixture_terminal_state", summary: "fixture terminal state" },
      },
      runId: "policy-terminal-state-run",
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "policy-terminal-state-run",
    expectedTasks: cases.length,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.policyIncidentCount, cases.length);
  assert.equal(summary.verifierPassWithPolicyIncidentCount, 0);
  for (const entry of cases) {
    const trial = summary.trials.find(
      (candidate: { executionOutcome: string }) => candidate.executionOutcome === entry.status,
    );
    assert.equal(trial?.policyIncident, true);
    assert.equal(trial?.executionOutcome, entry.status);
    assert.equal(trial?.primaryStatus, entry.primaryStatus);
  }
});

test("Terminal-Bench normalizer rejects malformed policy denial evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-malformed-policy-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "malformed-policy", {
    reward: 1,
    headless: headless("completed", true, policyDenials("hook")),
    runId: "malformed-policy-run",
  });
  const headlessPath = join(jobDir, "malformed-policy", "agent", "pico-result.json");
  const malformed = JSON.parse(await readFile(headlessPath, "utf8"));
  malformed.policyDenials.untrusted = true;
  await writeFile(headlessPath, JSON.stringify(malformed));

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "malformed-policy-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0].adapter.code, "policy_denials_invalid");
  assert.equal(summary.trials[0].executionOutcome, "adapter_error");
  assert.equal(summary.trials[0].policyIncident, false);
  assert.equal("policyDenials" in summary.trials[0].agent, false);
});

test("Terminal-Bench normalizer rejects malformed policy reason-kind evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-malformed-policy-reason-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "malformed-policy-reason-run";
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    "unknown-kind",
    "inconsistent-sum",
    "extra-key",
    "source-mismatch",
    "code-reason-mismatch",
    "aggregate-mismatch",
  ];
  for (const name of cases) {
    await writeTrial(jobDir, name, {
      reward: 1,
      headless: headless("completed", true, policyDenials("hardline")),
      runId,
    });
    const headlessPath = join(jobDir, name, "agent", "pico-result.json");
    const malformed = JSON.parse(await readFile(headlessPath, "utf8"));
    if (name === "unknown-kind") {
      malformed.policyDenials.first.reasonKind = "untrusted_reason";
    } else if (name === "inconsistent-sum") {
      malformed.policyDenials.byReasonKind.hook_denied = 1;
    } else if (name === "extra-key") {
      malformed.policyDenials.byReasonKind.command = "must-not-be-projected";
    } else if (name === "source-mismatch") {
      malformed.policyDenials.first.source = "permission";
      malformed.policyDenials.last.source = "permission";
    } else if (name === "code-reason-mismatch") {
      malformed.policyDenials.byReasonKind.protected_destination = 0;
      malformed.policyDenials.byReasonKind.hook_denied = 1;
      malformed.policyDenials.first.reasonKind = "hook_denied";
      malformed.policyDenials.last.reasonKind = "hook_denied";
    } else {
      malformed.policyDenials.total = 2;
      malformed.policyDenials.byCode.approval = 1;
      malformed.policyDenials.byReasonKind.protected_destination = 2;
    }
    await writeFile(headlessPath, JSON.stringify(malformed));
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: cases.length,
  });

  assert.equal(summary.sealed, false);
  assert.equal(
    summary.trials.every(
      (trial: { adapter: { code: string } }) => trial.adapter.code === "policy_denials_invalid",
    ),
    true,
  );
  assert.deepEqual(
    summary.policyReasonKindCounts,
    Object.fromEntries(policyReasonKinds.map((reasonKind) => [reasonKind, 0])),
  );
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
  assert.equal(summary.verifierPassRate, 0);
  assert.equal(summary.cleanCompletionRate, 0);
  assert.equal(summary.cleanPassRate, 0);
  assert.equal(summary.policyIncidentRate, 0);
  assert.equal(summary.verifierPassWithPolicyIncidentRate, 0);
});

test("Terminal-Bench normalizer refuses to overwrite sealed case evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-sealed-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "passed", {
    reward: 1,
    headless: headless("completed", true),
    runId: "sealed-run",
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
    runId: "publisher-a",
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
    runId: "attempt-run",
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

test("Terminal-Bench normalizer rejects trials outside an explicit task selection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-explicit-selection-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "selected", {
    reward: 1,
    headless: headless("completed", true),
    taskName: "terminal-bench/selected",
    runId: "explicit-selection-run",
  });
  await writeTrial(jobDir, "unexpected", {
    reward: 1,
    headless: headless("completed", true),
    taskName: "terminal-bench/unexpected",
    runId: "explicit-selection-run",
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "explicit-selection-run",
    expectedTasks: 2,
    expectedTaskNames: ["terminal-bench/selected", "terminal-bench/requested-but-missing"],
    expectedAttempts: 1,
  });

  assert.equal(summary.observed, 2);
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
    runId: "duplicate-trial-run",
  });
  await writeTrial(jobDir, "second", {
    reward: 1,
    headless: headless("completed", true),
    runId: "duplicate-trial-run",
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
    runId: "malformed-run",
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

test("Terminal-Bench normalizer rejects invalid headless runtime-control requests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-runtime-control-invalid-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  const errorCodes = [
    "INVALID_PROVIDER_REQUEST_MODE",
    "INVALID_POLICY_DENIAL_MODE",
    "INVALID_BASH_TIMEOUT",
  ];
  for (const [index, errorCode] of errorCodes.entries()) {
    await writeTrial(jobDir, `invalid-control-${index}`, {
      reward: 0,
      headless: {
        ...headless("invalid_request", true),
        error: { code: errorCode, summary: "invalid fixture request" },
      },
      runId: "runtime-control-invalid-run",
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "runtime-control-invalid-run",
    expectedTasks: errorCodes.length,
  });

  assert.equal(summary.sealed, false);
  assert.deepEqual(
    summary.trials.map((trial: { adapter: { status: string; code: string } }) => [
      trial.adapter.status,
      trial.adapter.code,
    ]),
    errorCodes.map((errorCode) => ["error", errorCode]),
  );
  assert.ok(
    summary.trials.every(
      (trial: { primaryStatus: string }) => trial.primaryStatus === "adapter_error",
    ),
  );
});

test("Terminal-Bench normalizer requires verifier execution evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-verifier-evidence-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "missing-ctrf", {
    reward: 0,
    headless: headless("completed", true),
    runId: "missing-verifier-evidence",
  });
  await rm(join(jobDir, "missing-ctrf", "verifier", "ctrf.json"));
  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "missing-verifier-evidence",
    expectedTasks: 1,
  });
  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0].verifier.status, "error");
  assert.equal(summary.trials[0].verifierOutcome, "missing");
  assert.equal(summary.trials[0].primaryStatus, "verifier_error");
});

test("Terminal-Bench normalizer rejects empty or inconsistent CTRF evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-invalid-ctrf-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "empty-ctrf", {
    reward: 1,
    headless: headless("completed", true),
    runId: "invalid-verifier-evidence",
  });
  await writeFile(join(jobDir, "empty-ctrf", "verifier", "ctrf.json"), "{}");
  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "invalid-verifier-evidence",
    expectedTasks: 1,
  });
  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0].verifier.status, "error");
  assert.equal(summary.trials[0].verifier.exceptionType, "VerifierEvidenceInvalid");
  assert.equal(summary.trials[0].verifierOutcome, "error");
  assert.equal(summary.trials[0].reward.overall, null);
  assert.equal(summary.trials[0].primaryStatus, "verifier_error");
});

test("Terminal-Bench normalizer rejects incomplete or contradictory CTRF summaries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-ctrf-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, evidence] of [
    [
      "missing-tool",
      {
        results: {
          summary: { tests: 1, passed: 1, failed: 0, skipped: 0, pending: 0, other: 0 },
          tests: [{ name: "fixture", status: "passed" }],
        },
      },
    ],
    [
      "contradictory-counts",
      {
        results: {
          tool: { name: "pytest", version: "8.4.1" },
          summary: { tests: 1, passed: 0, failed: 1, skipped: 0, pending: 0, other: 0 },
          tests: [{ name: "fixture", status: "passed" }],
        },
      },
    ],
  ] as const) {
    const jobDir = join(root, name, "job");
    const runDir = join(root, name, "run");
    await writeTrial(jobDir, name, {
      reward: 1,
      headless: headless("completed", true),
      runId: name,
    });
    await writeFile(join(jobDir, name, "verifier", "ctrf.json"), JSON.stringify(evidence));
    const summary = await normalizeHarborJob({
      jobDir,
      runDir,
      runId: name,
      expectedTasks: 1,
    });
    assert.equal(summary.sealed, false);
    assert.equal(summary.trials[0].verifier.exceptionType, "VerifierEvidenceInvalid");
    assert.equal(summary.trials[0].primaryStatus, "verifier_error");
  }
});

test("Terminal-Bench normalizer publishes locked-pricing gateway accounting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "accounted", {
    reward: 1,
    headless: headless("completed", true),
    runId: "accounted-run",
    accounting: accountingReceipt("accounted-run", "accounted", 125_481, 4_697),
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "accounted-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: 125_481,
    completionTokens: 4_697,
    costCNY: 17.2451,
  });
  assert.equal(summary.trials[0].accounting.actual.costMicroCNY, 17_245_100);
  assert.match(summary.trials[0].accounting.receiptSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    JSON.parse(
      await readFile(
        join(runDir, "cases", "accounted", "accounted", "gateway-accounting-receipt.json"),
        "utf8",
      ),
    ).actual.costCNY,
    17.2451,
  );
});

test("Terminal-Bench normalizer reconciles multi-request tool-use accounting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-multi-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "multi-request", {
    reward: 1,
    headless: headless("completed", true),
    runId: "multi-request-run",
    accounting: accountingReceiptForRequests("multi-request-run", "multi-request", [
      [27, 45],
      [31, 10_309],
    ]),
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "multi-request-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.trials[0].accounting.requestCounts.attempted, 2);
  assert.equal(summary.trials[0].accounting.requests.length, 2);
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: 58,
    completionTokens: 10_354,
    costCNY: 10.3598,
  });
});

test("Terminal-Bench normalizer verifies zero and integer-CNY receipts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-numeric-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "zero-cost", {
    reward: 1,
    headless: headless("completed", true),
    runId: "numeric-run",
    accounting: accountingReceipt("numeric-run", "zero-cost", 0, 0),
  });
  await writeTrial(jobDir, "integer-cost", {
    reward: 1,
    headless: headless("completed", true),
    runId: "numeric-run",
    accounting: accountingReceipt("numeric-run", "integer-cost", 10_000, 0),
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "numeric-run",
    expectedTasks: 2,
  });

  assert.equal(summary.sealed, true);
  assert.deepEqual(
    summary.trials
      .map((trial: { agent: { usage: { costCNY: number } } }) => {
        return trial.agent.usage.costCNY;
      })
      .sort((left: number, right: number) => left - right),
    [0, 1],
  );
});

test("Terminal-Bench normalizer rejects a forged accounting HMAC", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-forged-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "forged", {
    reward: 1,
    headless: headless("completed", true),
    runId: "forged-run",
  });
  const receiptPath = join(jobDir, "forged", "agent", "gateway-accounting-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.auth.tag = "f".repeat(64);
  receipt.receiptSha256 = sha256Canonical(accountingReceiptPayload(receipt, true));
  await writeFile(receiptPath, JSON.stringify(receipt));
  const resultPath = join(jobDir, "forged", "result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  result.agent_result.metadata.pico.gatewayAccounting.receiptSha256 = receipt.receiptSha256;
  await writeFile(resultPath, JSON.stringify(result));

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "forged-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0].adapter.code, "accounting_auth_invalid");
});

test("Terminal-Bench normalizer rejects runtime or Harbor token mismatches", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-token-mismatch-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "runtime-mismatch", {
    reward: 1,
    headless: headless("completed", true),
    runId: "token-mismatch-run",
    runtimeUsage: { promptTokens: 2, completionTokens: 1 },
  });
  await writeTrial(jobDir, "harbor-mismatch", {
    reward: 1,
    headless: headless("completed", true),
    runId: "token-mismatch-run",
    harborUsage: { inputTokens: 2, outputTokens: 1 },
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "token-mismatch-run",
    expectedTasks: 2,
  });

  assert.equal(summary.sealed, false);
  assert.deepEqual(
    summary.trials.map((trial: { adapter: { code: string } }) => trial.adapter.code),
    ["accounting_token_mismatch", "accounting_token_mismatch"],
  );
  assert.equal(
    summary.trials.every(
      (trial: { primaryStatus: string }) => trial.primaryStatus === "adapter_error",
    ),
    true,
  );
});

test("Terminal-Bench normalizer accepts signed aggregate usage for one runtime retry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-retry-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "accounting-retry-run";
  const trialId = "retried";
  const final = headless("completed", true);
  const accounting = accountingReceiptForRequests(runId, trialId, [
    [4, 2],
    [5, 3],
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: 1,
    headless: final,
    runId,
    accounting,
    runtimeUsage: { promptTokens: 5, completionTokens: 3 },
    harborUsage: {
      inputTokens: accounting.actual.inputTokens,
      outputTokens: accounting.actual.outputTokens,
    },
    attempts: retriedAttempts(final),
    retryCount: 1,
    signedGatewayUsageRequired: true,
    gatewayUsageFallback: true,
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.trials[0].adapter.status, "ok");
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: accounting.actual.inputTokens,
    completionTokens: accounting.actual.outputTokens,
    costCNY: accounting.actual.costCNY,
  });
  assert.deepEqual(summary.trials[0].agent.runtimeReportedUsage, {
    promptTokens: 5,
    completionTokens: 3,
    costCNY: 0,
  });
});

test("Terminal-Bench normalizer rejects unsigned, forged, or non-retry usage mismatches", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-retry-invalid-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "accounting-retry-invalid-run";
  const final = headless("completed", true);
  const validAttempts = retriedAttempts(final);
  const [firstAttempt, finalAttempt] = validAttempts;
  if (!firstAttempt || !finalAttempt) throw new Error("retry fixture attempts are incomplete");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      name: "not-a-retry",
      attempts: [finalAttempt],
      retryCount: 0,
      signedGatewayUsageRequired: false,
    },
    {
      name: "forged-first-attempt",
      attempts: [{ ...firstAttempt, errorCode: "OTHER_RUNTIME_ERROR" }, finalAttempt],
      retryCount: 1,
      signedGatewayUsageRequired: true,
    },
    {
      name: "extra-attempt-key",
      attempts: [{ ...firstAttempt, command: "must-not-be-accepted" }, finalAttempt],
      retryCount: 1,
      signedGatewayUsageRequired: true,
    },
    {
      name: "unsigned-retry",
      attempts: validAttempts,
      retryCount: 1,
      signedGatewayUsageRequired: false,
    },
  ];
  for (const value of cases) {
    const accounting = accountingReceiptForRequests(runId, value.name, [
      [4, 2],
      [5, 3],
    ]);
    await writeTrial(jobDir, value.name, {
      reward: 1,
      headless: final,
      runId,
      accounting,
      runtimeUsage: { promptTokens: 5, completionTokens: 3 },
      harborUsage: {
        inputTokens: accounting.actual.inputTokens,
        outputTokens: accounting.actual.outputTokens,
      },
      attempts: value.attempts,
      retryCount: value.retryCount,
      signedGatewayUsageRequired: value.signedGatewayUsageRequired,
      gatewayUsageFallback: true,
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: cases.length,
  });

  assert.equal(summary.sealed, false);
  assert.equal(
    summary.trials.every(
      (trial: { adapter: { code: string } }) => trial.adapter.code === "accounting_token_mismatch",
    ),
    true,
  );
});

test("Terminal-Bench normalizer accepts the signed RUNTIME_FAILED zero-usage fallback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-runtime-fallback-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "runtime-fallback-run";
  const trialId = "runtime-fallback";
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: 1,
    headless: {
      ...headless("failed", true),
      error: { code: "RUNTIME_FAILED", summary: "The Agent Runtime failed." },
    },
    runId,
    accounting: accountingReceipt(runId, trialId, 125, 7),
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: { inputTokens: 125, outputTokens: 7 },
    gatewayUsageFallback: true,
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.trials[0].infra.status, "ok");
  assert.equal(summary.trials[0].adapter.status, "ok");
  assert.equal(summary.trials[0].agent.status, "failed");
  assert.equal(summary.trials[0].agent.errorCode, "RUNTIME_FAILED");
  assert.equal(summary.trials[0].executionOutcome, "failed");
  assert.equal(summary.trials[0].primaryStatus, "agent_error");
  assert.equal(summary.trials[0].verifier.status, "completed");
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: 125,
    completionTokens: 7,
    costCNY: 0.0195,
  });
  assert.deepEqual(summary.trials[0].agent.runtimeReportedUsage, {
    promptTokens: 0,
    completionTokens: 0,
    costCNY: 0,
  });
  const rawHeadless = JSON.parse(
    await readFile(join(jobDir, trialId, "agent", "pico-result.json"), "utf8"),
  );
  assert.deepEqual(rawHeadless.usage, {
    promptTokens: 0,
    completionTokens: 0,
    costCNY: 0,
  });
});

test("Terminal-Bench normalizer accepts signed zero-usage accounting after a confirmed timeout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-timeout-fallback-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "timeout-fallback-run";
  const trialId = "timeout-fallback";
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: 0,
    headless: {
      ...headless("timed_out", true),
      error: { code: "TIMEOUT", summary: "The Agent Runtime timed out." },
    },
    runId,
    accounting: accountingReceipt(runId, trialId, 125, 7),
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: { inputTokens: 125, outputTokens: 7 },
    gatewayUsageFallback: true,
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.trials[0].infra.status, "ok");
  assert.equal(summary.trials[0].adapter.status, "ok");
  assert.equal(summary.trials[0].agent.status, "timed_out");
  assert.equal(summary.trials[0].agent.errorCode, "TIMEOUT");
  assert.equal(summary.trials[0].executionOutcome, "timed_out");
  assert.equal(summary.trials[0].primaryStatus, "agent_timeout");
  assert.equal(summary.trials[0].verifier.status, "completed");
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: 125,
    completionTokens: 7,
    costCNY: 0.0195,
  });
  assert.deepEqual(summary.trials[0].agent.runtimeReportedUsage, {
    promptTokens: 0,
    completionTokens: 0,
    costCNY: 0,
  });
});

test("Terminal-Bench normalizer accepts only the signed unconfirmed-termination usage contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-unconfirmed-gateway-usage-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "unconfirmed-gateway-usage-run";
  const trialId = "unconfirmed-gateway-usage";
  const accounting = accountingReceipt(runId, trialId, 125, 7);
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: null,
    headless: {
      ...headless("timed_out", false),
      error: { code: "SHUTDOWN_UNCONFIRMED", summary: "Shutdown was not confirmed." },
    },
    runId,
    accounting,
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: {
      inputTokens: accounting.actual.inputTokens,
      outputTokens: accounting.actual.outputTokens,
    },
    signedGatewayUsageRequired: true,
    gatewayUsageFallback: true,
    gatewayUsageSource: "signed_gateway_actual_unconfirmed",
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 1,
  });

  const [trial] = summary.trials;
  assert.equal(summary.sealed, false);
  assert.equal(trial?.adapter.status, "ok");
  assert.equal(trial?.primaryStatus, "infra_error");
  assert.equal(trial?.infra.code, "termination_unconfirmed");
  assert.equal(trial?.verifier.status, "missing");
  assert.equal(trial?.verifierOutcome, "missing");
  assert.equal(trial?.verifierPassed, false);
  assert.deepEqual(trial?.agent.usage, {
    promptTokens: accounting.actual.inputTokens,
    completionTokens: accounting.actual.outputTokens,
    costCNY: accounting.actual.costCNY,
  });
  assert.deepEqual(trial?.agent.runtimeReportedUsage, {
    promptTokens: 0,
    completionTokens: 0,
    costCNY: 0,
  });
});

test("Terminal-Bench normalizer accepts signed unconfirmed-termination usage without output tokens", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-unconfirmed-gateway-input-only-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "unconfirmed-gateway-input-only-run";
  const trialId = "unconfirmed-gateway-input-only";
  const accounting = accountingReceipt(runId, trialId, 125, 0);
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: null,
    headless: {
      ...headless("timed_out", false),
      error: { code: "SHUTDOWN_UNCONFIRMED", summary: "Shutdown was not confirmed." },
    },
    runId,
    accounting,
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: {
      inputTokens: accounting.actual.inputTokens,
      outputTokens: accounting.actual.outputTokens,
    },
    signedGatewayUsageRequired: true,
    gatewayUsageFallback: true,
    gatewayUsageSource: "signed_gateway_actual_unconfirmed",
  });

  const summary = await normalizeHarborJob({ jobDir, runDir, runId, expectedTasks: 1 });

  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0]?.adapter.status, "ok");
  assert.equal(summary.trials[0]?.primaryStatus, "infra_error");
  assert.deepEqual(summary.trials[0]?.agent.usage, {
    promptTokens: 125,
    completionTokens: 0,
    costCNY: accounting.actual.costCNY,
  });
});

test("Terminal-Bench normalizer fails closed when the unconfirmed-termination usage contract changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-unconfirmed-gateway-usage-denied-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "unconfirmed-gateway-usage-denied-run";
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseHeadless = {
    ...headless("timed_out", false),
    error: { code: "SHUTDOWN_UNCONFIRMED", summary: "Shutdown was not confirmed." },
  };
  const cases = [
    {
      name: "usage-marker",
      gatewayUsageFallback: false,
      gatewayUsageSource: "signed_gateway_actual_unconfirmed",
    },
    {
      name: "usage-source",
      gatewayUsageFallback: true,
      gatewayUsageSource: "signed_gateway_actual",
    },
    {
      name: "confirmed-termination",
      headless: { ...baseHeadless, terminationConfirmed: true },
    },
    {
      name: "wrong-status",
      headless: { ...baseHeadless, status: "failed" },
    },
    {
      name: "wrong-error",
      headless: {
        ...baseHeadless,
        error: { code: "TIMEOUT", summary: "The Agent Runtime timed out." },
      },
    },
    {
      name: "runtime-usage-not-zero",
      runtimeUsage: { promptTokens: 1, completionTokens: 0 },
    },
    {
      name: "receipt-all-zero",
      accounting: accountingReceipt(runId, "receipt-all-zero", 0, 0),
    },
    {
      name: "receipt-unreconciled",
      accounting: unreconciledAccountingReceipt(runId, "receipt-unreconciled", 125, 7),
    },
  ];
  for (const value of cases) {
    const accounting = value.accounting ?? accountingReceipt(runId, value.name, 125, 7);
    await writeTrial(jobDir, value.name, {
      reward: null,
      headless: value.headless ?? baseHeadless,
      runId,
      accounting,
      runtimeUsage: value.runtimeUsage ?? { promptTokens: 0, completionTokens: 0 },
      harborUsage: {
        inputTokens: accounting.actual.inputTokens,
        outputTokens: accounting.actual.outputTokens,
      },
      signedGatewayUsageRequired: true,
      gatewayUsageFallback: value.gatewayUsageFallback ?? true,
      gatewayUsageSource: value.gatewayUsageSource ?? "signed_gateway_actual_unconfirmed",
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: cases.length,
  });

  assert.equal(summary.sealed, false);
  for (const trial of summary.trials) {
    assert.equal(trial.adapter.status, "error");
    assert.notEqual(trial.primaryStatus, "passed");
  }
});

test("Terminal-Bench normalizer keeps matching zero usage on the runtime accounting path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-zero-timeout-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "zero-timeout-run";
  const trialId = "zero-timeout";
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, trialId, {
    reward: 0,
    headless: {
      ...headless("timed_out", true),
      error: { code: "TIMEOUT", summary: "The Agent Runtime timed out." },
    },
    runId,
    accounting: accountingReceipt(runId, trialId, 0, 0),
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: { inputTokens: 0, outputTokens: 0 },
    signedGatewayUsageRequired: false,
    gatewayUsageFallback: false,
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.trials[0].adapter.status, "ok");
  assert.equal(summary.trials[0].primaryStatus, "agent_timeout");
  assert.deepEqual(summary.trials[0].agent.usage, {
    promptTokens: 0,
    completionTokens: 0,
    costCNY: 0,
  });
});

test("Terminal-Bench normalizer limits zero-usage fallback to exact terminal failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-runtime-fallback-denied-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "runtime-fallback-denied-run";
  context.after(() => rm(root, { recursive: true, force: true }));
  const failed = () => ({
    ...headless("failed", true),
    error: { code: "RUNTIME_FAILED", summary: "The Agent Runtime failed." },
  });
  const cases = [
    {
      name: "completed",
      headless: headless("completed", true),
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "other-error",
      headless: {
        ...headless("failed", true),
        error: { code: "OTHER_RUNTIME_ERROR", summary: "Different runtime error." },
      },
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "other-timeout-error",
      headless: {
        ...headless("timed_out", true),
        error: { code: "OTHER_TIMEOUT", summary: "Different timeout error." },
      },
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "termination-unconfirmed",
      headless: {
        ...headless("failed", false),
        error: { code: "RUNTIME_FAILED", summary: "Termination was not confirmed." },
      },
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "partial-runtime-usage",
      headless: failed(),
      runtimeUsage: { promptTokens: 0, completionTokens: 1 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "runtime-cost",
      headless: {
        ...failed(),
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0.000001 },
      },
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
    },
    {
      name: "missing-markers",
      headless: failed(),
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      omitGatewayUsageMarkers: true,
    },
    {
      name: "wrong-source",
      headless: failed(),
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 1 },
      gatewayUsageFallback: true,
      gatewayUsageSource: "runtime",
    },
    {
      name: "harbor-mismatch",
      headless: failed(),
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 2, outputTokens: 0 },
      gatewayUsageFallback: true,
    },
  ];
  for (const value of cases) {
    await writeTrial(jobDir, value.name, {
      reward: 1,
      runId,
      accounting: accountingReceipt(runId, value.name, 2, 1),
      ...value,
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: cases.length,
  });

  assert.equal(summary.sealed, false);
  assert.equal(
    summary.trials.every(
      (trial: { adapter: { status: string; code: string } }) =>
        trial.adapter.status === "error" && trial.adapter.code === "accounting_token_mismatch",
    ),
    true,
  );
});

test("Terminal-Bench normalizer keeps unreconciled and over-budget trials closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-gates-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  const runId = "accounting-gates-run";
  context.after(() => rm(root, { recursive: true, force: true }));
  const failed = {
    ...headless("failed", true),
    error: { code: "RUNTIME_FAILED", summary: "The Agent Runtime failed." },
  };
  await writeTrial(jobDir, "circuit", {
    reward: 1,
    headless: failed,
    runId,
    accounting: unreconciledAccountingReceipt(runId, "circuit", 2, 1),
    runtimeUsage: { promptTokens: 0, completionTokens: 0 },
    harborUsage: { inputTokens: 0, outputTokens: 0 },
  });
  for (const trialId of ["path", "chess", "adaptive"]) {
    await writeTrial(jobDir, trialId, {
      reward: 1,
      headless: failed,
      runId,
      accounting: accountingReceipt(runId, trialId, 2, 1, false),
      runtimeUsage: { promptTokens: 0, completionTokens: 0 },
      harborUsage: { inputTokens: 0, outputTokens: 0 },
    });
  }

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId,
    expectedTasks: 4,
  });

  assert.equal(summary.sealed, false);
  const codes = Object.fromEntries(
    summary.trials.map((trial: { trialId: string; adapter: { code: string } }) => [
      trial.trialId,
      trial.adapter.code,
    ]),
  );
  assert.deepEqual(codes, {
    adaptive: "accounting_budget_exceeded",
    chess: "accounting_budget_exceeded",
    circuit: "accounting_unreconciled",
    path: "accounting_budget_exceeded",
  });
  assert.equal(
    summary.trials.every(
      (trial: { primaryStatus: string }) => trial.primaryStatus === "adapter_error",
    ),
    true,
  );
});

test("Terminal-Bench normalizer fails closed without a valid accounting receipt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-accounting-invalid-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "missing-accounting", {
    reward: 1,
    headless: headless("completed", true),
    runId: "missing-accounting-run",
  });
  await rm(join(jobDir, "missing-accounting", "agent", "gateway-accounting-receipt.json"));

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "missing-accounting-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, false);
  assert.equal(summary.trials[0].adapter.code, "accounting_receipt_missing");
  assert.equal(summary.trials[0].primaryStatus, "adapter_error");
});

type HeadlessFixture = {
  schemaVersion: number;
  requestId: string;
  status: string;
  usage: { promptTokens: number; completionTokens: number; costCNY: number };
  durationMs: number;
  terminationConfirmed: boolean;
  error: { code: string; summary: string } | null;
  policyDenials?: ReturnType<typeof policyDenials>;
};

type AdapterAttemptFixture = {
  attempt: number;
  requestId: string;
  status: string;
  errorCode: string | null;
  terminationConfirmed: boolean;
  durationMs: number;
  [key: string]: unknown;
};

function headless(
  status: string,
  terminationConfirmed: boolean,
  denials?: ReturnType<typeof policyDenials>,
): HeadlessFixture {
  const result: HeadlessFixture = {
    schemaVersion: 1,
    requestId: "fixture",
    status,
    usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
    durationMs: 1,
    terminationConfirmed,
    error: null,
  };
  return denials ? { ...result, policyDenials: denials } : result;
}

const policyReasonKinds = [
  "plan_mode",
  "source_or_dot",
  "opaque_shell",
  "dynamic_executable",
  "protected_destination",
  "protected_redirect",
  "destructive_git",
  "destructive_system",
  "hook_denied",
  "approval_denied",
  "unknown_hardline",
] as const;

type PolicyReasonKind = (typeof policyReasonKinds)[number];

function policyDenials(code: "plan_mode" | "hardline" | "hook" | "approval") {
  const byCode = { plan_mode: 0, hardline: 0, hook: 0, approval: 0 };
  byCode[code] = 1;
  const reasonKind: PolicyReasonKind = {
    plan_mode: "plan_mode",
    hardline: "protected_destination",
    hook: "hook_denied",
    approval: "approval_denied",
  }[code] as PolicyReasonKind;
  const byReasonKind = Object.fromEntries(
    policyReasonKinds.map((candidate) => [candidate, candidate === reasonKind ? 1 : 0]),
  ) as Record<PolicyReasonKind, number>;
  const boundary = {
    source: (code === "plan_mode" || code === "hardline" ? "safety" : "permission") as
      | "safety"
      | "permission",
    code,
    reasonKind,
    toolName: "exec_command",
  };
  return { total: 1, byCode, byReasonKind, first: boundary, last: boundary };
}

function retriedAttempts(final: HeadlessFixture): AdapterAttemptFixture[] {
  return [
    {
      attempt: 1,
      requestId: `${final.requestId}.attempt-1`,
      status: "failed",
      errorCode: "RUNTIME_FAILED",
      terminationConfirmed: true,
      durationMs: 2,
    },
    {
      attempt: 2,
      requestId: final.requestId,
      status: final.status,
      errorCode: final.error?.code ?? null,
      terminationConfirmed: final.terminationConfirmed,
      durationMs: final.durationMs,
    },
  ];
}

async function writeTrial(
  jobDir: string,
  name: string,
  options: {
    reward: number | null;
    headless: ReturnType<typeof headless>;
    exception?: { exception_type: string };
    taskName?: string;
    runId: string;
    accounting?: ReturnType<typeof accountingReceipt>;
    runtimeUsage?: { promptTokens: number; completionTokens: number };
    harborUsage?: { inputTokens: number; outputTokens: number };
    gatewayUsageFallback?: boolean;
    gatewayUsageSource?: string;
    omitGatewayUsageMarkers?: boolean;
    attempts?: AdapterAttemptFixture[];
    retryCount?: number;
    signedGatewayUsageRequired?: boolean;
  },
) {
  const trialDir = join(jobDir, name);
  const accounting = options.accounting ?? accountingReceipt(options.runId, name, 1, 1);
  const runtimeUsage = options.runtimeUsage ?? {
    promptTokens: accounting.actual.inputTokens,
    completionTokens: accounting.actual.outputTokens,
  };
  const harborUsage = options.harborUsage ?? {
    inputTokens: runtimeUsage.promptTokens,
    outputTokens: runtimeUsage.completionTokens,
  };
  const headlessResult = {
    ...options.headless,
    usage: {
      ...options.headless.usage,
      promptTokens: runtimeUsage.promptTokens,
      completionTokens: runtimeUsage.completionTokens,
    },
  };
  await mkdir(join(trialDir, "agent"), { recursive: true });
  await mkdir(join(trialDir, "verifier"), { recursive: true });
  await writeFile(
    join(trialDir, "result.json"),
    JSON.stringify({
      id: name,
      task_name: options.taskName ?? `terminal-bench/${name}`,
      task_checksum: `${name}-checksum`,
      config: { job_id: "job" },
      agent_info: { name: "pico-headless", version: "fixture" },
      agent_result: {
        n_input_tokens: harborUsage.inputTokens,
        n_output_tokens: harborUsage.outputTokens,
        metadata: {
          pico: {
            requestId: headlessResult.requestId,
            status: headlessResult.status,
            errorCode: headlessResult.error?.code ?? null,
            terminationConfirmed: headlessResult.terminationConfirmed,
            durationMs: headlessResult.durationMs,
            exitCode: {
              completed: 0,
              invalid_request: 2,
              failed: 3,
              policy_blocked: 4,
              timed_out: 124,
              canceled: 130,
            }[headlessResult.status],
            costCNY: accounting.actual.costCNY,
            runtimeReportedCostCNY: headlessResult.usage.costCNY,
            runtimeReportedUsage: headlessResult.usage,
            attempts: options.attempts ?? [
              {
                attempt: 1,
                requestId: headlessResult.requestId,
                status: headlessResult.status,
                errorCode: headlessResult.error?.code ?? null,
                terminationConfirmed: headlessResult.terminationConfirmed,
                durationMs: headlessResult.durationMs,
              },
            ],
            retryCount: options.retryCount ?? 0,
            signedGatewayUsageRequired:
              options.signedGatewayUsageRequired ?? options.gatewayUsageFallback ?? false,
            gatewayAccounting: {
              schemaVersion: accounting.schemaVersion,
              status: accounting.status,
              withinBudget: accounting.withinBudget,
              pricingSha256: accounting.pricingSha256,
              receiptSha256: accounting.receiptSha256,
              costMicroCNY: accounting.actual.costMicroCNY,
              costCNY: accounting.actual.costCNY,
              ...(!options.omitGatewayUsageMarkers
                ? {
                    usageFallback: options.gatewayUsageFallback ?? false,
                    usageSource:
                      options.gatewayUsageSource ??
                      (options.gatewayUsageFallback ? "signed_gateway_actual" : "runtime"),
                  }
                : {}),
            },
          },
        },
      },
      verifier_result: options.reward === null ? null : { rewards: { reward: options.reward } },
      exception_info: options.exception ?? null,
    }),
  );
  await writeFile(join(trialDir, "agent", "pico-result.json"), JSON.stringify(headlessResult));
  await writeFile(
    join(trialDir, "agent", "gateway-accounting-receipt.json"),
    JSON.stringify(accounting),
  );
  await writeFile(
    join(trialDir, "verifier", "ctrf.json"),
    JSON.stringify({
      results: {
        tool: { name: "pytest", version: "8.4.1" },
        summary: { tests: 1, passed: 1, failed: 0, skipped: 0, pending: 0, other: 0 },
        tests: [{ name: "fixture", status: "passed" }],
      },
    }),
  );
}

function accountingReceipt(
  runId: string,
  trialId: string,
  inputTokens: number,
  outputTokens: number,
  withinBudget = true,
) {
  return accountingReceiptForRequests(runId, trialId, [[inputTokens, outputTokens]], withinBudget);
}

function accountingReceiptForRequests(
  runId: string,
  trialId: string,
  usage: ReadonlyArray<readonly [number, number]>,
  withinBudget = true,
) {
  const pricing = {
    schemaVersion: 1,
    providerId: "fixture",
    model: "fixture-model",
    currency: "CNY",
    unit: "microCNYPerMillionTokens",
    input: 100_000_000,
    output: 1_000_000_000,
  };
  const pricingSha256 = sha256Canonical(pricing);
  const requestEntries = usage.map(([inputTokens, outputTokens], index) => {
    const costMicroCNY = Math.ceil(
      (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000,
    );
    const actual = { inputTokens, outputTokens, costMicroCNY };
    const zero = { inputTokens: 0, outputTokens: 0, costMicroCNY: 0 };
    return {
      sequence: index + 1,
      status: "reconciled",
      reservation: actual,
      actual,
      refund: zero,
      supplement: zero,
      unreconciledReservation: zero,
    };
  });
  const actualTotals = requestEntries.reduce(
    (totals, entry) => ({
      inputTokens: totals.inputTokens + entry.actual.inputTokens,
      outputTokens: totals.outputTokens + entry.actual.outputTokens,
      costMicroCNY: totals.costMicroCNY + entry.actual.costMicroCNY,
    }),
    { inputTokens: 0, outputTokens: 0, costMicroCNY: 0 },
  );
  const zeroTotals = { inputTokens: 0, outputTokens: 0, costMicroCNY: 0 };
  const receipt = {
    schemaVersion: 1,
    runId,
    trialId,
    protocol: "openai",
    modelRouteId: "fixture/fixture-model",
    pricing,
    pricingSha256,
    rounding: "ceil-per-request",
    status: "reconciled",
    withinBudget,
    requests: {
      attempted: requestEntries.length,
      reconciled: requestEntries.length,
      unreconciled: 0,
    },
    requestEntries,
    reservation: actualTotals,
    actual: {
      ...actualTotals,
      costCNY: actualTotals.costMicroCNY / 1_000_000,
    },
    refund: zeroTotals,
    supplement: zeroTotals,
    unreconciledReservation: zeroTotals,
  };
  return authenticateAccountingReceipt(receipt);
}

function unreconciledAccountingReceipt(
  runId: string,
  trialId: string,
  inputTokens: number,
  outputTokens: number,
) {
  const reconciled = accountingReceipt(runId, trialId, inputTokens, outputTokens);
  const { auth: reconciledAuth, receiptSha256: reconciledReceiptSha256, ...base } = reconciled;
  void reconciledAuth;
  void reconciledReceiptSha256;
  const baseEntry = base.requestEntries[0];
  if (!baseEntry) throw new Error("fixture accounting entry is missing");
  const zero = { inputTokens: 0, outputTokens: 0, costMicroCNY: 0 };
  const pending = {
    inputTokens: 1,
    outputTokens: 1,
    costMicroCNY: Math.ceil((base.pricing.input + base.pricing.output) / 1_000_000),
  };
  const reservation = {
    inputTokens: base.reservation.inputTokens + pending.inputTokens,
    outputTokens: base.reservation.outputTokens + pending.outputTokens,
    costMicroCNY: base.reservation.costMicroCNY + pending.costMicroCNY,
  };
  return authenticateAccountingReceipt({
    ...base,
    status: "unreconciled",
    withinBudget: false,
    requests: { attempted: 2, reconciled: 1, unreconciled: 1 },
    requestEntries: [
      baseEntry,
      {
        sequence: 2,
        status: "unreconciled",
        reservation: pending,
        actual: zero,
        refund: zero,
        supplement: zero,
        unreconciledReservation: pending,
      },
    ],
    reservation,
    actual: base.actual,
    refund: zero,
    supplement: zero,
    unreconciledReservation: pending,
  });
}

function authenticateAccountingReceipt<T extends { actual: Record<string, unknown> }>(receipt: T) {
  const auth = {
    algorithm: "hmac-sha256",
    keyId: "run-capability-v1",
    tag: createHmac("sha256", gatewayCapabilitySeed)
      .update("pico-gateway-accounting-receipt-v1\0")
      .update(canonicalJson(accountingReceiptPayload(receipt, false)))
      .digest("hex"),
  };
  const authenticated = { ...receipt, auth };
  return {
    ...authenticated,
    receiptSha256: sha256Canonical(accountingReceiptPayload(authenticated, true)),
  };
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function accountingReceiptPayload(
  value: {
    actual: Record<string, unknown>;
    auth?: unknown;
    receiptSha256?: unknown;
    [key: string]: unknown;
  },
  includeAuth: boolean,
): Record<string, unknown> {
  const payload = structuredClone(value);
  delete payload.receiptSha256;
  if (!includeAuth) delete payload.auth;
  delete payload.actual.costCNY;
  return payload;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
