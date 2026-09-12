import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createProductionRuntimeServices } from "../../../src/daemon/production-host.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import {
  AgentRuntime,
  type RunAgentCliOptions,
  type RunAgentCliDependencies,
} from "../../../src/runtime/agent-runtime.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { memorySessionKey } from "../../../src/memory/atomic/runtime-contracts.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "production shutdown waits for background memory and disposal after the foreground completes",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-memory-host-"));
    const picoHome = join(root, "home");
    await mkdir(join(root, "workspace"));
    const workspacePath = await realpath(join(root, "workspace"));
    await writeDesktopModelRouting(picoHome);
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(workspacePath);
    const entered = Promise.withResolvers<void>();
    const modelRelease = Promise.withResolvers<void>();
    const disposing = Promise.withResolvers<void>();
    const disposeRelease = Promise.withResolvers<void>();
    let residencies = 0;
    let acquisitions = 0;
    let modelCalls = 0;
    const services = createProductionRuntimeServices({
      env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" },
      trustStore,
      acquireMemoryResidency: () => {
        acquisitions++;
        residencies++;
        return {
          release: () => {
            residencies--;
          },
        };
      },
      agentRuntime: new (class extends AgentRuntime {
        override execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
          let calls = 0;
          return super.execute(options, {
            ...dependencies,
            provider: {
              async generate() {
                return calls++ === 0
                  ? {
                      role: "assistant" as const,
                      content: "",
                      toolCalls: [{ id: "extract", name: "memory_extract", arguments: "{}" }],
                    }
                  : { role: "assistant" as const, content: "收到。" };
              },
            },
            atomicMemoryModelFactory: async () => ({
              model: {
                async call() {
                  modelCalls++;
                  entered.resolve();
                  await modelRelease.promise;
                  return JSON.stringify({
                    status: "complete",
                    coverageStatus: "processed",
                    requestedStatus: "resolved",
                    requestedItems: [],
                    incidentalItems: [],
                  });
                },
              },
              async dispose() {
                disposing.resolve();
                await disposeRelease.promise;
              },
            }),
          });
        }
      })(),
    });
    t.after(async () => {
      modelRelease.resolve();
      disposeRelease.resolve();
      await services.desktopService.close();
      await globalSessionManager.clearAndDrain();
      await rm(root, { recursive: true, force: true });
    });
    const sessionId = "memory-host-shutdown";
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
      picoHome,
      persistence: true,
      runtimePort: createEngineRuntimePort(),
    });
    lease.session.updateRuntimeState({
      settings: {
        provider: "openai",
        model: "coder",
        modelRouteId: "test/coder",
        orchestrationMode: "default",
        collaborationMode: "agent",
        permissionMode: "ask",
        thinkingEffort: "medium",
        thinkingEffortExplicit: false,
        additionalDirectories: [],
      },
    });
    lease.release();
    const runtime = await services.service.getWorkspaceRuntime(workspacePath);
    const started = (await services.service.startForegroundRun({
      workspacePath,
      sessionId,
      prompt: "我喜欢简洁的中文回答。",
      execution: { allowedTools: ["memory_extract"] },
    })) as { runId: string };
    const result = await runtime.waitForRun(started.runId);
    assert.equal(result.status, "succeeded", result.error);
    await entered.promise;
    assert.equal(residencies, 1);
    let closed = false;
    const closing = services.desktopService.close().then(() => {
      closed = true;
    });
    await delay(30);
    assert.equal(closed, false, "host must wait for memory model");
    modelRelease.resolve();
    await disposing.promise;
    await delay(30);
    assert.equal(closed, false, "host must also wait for model disposal");
    assert.equal(residencies, 1);
    disposeRelease.resolve();
    await closing;
    assert.equal(residencies, 0);
    assert.equal(acquisitions, 1);
    assert.equal(modelCalls, 1);
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      const key = memorySessionKey(
        resolvePicoPaths(workspacePath, { picoHome }).workspace.id,
        sessionId,
      );
      assert.equal(
        await store.readExtractionCursor(key),
        undefined,
        "shutdown leaves coverage retryable",
      );
      assert.equal(
        await store.readPendingExtractionFailure(key),
        undefined,
        "shutdown is not an extraction failure",
      );
    } finally {
      store.close();
    }
  },
);
