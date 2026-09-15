import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import {
  AgentRuntime,
  type RunAgentCliOptions,
  type RunAgentCliDependencies,
} from "@pico/pico-host/agent-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteSessionContinuitySource } from "@pico/pico-host/sqlite-session-continuity-source";
import { SessionSubscriptionRegistry } from "@pico/pico-host/session-subscription-owner";
import { compileRuntimePermissionProfile } from "@pico/core/permission-profile";
import { TranscriptReplica } from "@pico/transcript-replica";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "production overlay: provider failure stays retired across subscription reopen and the next successful run",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-overlay-reopen-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workspace);
    await mkdir(picoHome);
    const workspacePath = await realpath(workspace);
    const sessionId = "overlay-reopen";
    await writeDesktopModelRouting(picoHome);
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(workspacePath);
    const firstDelta = Promise.withResolvers<void>();
    const agentRuntime = new (class extends AgentRuntime {
      override execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
        return super.execute(options, {
          ...dependencies,
          isolatedHeadless: true,
          provider: {
            modelName: "test/overlay-reopen",
            generate: async () => {
              if (options.prompt === "fail") {
                dependencies.reporter?.onReasoningDelta?.("CU_FAIL_THINKING");
                await firstDelta.promise;
                throw new Error("simulated provider stream failure");
              }
              return { role: "assistant" as const, content: "CU_RECOVER_REPLY" };
            },
          },
        });
      }
    })();
    const services = createProductionRuntimeServices({
      env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" },
      trustStore,
      agentRuntime,
    });
    const source = new SqliteSessionContinuitySource({
      picoHome,
      readMetadata: (path, id) => services.desktopService.readSessionContinuityMetadata(path, id),
    });
    const registry = new SessionSubscriptionRegistry("host-test", source, (path, id) =>
      services.flushSessionOverlay(path, id),
    );
    services.attachSessionSubscriptions(registry);
    const unsubscribe = services.service.subscribe((notification) =>
      registry.publishRuntimeNotification(notification),
    );
    try {
      const runtime = await services.service.getWorkspaceRuntime(workspacePath);
      const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      lease.session.updateRuntimeState({
        settings: {
          provider: "openai",
          model: "coder",
          modelRouteId: "test/coder",
          collaborationMode: "agent",
          permissionMode: "ask",
          orchestrationMode: "default",
          thinkingEffort: "off",
          thinkingEffortExplicit: false,
          additionalDirectories: [],
        },
        boundary: compileRuntimePermissionProfile({
          collaborationMode: "agent",
          permissionMode: "ask",
        }),
      });
      await lease.session.flushPersistence();
      lease.release();
      const replica = new TranscriptReplica(sessionId);
      const opened = await registry.open(
        { workspacePath, sessionId },
        {
          connectionId: "live",
          push: async (frame) => {
            replica.receiveFrame(frame);
            if (
              frame.type === "subscription.session_delta" &&
              frame.text.includes("CU_FAIL_THINKING")
            )
              firstDelta.resolve();
          },
        },
      );
      replica.installOpen(replica.beginOpen(), opened);
      registry.activate(workspacePath, sessionId, opened.subscriptionId, "live");
      const failed = (await services.service.startForegroundRun({
        workspacePath,
        sessionId,
        prompt: "fail",
      })) as { runId: string };
      assert.equal((await runtime.waitForRun(failed.runId)).status, "failed");
      await registry.close(
        { workspacePath, sessionId, subscriptionId: opened.subscriptionId },
        "live",
      );
      assert.equal(
        replica.view.activeOverlay.length,
        0,
        "live terminal frame clears the renderer overlay",
      );
      const reopened = await registry.open(
        { workspacePath, sessionId },
        { connectionId: "reopened", push: async () => undefined },
      );
      assert.deepEqual(
        reopened.activeOverlay,
        [],
        "the host must not reintroduce a failed stream into a fresh replica",
      );
      const recovered = (await services.service.startForegroundRun({
        workspacePath,
        sessionId,
        prompt: "recover",
      })) as { runId: string };
      assert.equal((await runtime.waitForRun(recovered.runId)).status, "succeeded");
      const final = await registry.open(
        { workspacePath, sessionId },
        { connectionId: "final", push: async () => undefined },
      );
      const finalReplica = new TranscriptReplica(sessionId);
      assert.equal(finalReplica.installOpen(finalReplica.beginOpen(), final), true);
      assert.deepEqual(finalReplica.view.activeOverlay, []);
      assert.ok(
        finalReplica.view.records.some(
          (record) =>
            record.item.kind === "assistantMessage" && record.item.content === "CU_RECOVER_REPLY",
        ),
      );
    } finally {
      unsubscribe();
      registry.shutdown();
      await services.desktopService.close();
      await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
