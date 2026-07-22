import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
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
import { ProviderMemoryProposalModel } from "../../src/memory/worker.js";
import { resolvePicoHome, resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../../src/provider/effective-model-runtime.js";
import { createProvider, type ProviderKind } from "../../src/provider/factory.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { RunAgentCliOptions } from "../../src/runtime/runtime-contract.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
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
const MODEL_CONFIG_HOME = resolvePicoHome();

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
      try {
        assertMemoryQualityThresholds(score, {
          minimumPrecision: 0.95,
          minimumRecall: 0.9,
          requiredCategories: ["explicit", "project_fact", "correction"],
        });
      } catch (error) {
        const diagnostic = actual.map(({ caseId, kind, content, conflictStatus }) => ({
          caseId,
          kind,
          content,
          conflictStatus,
        }));
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; predictions=${JSON.stringify(diagnostic)}`,
          { cause: error },
        );
      }
    } finally {
      repository.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

realModelTest(
  "deterministic memory is recalled across sessions without review-model calls",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const configured = await configuredRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-memory-runtime-real-llm-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    const sessionIds = [
      "memory-real-runtime-a",
      "memory-real-runtime-b",
      "memory-real-runtime-disabled",
    ];
    const canary = "npm run real-reviewed-memory-canary";
    let reviewCalls = 0;
    const reviewModelFactory = () => {
      reviewCalls++;
      return {
        model: new ProviderMemoryProposalModel(
          createProvider(configured.provider, configured.config),
        ),
      };
    };
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(picoHome, { recursive: true }),
    ]);
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(await trustStore.canonicalize(workspace));

    try {
      await executeAgentRuntime(
        runtimeRequest(
          workspace,
          sessionIds[0]!,
          `请记住这个稳定的项目事实：本项目固定使用 ${canary} 验证构建。`,
          configured,
        ),
        {
          picoHome,
          memoryTrustStore: trustStore,
          provider: createProvider(configured.provider, configured.config),
          memoryProposalModelFactory: reviewModelFactory,
          memoryReviewDebounceMs: 0,
          reporter: new SilentReporter(),
        },
      );

      const pending = await waitForPendingProposal(workspace, picoHome);
      const pendingContent = pending.content;
      if (pendingContent === null) assert.fail("Real-model proposal must include content");
      assert.match(pendingContent, new RegExp(canary, "u"));
      let repository = openMemoryRepository(workspace, picoHome);
      repository.resolveProposal({
        proposalId: pending.proposalId,
        resolution: "accepted",
        expectedVersion: pending.version,
        idempotencyKey: "memory-real-runtime-accept",
        factId: "memory-real-runtime-fact",
      });
      let settings = repository.getSettings();
      repository.updateSettings({
        expectedVersion: settings.version,
        autoPropose: false,
        idempotencyKey: "memory-real-runtime-disable-proposals",
      });
      const jobsAfterReview = repository.listJobs().length;
      repository.close();

      const recalled = await executeAgentRuntime(
        runtimeRequest(
          workspace,
          sessionIds[1]!,
          "根据工作区记忆，只回答这个项目用于验证构建的完整命令。",
          configured,
        ),
        {
          picoHome,
          memoryTrustStore: trustStore,
          provider: createProvider(configured.provider, configured.config),
          memoryProposalModelFactory: reviewModelFactory,
          memoryReviewDebounceMs: 0,
          reporter: new SilentReporter(),
        },
      );
      assert.match(recalled.finalMessage, new RegExp(canary, "u"));
      assert.equal(reviewCalls, 0);

      repository = openMemoryRepository(workspace, picoHome);
      assert.equal(repository.listJobs().length, jobsAfterReview);
      settings = repository.getSettings();
      repository.updateSettings({
        expectedVersion: settings.version,
        enabled: false,
        idempotencyKey: "memory-real-runtime-disable-all",
      });
      repository.close();

      await executeAgentRuntime(
        runtimeRequest(
          workspace,
          sessionIds[2]!,
          "这是关闭记忆后的普通请求。只回答：done",
          configured,
        ),
        {
          picoHome,
          memoryTrustStore: trustStore,
          provider: createProvider(configured.provider, configured.config),
          memoryProposalModelFactory: reviewModelFactory,
          memoryReviewDebounceMs: 0,
          reporter: new SilentReporter(),
        },
      );
      assert.equal(reviewCalls, 0);
      repository = openMemoryRepository(workspace, picoHome);
      assert.equal(repository.listJobs().length, jobsAfterReview);
      repository.close();
    } finally {
      for (const sessionId of sessionIds) {
        const session = globalSessionManager.delete(sessionId, workspace, { picoHome });
        await session?.close();
      }
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

function runtimeRequest(
  workspace: string,
  sessionId: string,
  prompt: string,
  configured: RealModel,
): RunAgentCliOptions {
  return {
    prompt,
    dir: workspace,
    sessionSelection: { mode: "new", sessionId },
    provider: configured.provider,
    baseURL: configured.config.baseURL,
    apiKey: configured.config.apiKey,
    model: configured.config.model,
    modelRouteId: configured.route.id,
    modelCapabilities: configured.route.capabilities,
    allowedTools: [],
  };
}

function openMemoryRepository(workspace: string, picoHome: string): MemoryRepository {
  const paths = resolvePicoPaths(workspace, { picoHome });
  return new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
}

async function waitForPendingProposal(workspace: string, picoHome: string) {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const repository = openMemoryRepository(workspace, picoHome);
    try {
      const proposal = repository.listProposals({ statuses: ["pending"] })[0];
      if (proposal) return proposal;
      const job = repository.listJobs({ type: "terminal-extraction" })[0];
      if (job?.status === "failed") {
        throw new Error(`Memory review failed: ${job.errorCode ?? "unknown"}`);
      }
    } finally {
      repository.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for a real-model memory proposal");
}

async function configuredRealModel(): Promise<RealModel> {
  realModelPromise ??= (async () => {
    const userConfigStore = new UserConfigStore({ picoHome: MODEL_CONFIG_HOME });
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
