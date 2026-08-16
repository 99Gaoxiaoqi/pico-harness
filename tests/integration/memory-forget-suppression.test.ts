import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import {
  MemoryProposalEngine,
  MemoryRepositoryProposalStore,
} from "../../src/memory/proposal-engine.js";
import {
  MEMORY_PROPOSAL_JOB_TYPE,
  type MemoryProposalModelPort,
} from "../../src/memory/proposal-contracts.js";
import { RuntimeMemoryEvidenceReader } from "../../src/memory/runtime-evidence-reader.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";

// D11 forget 复活链收口：forgetFact 后账本仍保留原始证据（append-only），
// 同证据重提取（extractor 版本升级模拟派生重建补 Job 的复活路径）必须在
// 模型调用前被 Source.extractionSuppressedAt 抑制——不建提案、Job 取消、
// 已遗忘内容绝不以新 Fact 回流。
test("forgetFact 抑制同证据重提取：Job 取消、零模型调用、无新 Fact 回流", async (context) => {
  const fixture = await createFixture("forget-suppression");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const sessionId = "forget-suppression-session";
  const runId = "run-forget-suppression";
  const at = "2026-08-17T00:00:00.000Z";
  const userMessageEventId = "forget-suppression-user";
  const terminalEventId = "forget-suppression-terminal";

  await appendCompletedRun(
    paths,
    fixture.workspace,
    sessionId,
    runId,
    userMessageEventId,
    terminalEventId,
    at,
  );

  const repository = new MemoryRepository({
    storageRoot: paths.workspace.memory,
    workspaceId: paths.workspace.id,
  });
  repository.updateSettings({
    expectedVersion: repository.getSettings().version,
    enabled: true,
    autoPropose: true,
    autoCommit: true,
    injectionEnabled: true,
    idempotencyKey: "forget-suppression-enable",
  });

  // 第一轮：正常提取 → autoCommit 落 Fact（带 sourceId）。
  let modelCalls = 0;
  const engine = (extractorVersion: string) =>
    new MemoryProposalEngine({
      store: new MemoryRepositoryProposalStore(repository),
      evidenceReader: new RuntimeMemoryEvidenceReader(
        new RuntimeEventStore({ storageRoot: paths.workspace.root }),
      ),
      model: countingModel(() => modelCalls++),
      extractorVersion,
    });

  const ref = {
    sessionId,
    runId,
    terminalEventId,
    userMessageEventId,
  };
  const first = await engine("forget-suppression-v1").process(ref);
  assert.equal(first.status, "succeeded");
  assert.equal(modelCalls, 1);

  const facts = repository.listFacts({ states: ["active"], limit: 10 });
  assert.equal(facts.length, 1);
  const fact = facts[0]!;
  assert.ok(fact.sourceId, "autoCommit 路径的 Fact 必须携带 Source 溯源");
  assert.equal(repository.listProposals({ statuses: ["pending"], limit: 10 }).length, 0);

  // 遗忘：tombstone + Source 提取抑制标记（同一事务）。
  const forgotten = repository.forgetFact({
    factId: fact.factId,
    expectedVersion: fact.version,
  });
  assert.equal(forgotten.state, "forgotten");
  const source = repository.getSource(fact.sourceId!);
  assert.ok(source?.extractionSuppressedAt, "forgetFact 必须在 Source 上落提取抑制标记");

  // 第二轮：同证据、新 extractor 版本（模拟版本升级/派生重建补 Job 的复活路径）。
  const second = await engine("forget-suppression-v2").process(ref);
  assert.equal(second.status, "suppressed");
  assert.equal(modelCalls, 1, "抑制路径不得调用模型");
  const jobV2 = repository.listJobs({
    type: MEMORY_PROPOSAL_JOB_TYPE,
    extractorVersion: "forget-suppression-v2",
    limit: 10,
  })[0]!;
  assert.ok(jobV2, "版本升级会为新 extractorVersion 建 Job");
  assert.equal(jobV2.status, "cancelled");
  assert.equal(jobV2.errorCode, "memory_source_suppressed");

  // 复活链断言：不回流。
  assert.equal(
    repository.listFacts({ states: ["active"], limit: 10 }).length,
    0,
    "已遗忘内容不得以新 Fact 回流",
  );
  assert.equal(repository.listProposals({ statuses: ["pending"], limit: 10 }).length, 0);
  repository.close();
});

async function appendCompletedRun(
  paths: ReturnType<typeof resolvePicoPaths>,
  workDir: string,
  sessionId: string,
  runId: string,
  userMessageEventId: string,
  terminalEventId: string,
  at: string,
): Promise<void> {
  const store = new RuntimeEventStore({ storageRoot: paths.workspace.root });
  await store.initializeSession({ sessionId, workDir });
  await store.appendBatch([
    {
      schemaVersion: 2,
      eventId: userMessageEventId,
      sessionId,
      invocationId: `invocation-${runId}`,
      runId,
      turnId: `turn-${runId}`,
      at,
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: {
        message: { role: "user", content: "请记住：这个项目固定使用 npm run forget-suppression 构建。" },
      },
    },
    {
      schemaVersion: 2,
      eventId: terminalEventId,
      sessionId,
      invocationId: `invocation-${runId}`,
      runId,
      turnId: `turn-${runId}`,
      at,
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);
  store.close();
}

function countingModel(onExtract: () => void): MemoryProposalModelPort {
  return {
    async extract(request) {
      onExtract();
      // 提取协议是 JSON-content（a19ba2cd 起，非 tool-call）。
      return {
        response: {
          role: "assistant",
          content: JSON.stringify({
            proposals: [
              {
                kind: "project_fact",
                title: "Build command",
                content: "Use npm run forget-suppression",
                reason: "The user explicitly stated a stable project command.",
                confidence: 0.99,
                evidenceEventIds: [request.evidence.userMessageEventId],
              },
            ],
          }),
        },
      };
    },
  };
}

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  return { root, workspace, picoHome };
}
