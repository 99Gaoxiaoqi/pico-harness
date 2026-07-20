import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopMemoryService } from "../../src/daemon/desktop-memory-service.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import {
  MemoryProposalEngine,
  MemoryRepositoryProposalStore,
} from "../../src/memory/proposal-engine.js";
import type {
  MemoryProposalExtractionRequest,
  MemoryProposalExtractionResult,
  MemoryProposalModelPort,
  RawMemoryProposalCandidate,
  TerminalMemoryEvidenceRef,
} from "../../src/memory/proposal-contracts.js";
import { MEMORY_PROPOSAL_TOOL } from "../../src/memory/proposal-parser.js";
import {
  RuntimeMemoryEvidenceReader,
  type RuntimeEvidenceStorePort,
} from "../../src/memory/runtime-evidence-reader.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { Message } from "../../src/schema/message.js";
import type { RuntimeEventStoreEntry } from "../../src/storage/runtime-event-store.js";
import {
  assertMemoryQualityThresholds,
  MEMORY_QUALITY_CASES,
  scoreMemoryQuality,
  type MemoryQualityCandidate,
  type MemoryQualityCase,
  type ScoredMemoryProposal,
} from "../fixtures/memory-quality.js";

const MODEL_USAGE = { inputTokens: 12, outputTokens: 5, costUsd: 0.001 } as const;

