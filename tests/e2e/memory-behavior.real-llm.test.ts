import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import {
  MemoryProposalEngine,
  MemoryRepositoryProposalStore,
} from "../../src/memory/proposal-engine.js";
import type {
  MemoryEvidenceReaderPort,
  MemoryProposalExtractionRequest,
  MemoryProposalExtractionResult,
  MemoryProposalModelPort,
  TerminalMemoryEvidenceRef,
  UserMemoryEvidence,
} from "../../src/memory/proposal-contracts.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../../src/provider/effective-model-runtime.js";
import { createProvider, type ProviderKind } from "../../src/provider/factory.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import {
  assertMemoryQualityThresholds,
  REAL_MODEL_MEMORY_QUALITY_CASES,
  scoreMemoryQuality,
  type MemoryQualityCase,
  type ScoredMemoryProposal,
} from "../fixtures/memory-quality.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_TIMEOUT_MS = 10 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;
const MODEL_CONFIG_HOME = mkdtemp(join(tmpdir(), "pico-memory-quality-real-llm-config-"));

after(async () => {
  await rm(await MODEL_CONFIG_HOME, { recursive: true, force: true });
});

interface RealModel {
  readonly runtime: EffectiveModelRuntime;
  readonly provider: ProviderKind;
  readonly config: ProviderConfig;
  readonly route: ModelRoute;
}

let realModelPromise: Promise<RealModel> | undefined;

realModelTest(
  "real model memory proposals meet the benign precision and recall baseline",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const configured = await configuredRealModel();
    const provider = createProvider(configured.provider, configured.config);
    const root = await mkdtemp(join(tmpdir(), "pico-memory-quality-real-llm-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(picoHome, { recursive: true }),
    ]);
    const paths = resolvePicoPaths(workspace, { picoHome });
    const repository = new MemoryRepository({
      databasePath: paths.workspace.memoryDatabase,
      workspaceId: paths.workspace.id,
    });
    const actual: ScoredMemoryProposal[] = [];
    const model = new RealProposalModel(provider);

    try {
      for (const qualityCase of REAL_MODEL_MEMORY_QUALITY_CASES) {
        const ref = evidenceRef(qualityCase);
        const engine = new MemoryProposalEngine({
          store: new MemoryRepositoryProposalStore(repository),
          evidenceReader: new FixedEvidenceReader(qualityCase),
          model,
        });
        const callsBefore = model.calls;
        const result = await engine.process(ref);
        assert.equal(result.status, "succeeded", qualityCase.id);
        assert.equal(
          model.calls - callsBefore,
          qualityCase.expectedModelCalls,
          `${qualityCase.id} model-call count`,
        );
        for (const stored of result.proposals) {
          actual.push({
            caseId: qualityCase.id,
            kind: stored.kind,
            content: stored.content,
            conflictStatus: stored.conflictStatus,
          });
        }
      }

      const score = scoreMemoryQuality(REAL_MODEL_MEMORY_QUALITY_CASES, actual);
      assertMemoryQualityThresholds(score, {
        minimumPrecision: 0.95,
        minimumRecall: 0.9,
        requiredCategories: ["explicit", "project_fact", "correction"],
      });
    } finally {
      repository.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

class RealProposalModel implements MemoryProposalModelPort {
  calls = 0;

  constructor(private readonly provider: LLMProvider) {}

  async extract(
    request: MemoryProposalExtractionRequest,
    signal?: AbortSignal,
  ): Promise<MemoryProposalExtractionResult> {
    this.calls++;
    const response = await this.provider.generate(
      [
        {
          role: "system",
          content:
            "Extract only durable, user-authored workspace memory. Always call submit_memory_proposals exactly once, using an empty proposals array when nothing is durable. Preserve concrete commands, paths, versions and preferences. Never invent evidence.",
        },
        {
          role: "user",
          content: `Evidence event id: ${request.evidence.eventIds[0]}\nUser-authored evidence: ${request.evidence.content}`,
        },
      ],
      [request.tool],
      { signal },
    );
    return {
      response,
      inputTokens: response.usage?.promptTokens,
      outputTokens: response.usage?.completionTokens,
      costUsd: 0,
    };
  }
}

class FixedEvidenceReader implements MemoryEvidenceReaderPort {
  constructor(private readonly qualityCase: MemoryQualityCase) {}

  async read(ref: TerminalMemoryEvidenceRef): Promise<UserMemoryEvidence> {
    return {
      ...ref,
      content: this.qualityCase.evidence.content,
      eventIds: [ref.userMessageEventId],
      startSequence: 1,
      endSequence: 1,
      terminalSequence: 2,
      digest: `sha256:${this.qualityCase.id.padEnd(64, "0").slice(0, 64)}`,
      sourceId: `quality-real-source:${this.qualityCase.id}`,
      cursor: { sessionId: ref.sessionId, sequence: 2, eventId: ref.terminalEventId },
    };
  }
}

function evidenceRef(qualityCase: MemoryQualityCase): TerminalMemoryEvidenceRef {
  return {
    sessionId: `quality-real-session:${qualityCase.id}`,
    runId: `quality-real-run:${qualityCase.id}`,
    terminalEventId: `quality-real-terminal:${qualityCase.id}`,
    userMessageEventId: `quality-real-message:${qualityCase.id}`,
  };
}

async function configuredRealModel(): Promise<RealModel> {
  realModelPromise ??= (async () => {
    const modelConfigHome = await MODEL_CONFIG_HOME;
    const userConfigStore = new UserConfigStore({ picoHome: modelConfigHome });
    const configResolver = new EffectiveConfigResolver({ userConfigStore });
    const runtime = await loadEffectiveModelRuntime({
      workDir: PROJECT_ROOT,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: process.env.LLM_MODEL?.trim() || "unused-memory-quality-legacy-route",
      legacyModelExplicit: false,
      env: process.env,
      userConfigStore,
      configResolver,
    });
    const configured = runtime.router.providerConfig(runtime.config.defaultModelRouteId);
    return { runtime, ...configured };
  })();
  return realModelPromise;
}
