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

test("Terminal-Bench normalizer projects recovered policy incidents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tb21-recovered-policy-"));
  const jobDir = join(root, "job");
  const runDir = join(root, "run");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeTrial(jobDir, "recovered-policy", {
    reward: 1,
    headless: headless("completed", true, policyDenials("approval")),
    runId: "recovered-policy-run",
  });

  const summary = await normalizeHarborJob({
    jobDir,
    runDir,
    runId: "recovered-policy-run",
    expectedTasks: 1,
  });

  assert.equal(summary.sealed, true);
  assert.equal(summary.verifierPassCount, 1);
  assert.equal(summary.cleanCompletionCount, 0);
  assert.equal(summary.cleanPassCount, 0);
  assert.equal(summary.policyIncidentCount, 1);
  assert.equal(summary.verifierPassWithPolicyIncidentCount, 1);
  assert.equal(summary.verifierPassWithPolicyIncidentRate, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.counts.policy_blocked, 1);
  assert.equal(summary.trials[0].primaryStatus, "policy_blocked");
  assert.equal(summary.trials[0].verifierPassed, true);
  assert.equal(summary.trials[0].verifierOutcome, "passed");
  assert.equal(summary.trials[0].executionOutcome, "completed");
  assert.equal(summary.trials[0].policyIncident, true);
  assert.deepEqual(summary.trials[0].agent.policyDenials, policyDenials("approval"));
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
    summary.trials.map((trial) => [trial.adapter.status, trial.adapter.code]),
    errorCodes.map((errorCode) => ["error", errorCode]),
  );
  assert.ok(summary.trials.every((trial) => trial.primaryStatus === "adapter_error"));
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

function headless(
  status: string,
  terminationConfirmed: boolean,
  denials?: ReturnType<typeof policyDenials>,
) {
  const result = {
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

function policyDenials(code: "plan_mode" | "hardline" | "hook" | "approval") {
  const byCode = { plan_mode: 0, hardline: 0, hook: 0, approval: 0 };
  byCode[code] = 1;
  const boundary = { source: "permission" as const, code, toolName: "exec_command" };
  return { total: 1, byCode, first: boundary, last: boundary };
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
            exitCode: {
              completed: 0,
              invalid_request: 2,
              failed: 3,
              policy_blocked: 4,
              timed_out: 124,
              canceled: 130,
            }[headlessResult.status],
            costCNY: accounting.actual.costCNY,
            gatewayAccounting: {
              schemaVersion: accounting.schemaVersion,
              status: accounting.status,
              withinBudget: accounting.withinBudget,
              pricingSha256: accounting.pricingSha256,
              receiptSha256: accounting.receiptSha256,
              costMicroCNY: accounting.actual.costMicroCNY,
              costCNY: accounting.actual.costCNY,
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
) {
  return accountingReceiptForRequests(runId, trialId, [[inputTokens, outputTokens]]);
}

function accountingReceiptForRequests(
  runId: string,
  trialId: string,
  usage: ReadonlyArray<readonly [number, number]>,
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
    withinBudget: true,
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
