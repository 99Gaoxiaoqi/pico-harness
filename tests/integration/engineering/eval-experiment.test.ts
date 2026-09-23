import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runExperiment,
  summarizeExperiment,
  type ExperimentSpec,
  type Measurement,
} from "../../../scripts/eval/experiment.js";

const spec: ExperimentSpec = {
  schemaVersion: 1,
  id: "fixture",
  subjects: ["a", "b"],
  scenarios: ["batch", "single"],
  repetitions: 2,
  config: { model: "fake", policy: 1 },
};
const measurement: Measurement = {
  available: true,
  triggered: true,
  success: true,
  error: false,
  elapsedMs: 10,
  tokens: 4,
  cost: null,
};

test("experiment persists a partial matrix, resumes missing cells and preserves failed evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-eval-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const execute = async () => ({
    measurement: { ...measurement, success: ++calls !== 2, error: calls === 2 },
    result: calls,
  });
  const partial = await runExperiment({
    spec,
    directory,
    execute,
    shouldStop: (samples) => samples.length === 3,
  });
  assert.equal(partial.length, 3);
  const before = await Promise.all(
    (await readdir(join(directory, "attempts"))).map(
      async (name) => [name, await readFile(join(directory, "attempts", name), "utf8")] as const,
    ),
  );
  const full = await runExperiment({ spec, directory, execute });
  assert.equal(full.length, 8);
  assert.equal(calls, 8);
  assert.deepEqual(
    full.map((a) => a.cell.subject),
    ["a", "b", "a", "b", "b", "a", "b", "a"],
  );
  for (const [name, content] of before)
    assert.equal(await readFile(join(directory, "attempts", name), "utf8"), content);
  assert.deepEqual(await runExperiment({ spec, directory, execute }), full);
  assert.equal(calls, 8);
  const summary = summarizeExperiment(8, full);
  assert.equal(summary.rateDenominator, 8);
  assert.equal(summary.succeeded, 7);
  assert.equal(summary.errors, 1);
  assert.equal(summary.successRate, 7 / 8);
  assert.equal(summary.tokens.total, 32);
  assert.equal(summary.cost.total, null);
  assert.equal(summarizeExperiment(8, partial).triggerRate, null);
  await assert.rejects(
    runExperiment({ spec: { ...spec, config: { policy: 2 } }, directory, execute }),
    /spec\/config mismatch/,
  );
  assert.equal(calls, 8);
});

test("experiment refuses overlapping writers and resumes after an interrupted executor", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-eval-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execution = runExperiment({
    spec,
    directory,
    execute: async () => {
      started();
      await gate;
      throw new Error("interrupted");
    },
  });
  await ready;
  await assert.rejects(
    runExperiment({ spec, directory, execute: async () => ({ measurement, result: 1 }) }),
    { code: "EEXIST" },
  );
  release();
  await assert.rejects(execution, /interrupted/);
  const attempts = await runExperiment({
    spec,
    directory,
    execute: async () => ({
      measurement: { ...measurement, available: false, success: false, error: true, tokens: null },
      result: 1,
    }),
  });
  const summary = summarizeExperiment(8, attempts);
  assert.equal(summary.triggerRate, null);
  assert.equal(summary.unavailable, 8);
  assert.equal(summary.tokens.total, null);
});