test("memory quality corpus meets precision, recall and zero sensitive-misstore gates", async () => {
  const fixture = await createFixture("corpus");
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const actual: ScoredMemoryProposal[] = [];
  const sensitiveCanaries = MEMORY_QUALITY_CASES.flatMap(
    (qualityCase) => qualityCase.sensitiveCanaries ?? [],
  );

  try {
    assert.ok(MEMORY_QUALITY_CASES.length >= 20);
    assert.deepEqual(
      new Set(
        MEMORY_QUALITY_CASES.filter((qualityCase) =>
          [
            "explicit",
            "one_time",
            "assistant_hallucination",
            "tool_output",
            "secret",
            "pii",
            "injection",
            "conflict",
          ].includes(qualityCase.category),
        ).map((qualityCase) => qualityCase.category),
      ),
      new Set([
        "explicit",
        "one_time",
        "assistant_hallucination",
        "tool_output",
        "secret",
        "pii",
        "injection",
        "conflict",
      ]),
    );

    for (const qualityCase of MEMORY_QUALITY_CASES) {
      for (const fact of qualityCase.seedFacts ?? []) {
        fixture.repository.createFact(fact);
      }
      const model = new FixedProposalModel(qualityCase.candidates);
      const ref = evidenceRef(qualityCase);
      const engine = new MemoryProposalEngine({
        store: new MemoryRepositoryProposalStore(fixture.repository),
        evidenceReader: evidenceReader(qualityCase, ref),
        model,
      });
      const result = await engine.process(ref);

      assert.equal(model.calls.length, qualityCase.expectedModelCalls, qualityCase.id);
      if (qualityCase.evidence.role === "assistant" || qualityCase.evidence.toolCallId) {
        assert.equal(result.status, "retryable_failure", qualityCase.id);
      } else {
        assert.equal(result.status, "succeeded", qualityCase.id);
      }
      if (result.job) {
        assert.equal(
          result.job.inputTokens,
          qualityCase.expectedModelCalls ? MODEL_USAGE.inputTokens : 0,
        );
        assert.equal(
          result.job.outputTokens,
          qualityCase.expectedModelCalls ? MODEL_USAGE.outputTokens : 0,
        );
        assert.equal(result.job.costUsd, qualityCase.expectedModelCalls ? MODEL_USAGE.costUsd : 0);
      }
      for (const stored of result.proposals) {
        actual.push({
          caseId: qualityCase.id,
          kind: stored.kind,
          content: stored.content,
          conflictStatus: stored.conflictStatus,
        });
      }
    }

    const score = scoreMemoryQuality(MEMORY_QUALITY_CASES, actual);
    assertMemoryQualityThresholds(score, {
      minimumPrecision: 0.95,
      minimumRecall: 0.9,
      requiredCategories: ["explicit", "project_fact", "correction"],
    });
    assert.equal(score.precision, 1);
    assert.equal(score.recall, 1);
    assert.throws(
      () => assertMemoryQualityThresholds(scoreMemoryQuality([], [])),
      /precision is undefined/u,
    );

    assertNoSensitiveCanaries(
      "repository-before-api",
      repositorySnapshot(fixture.repository),
      sensitiveCanaries,
    );
    await assertNoSensitiveDatabaseFiles(paths.workspace.memoryDatabase, sensitiveCanaries);
    fixture.repository.close();

    const notifications: unknown[] = [];
    const service = new DesktopMemoryService({
      picoHome: fixture.picoHome,
      publish: (workspacePath, topic, payload) =>
        notifications.push({ workspacePath, topic, payload }),
    });
    const apiResults: unknown[] = [];
    try {
      const reviews = service.listReviews(fixture.workspace, {
        workspacePath: fixture.workspace,
        statuses: ["pending"],
      });
      apiResults.push(reviews);
      for (const proposal of reviews.proposals.filter((item) =>
        item.reason?.startsWith("[SAFETY_REVIEW_REQUIRED]"),
      )) {
        apiResults.push(
          service.resolveReview(fixture.workspace, {
            workspacePath: fixture.workspace,
            proposalId: proposal.proposalId,
            resolution: "accepted",
            expectedVersion: proposal.version,
            idempotencyKey: `quality-accept:${proposal.proposalId}`,
            factId: `quality-fact:${proposal.proposalId}`,
          }),
        );
      }
      apiResults.push(
        service.list(fixture.workspace, { workspacePath: fixture.workspace }),
        service.previewContext(fixture.workspace, { workspacePath: fixture.workspace }),
        service.getSettings(fixture.workspace),
      );
    } finally {
      service.close();
    }
    assertNoSensitiveCanaries("desktop-api", apiResults, sensitiveCanaries);
    assertNoSensitiveCanaries("desktop-notifications", notifications, sensitiveCanaries);

    const inspection = new MemoryRepository({
      databasePath: paths.workspace.memoryDatabase,
      workspaceId: paths.workspace.id,
    });
    try {
      assertNoSensitiveCanaries(
        "repository-after-api",
        repositorySnapshot(inspection),
        sensitiveCanaries,
      );
    } finally {
      inspection.close();
    }

    await assertNoSensitiveDatabaseFiles(paths.workspace.memoryDatabase, sensitiveCanaries);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("disabled and autoPropose=false create no jobs and make no proposal-model calls", async () => {
  const fixture = await createFixture("disabled");
  try {
    const model = new FixedProposalModel([
      {
        kind: "preference",
        title: "Language",
        content: "Reply in Chinese",
        reason: "Explicit preference",
      },
    ]);
    const disabled = fixture.repository.updateSettings({
      expectedVersion: fixture.repository.getSettings().version,
      idempotencyKey: "quality-disable-memory",
      enabled: false,
    });
    const disabledCase = MEMORY_QUALITY_CASES.find(
      (qualityCase) => qualityCase.id === "explicit-zh-language",
    );
    assert.ok(disabledCase);
    const disabledRef = evidenceRef({ ...disabledCase, id: "disabled-setting" });
    const engine = new MemoryProposalEngine({
      store: new MemoryRepositoryProposalStore(fixture.repository),
      evidenceReader: evidenceReader(disabledCase, disabledRef),
      model,
    });
    assert.deepEqual(await engine.process(disabledRef), { status: "disabled", proposals: [] });
    assert.equal(model.calls.length, 0);
    assert.equal(fixture.repository.listJobs().length, 0);

    fixture.repository.updateSettings({
      expectedVersion: disabled.version,
      idempotencyKey: "quality-disable-auto-propose",
      enabled: true,
      autoPropose: false,
    });
    const autoProposeRef = evidenceRef({ ...disabledCase, id: "auto-propose-setting" });
    assert.deepEqual(await engine.process(autoProposeRef), { status: "disabled", proposals: [] });
    assert.equal(model.calls.length, 0);
    assert.equal(fixture.repository.listJobs().length, 0);
  } finally {
    fixture.repository.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

class FixedProposalModel implements MemoryProposalModelPort {
  readonly calls: MemoryProposalExtractionRequest[] = [];

  constructor(private readonly candidates: readonly MemoryQualityCandidate[]) {}

  async extract(request: MemoryProposalExtractionRequest): Promise<MemoryProposalExtractionResult> {
    this.calls.push(request);
    return {
      response: toolResponse(
        this.candidates.map((candidate) => ({
          ...candidate,
          confidence: candidate.confidence ?? 0.95,
          evidenceEventIds: [request.evidence.eventIds[0]!],
        })),
      ),
      ...MODEL_USAGE,
    };
  }
}

function toolResponse(candidates: readonly RawMemoryProposalCandidate[]): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "memory-quality-proposals",
        name: MEMORY_PROPOSAL_TOOL.name,
        arguments: JSON.stringify({ proposals: candidates }),
      },
    ],
  };
}

function evidenceRef(qualityCase: Pick<MemoryQualityCase, "id">): TerminalMemoryEvidenceRef {
  return {
    sessionId: `quality-session:${qualityCase.id}`,
    runId: `quality-run:${qualityCase.id}`,
    terminalEventId: `quality-terminal:${qualityCase.id}`,
    userMessageEventId: `quality-message:${qualityCase.id}`,
  };
}

function evidenceReader(
  qualityCase: MemoryQualityCase,
  ref: TerminalMemoryEvidenceRef,
): RuntimeMemoryEvidenceReader {
  const terminal = runtimeEntry(2, {
    ...runtimeEventBase(ref, ref.terminalEventId, "internal"),
    kind: "run.terminal",
    data: { status: "completed" },
  });
  const message: Message = {
    role: qualityCase.evidence.role,
    content: qualityCase.evidence.content,
    ...(qualityCase.evidence.toolCallId ? { toolCallId: qualityCase.evidence.toolCallId } : {}),
  };
  const user = runtimeEntry(1, {
    ...runtimeEventBase(ref, ref.userMessageEventId, "model"),
    kind: "message.committed",
    data: { message },
  });
  return new RuntimeMemoryEvidenceReader(runtimeEvidenceStore([terminal, user]));
}

function runtimeEventBase(
  ref: TerminalMemoryEvidenceRef,
  eventId: string,
  visibility: "model" | "internal",
) {
  return {
    schemaVersion: 1 as const,
    eventId,
    sessionId: ref.sessionId,
    invocationId: `quality-invocation:${ref.runId}`,
    runId: ref.runId,
    turnId: `quality-turn:${ref.runId}`,
    at: "2026-07-20T00:00:00.000Z",
    partial: false,
    visibility,
  };
}

function runtimeEntry(sequence: number, event: RuntimeEvent): RuntimeEventStoreEntry {
  return { sequence, event };
}

function runtimeEvidenceStore(
  entries: readonly RuntimeEventStoreEntry[],
): RuntimeEvidenceStorePort {
  const byId = new Map(entries.map((entry) => [entry.event.eventId, entry]));
  return {
    async readSessionEvent(_sessionId, eventId) {
      return byId.get(eventId);
    },
  };
}

function repositorySnapshot(repository: MemoryRepository): unknown {
  return {
    facts: repository.listFacts({ limit: 500 }),
    proposals: repository.listProposals({ limit: 500 }),
    mutations: repository.listMutations({ limit: 500 }),
    sources: repository.listSources(500),
    jobs: repository.listJobs({ limit: 500 }),
    settings: repository.getSettings(),
  };
}

function assertNoSensitiveCanaries(
  location: string,
  value: unknown,
  canaries: readonly string[],
): void {
  const encoded = JSON.stringify(value);
  for (const canary of canaries) {
    assert.equal(
      encoded.includes(canary),
      false,
      `${location} retained sensitive canary ${canary}`,
    );
  }
}

function assertNoSensitiveBytes(
  location: string,
  bytes: Buffer,
  canaries: readonly string[],
): void {
  for (const canary of canaries) {
    assert.equal(
      bytes.includes(Buffer.from(canary)),
      false,
      `${location} retained sensitive canary ${canary}`,
    );
  }
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertNoSensitiveDatabaseFiles(
  databasePath: string,
  canaries: readonly string[],
): Promise<void> {
  for (const databaseFile of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const bytes = await readIfExists(databaseFile);
    if (bytes) assertNoSensitiveBytes(databaseFile, bytes, canaries);
  }
}

async function createFixture(label: string): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly repository: MemoryRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-quality-${label}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const paths = resolvePicoPaths(workspace, { picoHome });
  return {
    root,
    workspace,
    picoHome,
    repository: new MemoryRepository({
      databasePath: paths.workspace.memoryDatabase,
      workspaceId: paths.workspace.id,
    }),
  };
}
