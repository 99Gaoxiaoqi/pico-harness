import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error The benchmark retry policy is intentionally plain Node ESM.
import * as retryPolicy from "../../scripts/terminal-bench/harbor-retry-policy.mjs";

const { assertHarborTrialRetriesDisabled, harborTrialMaxRetries, harborTrialRetryArgs } =
  retryPolicy;

test("Terminal-Bench pins Harbor trial retries to one preserved attempt", () => {
  assert.equal(harborTrialMaxRetries, 0);
  const retryArgs = harborTrialRetryArgs();
  assert.deepEqual(retryArgs, ["--max-retries", "0"]);
  assert.doesNotThrow(() =>
    assertHarborTrialRetriesDisabled([
      "run",
      "--jobs-dir",
      "/private/job",
      ...retryArgs,
      "--path",
      ".",
    ]),
  );
});

test("Terminal-Bench rejects any Harbor command that could retry or obscure failed evidence", () => {
  const invalidArgs = [
    ["run"],
    ["run", "--max-retries", "1"],
    ["run", "--max-retries", "0", "--max-retries", "0"],
    ["run", "-r", "0"],
    ["run", "-r0"],
    ["run", "-r=0"],
    ["run", "--max-retries=0"],
    ["run", "--max-retries", "0", "--retry-include", "RuntimeError"],
    ["run", "--max-retries", "0", "--retry-exclude", "RuntimeError"],
  ];
  for (const args of invalidArgs) {
    assert.throws(
      () => assertHarborTrialRetriesDisabled(args),
      /trial (?:retry arguments are forbidden|max retries must be exactly zero)/u,
    );
  }
});
