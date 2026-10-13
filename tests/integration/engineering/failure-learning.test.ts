import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { resolvePicoPaths } from "@pico/pico-host";
import {
  runFailureLearningExperiment,
  readFailureLearningReport,
} from "../../../scripts/eval/failure-learning.js";

for (const valid of [true, false])
  test(`failure learning ${valid ? "saves only after native validation and recalls from reopened storage" : "keeps failed candidates out of memory"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-failure-learning-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "experiment");
    const report = await runFailureLearningExperiment({
      directory,
      model: "integration-scripted",
      port: {
        async complete(messages) {
          if (messages[0]!.content.includes("Derive a narrow"))
            return JSON.stringify({
              lesson: valid
                ? "FixtureNorth's checker expects the service directory as its cwd; its config is absent from the workspace root."
                : "FixtureNorth's checker expects the workspace directory as its cwd.",
            });
          return JSON.stringify({
            cwd:
              valid &&
              messages.some(({ content }) => content.includes("Experimental project knowledge:"))
                ? "service"
                : "workspace",
          });
        },
        async freshSession(input) {
          assert.equal(valid, true, "rejected candidates must never reach a fresh session");
          const store = new SqliteMemoryItemStore(join(input.picoHome, "memory.sqlite"));
          try {
            const key = resolvePicoPaths(input.workDir, { picoHome: input.picoHome }).workspace.id;
            const result = await new AtomicMemoryContextBuilder(store, key).build(input.prompt);
            const memoryDelivered = result.block.includes("Experimental lesson for FixtureNorth");
            if (memoryDelivered) assert.ok(result.block.includes('source="manual"'));
            return {
              content: JSON.stringify({ cwd: memoryDelivered ? "service" : "workspace" }),
              memoryDelivered,
              modelCalls: 0,
            };
          } finally {
            store.close();
          }
        },
      },
    });
    assert.equal(report.status, valid ? "learned" : "rejected");
    assert.equal(report.trials[0]!.exitCode, 1);
    assert.deepEqual(await readFailureLearningReport(directory), report);
    const store = new SqliteMemoryItemStore(join(directory, "home", "memory.sqlite"));
    try {
      const key = resolvePicoPaths(join(directory, "workspace"), {
        picoHome: join(directory, "home"),
      }).workspace.id;
      const items = await store.listItems({ workspaceKey: key });
      assert.equal(items.length, valid ? 1 : 0);
      if (valid) {
        assert.equal(report.candidates[0]!.trials.length, 3);
        assert.ok(report.candidates[0]!.trials.every(({ passed }) => passed));
        assert.equal(items[0]!.item.kind, "failure");
        assert.deepEqual(items[0]!.sources, [], "execution observations are not user citations");
        assert.equal(report.memoryDelivered, true);
        assert.equal(report.scopeIsolated, true);
        assert.ok(report.trials.slice(-2).every(({ passed }) => passed));
      } else assert.ok(report.candidates.every(({ accepted }) => !accepted));
    } finally {
      store.close();
    }
  });
