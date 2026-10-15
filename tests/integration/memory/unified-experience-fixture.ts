import assert from "node:assert/strict";
import { configureExecutionLearningHost } from "../../../packages/pico-host/dist/execution-learning-host.js";
import type { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

export function configureReviewedFixture(picoHome: string, content: string): void {
  configureExecutionLearningHost(picoHome, {
    modelFactory: async () => ({
      model: {
        call: async ({ prompt }) => {
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
          return JSON.stringify({
            content,
            applicability: {
              taskFamily: "coding",
              toolNames: ["bash", "write_file"],
              conditions: [],
            },
            evidenceIds: input.evidence.map((entry: { evidenceId: string }) => entry.evidenceId),
          });
        },
      },
    }),
  });
}

export async function approveReviewedFixture(store: SqliteMemoryItemStore, workspaceKey: string) {
  const candidates = await store.taskExperiences.queryTaskExperiences(workspaceKey, {});
  assert.equal(
    candidates.length,
    1,
    JSON.stringify(await store.taskExperiences.queryTaskExperiences(workspaceKey)),
  );
  const candidate = candidates[0]!;
  assert.ok(
    candidate.nativeEvidence,
    "Host must associate canonical failure with its frozen native claim",
  );
  assert.equal(
    (await store.listItems({ workspaceKey, learningVersion: 2 })).length,
    candidate.maturity === "trial" ? 1 : 0,
    "low-risk trials publish restricted hints; risky proposals still require review",
  );
  const accepted = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: candidate.candidateId,
    expectedRecordRevision: candidate.recordRevision,
    expectedContentVersion: candidate.contentVersion,
    operationId: `approve:${candidate.candidateId}`,
    action: "accept",
    now: Date.now(),
  });
  assert.ok(accepted.itemId);
  return accepted;
}
