import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeMemoryEvidenceReader } from "../../src/memory/runtime-evidence-reader.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { MemoryProposalEngine, MemoryRepositoryProposalStore } from "../../src/memory/proposal-engine.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { validateEvidenceRef } from "../../src/engine/evidence-ref.js";
import type {
  MemoryProposalModelPort,
  MemoryProposalExtractionRequest,
  MemoryProposalExtractionResult,
  TerminalMemoryEvidenceRef,
} from "../../src/memory/proposal-contracts.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";

/**
 * 窄路径集成测试：验证 EvidenceRef overlay 从 RuntimeEventStore →
 * RuntimeMemoryEvidenceReader.read() → MemoryProposalEngine → Source 落盘的完整贯通。
 */
test("EvidenceRef overlay 从事件账本到 Source 落盘端到端贯通", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-evidence-ref-pipeline-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const picoHome = join(root, "pico-home");
  const paths = resolvePicoPaths(workspace, { picoHome });

  const sessionId = "evidence-ref-pipeline-session";
  const runId = "evidence-ref-pipeline-run";
  const invocationId = "inv-1";
  const turnId = "turn-1";

  try {
    // 1. 写入真实 RuntimeEvent 到 RuntimeEventStore
    const eventStore = new RuntimeEventStore({ storageRoot: root });
    await eventStore.initializeSession({ sessionId, workDir: workspace });

    const userMessageEventId = "evt-user-msg-001";
    const terminalEventId = "evt-terminal-001";

    const userMessageEvent: RuntimeEvent = {
      schemaVersion: 2,
      eventId: userMessageEventId,
      sessionId,
      invocationId,
      runId,
      turnId,
      at: "2026-08-10T00:00:00.000Z",
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "请记住：本项目用 pico-marker 验证溯源。" } },
    } as RuntimeEvent;

    const terminalEvent: RuntimeEvent = {
      schemaVersion: 2,
      eventId: terminalEventId,
      sessionId,
      invocationId,
      runId,
      turnId,
      at: "2026-08-10T00:00:01.000Z",
      partial: false,
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    } as RuntimeEvent;

    await eventStore.appendBatch([userMessageEvent, terminalEvent]);

    // 2. 用真实 RuntimeMemoryEvidenceReader 读取
    const reader = new RuntimeMemoryEvidenceReader(eventStore);
    const ref: TerminalMemoryEvidenceRef = {
      sessionId,
      runId,
      terminalEventId,
      userMessageEventId,
    };
    const evidence = await reader.read(ref);

    // 3. 核心断言：evidence 持有 evidenceRef overlay
    assert.ok(evidence.evidenceRef, "UserMemoryEvidence must carry evidenceRef");
    const validation = validateEvidenceRef(evidence.evidenceRef);
    assert.equal(validation.ok, true, "evidenceRef must be valid");
    if (validation.ok) {
      assert.equal(validation.ref.coverage!.ledger, "session_runtime_event");
      assert.equal(validation.ref.coverage!.streamId, sessionId);
      assert.deepEqual(validation.ref.coverage!.eventIds, [userMessageEventId]);
      assert.equal(validation.ref.coverage!.eventCount, 1);
    }

    // 4. 通过 proposal-engine 落盘 Source
    const repository = new MemoryRepository({
      storageRoot: paths.workspace.memory,
      workspaceId: paths.workspace.id,
    });
    repository.updateSettings({
      expectedVersion: repository.getSettings().version,
      autoCommit: true,
      idempotencyKey: "pipeline-test-autocommit",
    });

    const stubModel: MemoryProposalModelPort = {
      async extract(request: MemoryProposalExtractionRequest): Promise<MemoryProposalExtractionResult> {
        return {
          response: {
            role: "assistant",
            content: JSON.stringify({
              proposals: [
                {
                  kind: "project_fact",
                  title: "溯源标记",
                  content: "本项目用 pico-marker 验证溯源。",
                  reason: "用户明确陈述",
                  confidence: 0.95,
                  evidenceEventIds: request.evidence.eventIds,
                },
              ],
            }),
          },
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.001,
        };
      },
    };

    const engine = new MemoryProposalEngine({
      store: new MemoryRepositoryProposalStore(repository),
      evidenceReader: reader,
      model: stubModel,
    });

    const result = await engine.process(ref);
    assert.equal(result.status, "succeeded");

    // 5. 核心断言：落盘的 Source 持有 evidenceRef
    const sources = repository.listSources();
    assert.equal(sources.length, 1);
    const source = sources[0]!;
    assert.ok(source.evidenceRef, "persisted Source must carry evidenceRef");

    const sourceValidation = validateEvidenceRef(source.evidenceRef);
    assert.equal(sourceValidation.ok, true, "persisted Source.evidenceRef must be valid");
    if (sourceValidation.ok) {
      assert.equal(sourceValidation.ref.sessionId, sessionId);
      assert.equal(sourceValidation.ref.runId, runId);
      assert.equal(sourceValidation.ref.coverage!.streamId, sessionId);
    }

    repository.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertSource soft 降级：损坏的 evidenceRef 被剥离，Source 仍能正常加载", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), "pico-evidence-ref-degrade-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const picoHome = join(root, "pico-home");
  const paths = resolvePicoPaths(workspace, { picoHome });

  try {
    // 1. 正常创建一个 Source（带合法 evidenceRef）
    const repository = new MemoryRepository({
      storageRoot: paths.workspace.memory,
      workspaceId: paths.workspace.id,
    });
    repository.createSource({
      sourceId: "source:degrade-test",
      sessionId: "degrade-session",
      runId: "degrade-run",
      eventIds: ["evt-1"],
      digest: "sha256:abc",
      evidenceRef: {
        schemaVersion: "pico.evidence_ref.v1" as const,
        sessionId: "degrade-session",
        runId: "degrade-run",
        coverage: {
          ledger: "session_runtime_event",
          streamId: "degrade-session",
          highSequence: 1,
          eventIds: ["evt-1"],
          eventCount: 1,
        },
        digest: "sha256:abc",
      },
      idempotencyKey: "degrade-test-create",
    });
    repository.close();

    // 2. 手动篡改 state.json 里的 evidenceRef（破坏 schemaVersion）
    const statePath = join(paths.workspace.memory, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const sources = raw.sources as Record<string, Record<string, unknown>>;
    (sources["source:degrade-test"]!.evidenceRef as Record<string, unknown>)["schemaVersion"] = "pico.evidence_ref.v999";
    writeFileSync(statePath, JSON.stringify(raw, null, 2));

    // 3. 重新打开——assertSource 应 soft 降级（剥离 evidenceRef），不 throw
    const repo2 = new MemoryRepository({
      storageRoot: paths.workspace.memory,
      workspaceId: paths.workspace.id,
    });
    const source = repo2.getSource("source:degrade-test");
    assert.ok(source, "Source must still load after evidenceRef degradation");
    assert.equal(source!.evidenceRef, undefined, "corrupted evidenceRef must be stripped");
    // 其他字段完好
    assert.equal(source!.sessionId, "degrade-session");
    assert.equal(source!.digest, "sha256:abc");
    repo2.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
