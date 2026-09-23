import assert from "node:assert/strict";
import { contextSummaryMessage } from "../../fixtures/context-summary.js";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath } from "@pico/storage";
import { resolvePicoPaths } from "@pico/pico-host";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX, type Message } from "@pico/core";
import { createRuntimeRequest, type RuntimeSessionContextSnapshot } from "@pico/protocol";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { Session, globalSessionManager } from "@pico/pico-host/session";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { RuntimeRun } from "@pico/runtime/runtime-run";
import { computeCheckpointSourceDigest } from "@pico/runtime/runtime-compaction-checkpoint";
import { readRuntimeModelHistorySnapshot } from "@pico/runtime/session-runtime-read-model";
import { estimateModelInputTokens } from "@pico/runtime/context-budget";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";
import { contextView } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorPanelController.js";
import {
  InspectorWorkbarPanel,
  contextUsagePercent,
} from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";

Object.assign(globalThis, { React });

test("checkpoint model history reaches read-only context RPC and Inspector unchanged after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-context-checkpoint-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace);
  await writeDesktopModelRouting(picoHome);
  const canonical = await realpath(workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const openDesktop = () =>
    new DesktopRuntimeService({
      runtimeService: new WorkspaceRuntimeService({
        env: { PICO_HOME: picoHome },
        execute: async () => {
          throw new Error("inspection must not execute a run");
        },
      }),
      trustStore,
      env: { PICO_HOME: picoHome },
    });
  let desktop: DesktopRuntimeService | undefined = openDesktop();
  const created = (await desktop.handle(
    createRuntimeRequest("session.create", { workspacePath: canonical }),
  )) as { session: { sessionId: string } };
  const sessionId = created.session.sessionId;
  await desktop.close();
  await globalSessionManager.delete(sessionId, canonical, { picoHome })?.close();
  desktop = undefined;
  const session = new Session(sessionId, canonical, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    await session.commitMessages(
      ...Array.from(
        { length: 6 },
        (_, index): Message => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}: ${"history ".repeat(100)}`,
        }),
      ),
    );
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      const covered = (await run.readModelHistoryEntries()).slice(0, 4);
      await run.recordCheckpoint({
        checkpointId: "compaction-1",
        coveredEventCount: covered.length,
        sourceDigest: computeCheckpointSourceDigest(covered),
        throughEventId: covered.at(-1)!.eventId,
        summary: contextSummaryMessage("Summary of the first two exchanges."),
      });
      const snapshot = await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, sessionId);
      assert.deepEqual(await run.readModelHistory(), snapshot.messages);
      assert.equal(snapshot.messages.length, 3);
    });
    assert.equal(session.getHistory().length, 6, "transcript remains uncompressed");
    const expected = await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, sessionId);
    const originalEvents = await session.runtimeEventStore!.readSession(sessionId);
    const physicalCount = () => {
      const db = new DatabaseSync(
        operationalDatabasePath(resolvePicoPaths(canonical, { picoHome }).workspace.root),
        { readOnly: true },
      );
      try {
        return db
          .prepare("SELECT COUNT(*) AS count FROM usage_physical_attempts WHERE session_id=?")
          .get(sessionId)!.count;
      } finally {
        db.close();
      }
    };
    const originalPhysicalCount = physicalCount();
    await session.close();
    const readContext = async () =>
      (
        (await desktop!.handle(
          createRuntimeRequest("session.context.get", {
            workspacePath: canonical,
            sessionId,
          }),
        )) as { context: RuntimeSessionContextSnapshot }
      ).context;
    desktop = openDesktop();
    for (let index = 0; index < 2; index += 1) {
      const report = await readContext();
      assert.equal(report.modelHistory.messageCount, 3);
      assert.equal(
        report.modelHistory.estimatedTokens,
        estimateModelInputTokens(expected.messages, []),
      );
      assert.equal(report.modelHistory.throughSequence, expected.throughSequence);
      assert.equal(report.modelHistory.compactedCount, 1);
      assert.equal(physicalCount(), originalPhysicalCount);
      assert.deepEqual(report.modelHistory.latestCompaction, expected.latestCompaction);
      assert.equal(report.version, 3);
      assert.equal(report.modelHistory.projection, "effective_model_history");
      assert.equal(report.modelHistory.estimationAlgorithm, "maka_chars_v1");
      assert.equal(report.estimatedInputTokens, undefined);
      assert.equal(report.remainingTokens, undefined);
      assert.equal(report.usedPercent, undefined);
      const view = contextView(report);
      assert.equal(contextUsagePercent(view), undefined);
      const html = renderToStaticMarkup(
        React.createElement(InspectorWorkbarPanel, {
          context: view,
          trace: [],
          loading: false,
          onRefresh() {},
          onSelectTrace() {},
        }),
      );
      assert.match(html, /当前模型历史/u);
      assert.match(html, /compaction-1/u);
      assert.match(html, /1 次/u);
      assert.doesNotMatch(html, /role="progressbar"|<dt>剩余<|<dt>已使用</u);
      await desktop.close();
      await globalSessionManager.delete(sessionId, canonical, { picoHome })?.close();
      desktop = openDesktop();
    }
    await desktop.close();
    desktop = undefined;
    const recovered = new Session(sessionId, canonical, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      await recovered.recover();
      assert.equal(recovered.getHistory().length, 6);
      const finalEvents = await recovered.runtimeEventStore!.readSession(sessionId);
      assert.equal(finalEvents.length, originalEvents.length);
      assert.equal(
        finalEvents.filter((event) => event.kind === "run.started").length,
        originalEvents.filter((event) => event.kind === "run.started").length,
      );
      assert.deepEqual(
        finalEvents,
        originalEvents,
        "refresh and restart do not append runs, checkpoints, messages or provider calls",
      );
      // Seed/reset checkpoints still affect history, but never count as successful compactions.
      for (const [checkpointId, runId] of [
        ["fork-seed", `${RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX}context-fixture`],
        ["hard-reset:context-fixture", "reset-fixture"],
      ] as const) {
        const seedRun = await RuntimeRun.start({
          capability: recovered.runtimeEventCapability!,
          runId,
          agentSwarmAuthorization: "none",
        });
        await seedRun.run(async () => {
          const covered = await seedRun.readModelHistoryEntries();
          await seedRun.recordCheckpoint({
            checkpointId,
            coveredEventCount: covered.length,
            sourceDigest: computeCheckpointSourceDigest(covered),
            throughEventId: covered.at(-1)!.eventId,
            summary: { role: "assistant", content: "Restored state." },
          });
        });
      }
      const afterReset = await readRuntimeModelHistorySnapshot(
        recovered.runtimeEventStore!,
        sessionId,
      );
      assert.equal(afterReset.messages.length, 1);
      assert.equal(afterReset.compactedCount, 1);
      assert.equal(afterReset.latestCompaction, undefined);
    } finally {
      await recovered.close();
    }
  } finally {
    await desktop?.close();
    await globalSessionManager.delete(sessionId, canonical, { picoHome })?.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
