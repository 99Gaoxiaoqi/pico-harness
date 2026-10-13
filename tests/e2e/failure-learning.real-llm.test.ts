import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRealFailureLearningExperiment } from "../../scripts/eval/failure-learning-real-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "real model learns a verified directory lesson and reuses it in a new Pico session without crossing workspace scope",
  { timeout: 8 * 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-failure-learning-real-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const report = await runRealFailureLearningExperiment(join(root, "experiment"));
    assert.equal(report.status, "learned", JSON.stringify(report));
    assert.equal(report.trials[0]!.exitCode, 1);
    assert.equal(report.candidates.filter(({ accepted }) => accepted).length, 1);
    assert.equal(report.memoryDelivered, true);
    assert.equal(report.scopeIsolated, true);
    assert.ok(report.trials.slice(-2).every(({ passed }) => passed));
  },
);
