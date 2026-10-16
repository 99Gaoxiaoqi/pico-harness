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

test("v3 negotiates case policy and exact feedback while preserving strict legacy envelopes", () => {
  assert.equal(
    parseStrictRuntimeParams("memory.learning.query", {
      workspacePath: "/ws",
      learningVersion: 3,
      representation: "case",
      usagePolicy: "case_only",
    }).learningVersion,
    3,
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.learning.query", {
      workspacePath: "/ws",
      representation: "case",
    }),
  );
  const review = {
    workspacePath: "/ws",
    candidateId: "c",
    expectedRecordRevision: 1,
    expectedContentVersion: 1,
    operationId: "edit",
    action: "revise",
    content: "有来源的建议",
  };
  assert.throws(() => parseStrictRuntimeParams("memory.learning.review", review));
  assert.equal(
    parseStrictRuntimeParams("memory.learning.review", { ...review, learningVersion: 3 }).action,
    "revise",
  );
  assert.throws(() =>
    parseStrictRuntimeParams("memory.learning.review", {
      ...review,
      learningVersion: 3,
      requiredConditions: [{ kind: "arbitrary", allow: true }],
    }),
  );
  const feedback = {
    workspacePath: "/ws",
    useId: "use",
    expectedItemVersion: 1,
    operationId: "helpful",
    action: "helpful",
  };
  assert.throws(() => parseStrictRuntimeParams("memory.experience.feedback", feedback));
  assert.equal(
    parseStrictRuntimeParams("memory.experience.feedback", {
      ...feedback,
      learningVersion: 3,
      expectedContentVersion: 1,
    }).action,
    "helpful",
  );
  const candidate = {
    candidateId: "c",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    kind: "task-lesson",
    lifecycleState: "active",
    taskId: "t",
    taskVersion: 1,
    workspaceKey: "ws",
    workDir: "/ws",
    sessionId: "s",
    runId: "r",
    failureKey: "f",
    inputEpoch: 1,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "ready",
    goal: "g",
    content: "只记录已发生的过程",
    sources: [],
    observationIds: [],
    createdAt: 1,
    updatedAt: 1,
    representation: "case",
    usagePolicy: "case_only",
    matchHints: [],
    requiredConditions: [],
  };
  const envelope = {
    learningVersion: 3,
    workspaceKey: "ws",
    revision: 1,
    items: [candidate],
    reuse: [],
    receipts: [{ operationId: "receipt", sessionId: "s", committedAt: 1, createdItemCount: 2 }],
  };
  assert.equal(
    parseRuntimeResult("memory.learning.query", envelope).items[0]?.representation,
    "case",
  );
  assert.throws(() =>
    parseRuntimeResult("memory.learning.query", { ...envelope, learningVersion: 2 }),
  );
  assert.throws(() =>
    parseRuntimeResult("memory.learning.query", {
      ...envelope,
      items: [{ ...candidate, nativeEvidence: { claimHash: "private" } }],
    }),
  );
});
