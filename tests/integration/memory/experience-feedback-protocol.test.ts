import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStrictRuntimeParams,
  parseRuntimeResult,
  isRuntimeMethod,
  DESKTOP_RUNTIME_METHODS,
} from "@pico/protocol";
import type { ExperienceUse } from "@pico/core";
const use: ExperienceUse = {
  useId: "use",
  workspaceKey: "ws",
  source: {
    kind: "execution-validated",
    candidateId: "native",
    claimRevision: 2,
    claimHash: "a".repeat(64),
    scopeHash: "b".repeat(64),
  },
  itemId: "item",
  itemVersion: 1,
  contentHash: "c".repeat(64),
  taskId: "task",
  taskVersion: 1,
  sessionId: "session",
  runId: "run",
  referenceHash: "d".repeat(64),
  delivery: "pending",
  historical: false,
  managementRevision: 0,
  settingsVersion: 1,
  deletionRevision: 0,
  adoption: "unknown",
  validation: "unknown",
  validationScope: "unknown",
  excluded: false,
  deleted: false,
  sources: [],
  createdAt: 1,
  updatedAt: 1,
};
test("experience capability methods have strict source identities and no model approval endpoint", () => {
  for (const method of [
    "memory.experience.query",
    "memory.experience.detail",
    "memory.experience.feedback",
  ] as const)
    assert.equal(DESKTOP_RUNTIME_METHODS.includes(method), true);
  assert.equal(isRuntimeMethod("memory.experience.approve"), false);
  assert.deepEqual(
    parseRuntimeResult("memory.experience.detail", { experienceVersion: 1, use, effects: [] }).use
      .source,
    use.source,
  );
  assert.throws(() =>
    parseRuntimeResult("memory.experience.detail", {
      experienceVersion: 1,
      use: { ...use, source: { kind: "user-evidence", candidateId: "native" } },
      effects: [],
    }),
  );
  assert.throws(() =>
    parseRuntimeResult("memory.learning.query", {
      learningVersion: 2,
      workspaceKey: "ws",
      revision: 1,
      items: [],
      reuse: [use],
    }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.experience.feedback", {
      workspacePath: "/ws",
      useId: "use",
      expectedItemVersion: 1,
      operationId: "op",
      action: "accept",
    }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.experience.query", { workspacePath: "/ws", limit: 101 }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.experience.query", {
      workspacePath: "/ws",
      learningVersion: 2,
    }),
  );
});

test("retired experience keeps the historical wire shape without introducing a write or approval endpoint", () => {
  const retired: ExperienceUse = {
    ...use,
    source: {
      kind: "execution-evidence",
      candidateId: "retired",
      candidateVersion: 3,
      contentHash: "c".repeat(64),
    },
    deleted: true,
    historical: true,
    delivery: "unknown",
    sources: [],
  };
  const result = parseRuntimeResult("memory.experience.detail", {
    experienceVersion: 1,
    use: retired,
    effects: [],
  });
  assert.deepEqual(result.use, retired);
  assert.equal(result.use.referenceContent, undefined);
  assert.equal(isRuntimeMethod("memory.experience.restore"), false);
  // Older Host replies still parse; the renderer presents this source as unavailable.
  assert.equal(
    parseRuntimeResult("memory.experience.detail", {
      experienceVersion: 1,
      use: { ...retired, deleted: false },
      effects: [],
    }).use.deleted,
    false,
  );
});
