import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeResult, RuntimeSessionSubscriptionFrame } from "@pico/protocol";
import { DesktopSessionContinuity } from "../../../apps/desktop/src/renderer/session-continuity.js";
import {
  createRuntimeNotification,
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../../src/daemon/index.js";
import { DesktopReporter } from "../../../src/daemon/desktop-reporter.js";
import { SessionSubscriptionRegistry } from "../../../src/daemon/session-subscription-owner.js";
import { SqliteSessionContinuitySource } from "../../../src/daemon/sqlite-session-continuity-source.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";

test("普通会话运行持锁时，订阅重开、Graph只读查询和工具后推理仍实时到达界面", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-live-subscription-"));
  const picoHome = join(root, "home");
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    onTranscriptAdvanced: (workspace, id) => registry.publishTranscriptAdvanced(workspace, id),
  });
  const source = new SqliteSessionContinuitySource({
    picoHome,
    readMetadata: (workspace, id) => desktop.readSessionContinuityMetadata(workspace, id),
  });
  const registry = new SessionSubscriptionRegistry("live-test-host", source);
  const created = (await desktop.handle(
    createRuntimeRequest("session.create", { workspacePath }),
  )) as unknown as RuntimeResult<"session.create">;
  const sessionId = created.session.sessionId;
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
    persistence: true,
    picoHome,
  });
  let receiveFrame: ((frame: RuntimeSessionSubscriptionFrame) => void) | undefined;
  let receivedThinking!: () => void;
  const thinkingArrived = new Promise<void>((resolve) => {
    receivedThinking = resolve;
  });
  let receivedDurableTool!: () => void;
  const durableToolArrived = new Promise<void>((resolve) => {
    receivedDurableTool = resolve;
  });
  const continuity = new DesktopSessionContinuity({
    transport: {
      subscribeFrames(listener) {
        receiveFrame = listener;
        return {
          dispose: () => {
            receiveFrame = undefined;
          },
        };
      },
      async open(params) {
        const opened = await registry.open(params, {
          connectionId: "desktop-client",
          push: async (frame) => {
            receiveFrame?.(frame);
          },
        });
        registry.activate(workspacePath, sessionId, opened.subscriptionId, "desktop-client");
        return opened;
      },
      close: (params) => registry.close(params, "desktop-client"),
      page: (params) => registry.readTranscriptPage(params),
      advance: (params) => registry.readTranscriptAdvance(params),
    },
    onView(_workspace, _session, view) {
      if (view.records.some(({ item }) => item.kind === "tool" && item.name === "queued_read")) {
        receivedDurableTool();
      }
      if (
        view.activeOverlay.some(
          (entry) => entry.kind === "thinking" && entry.text === "工具后实时摘要",
        )
      ) {
        receivedThinking();
      }
    },
  });
  let releaseRun!: () => void;
  let enteredRun!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredRun = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  let runFinished = false;
  let running: Promise<void> | undefined;
  try {
    assert.equal(lease.session.getRuntimeStateSnapshot().settings?.orchestrationMode, "default");
    await continuity.open(workspacePath, sessionId);
    running = lease.session.serialize(async () => {
      enteredRun();
      await gate;
      runFinished = true;
    });
    await entered;

    // An external notification queues a writer behind the Run. Subscription
    // snapshots must not wait for that writer (even across other subscriptions).
    runtime.publishDesktopNotification(
      createRuntimeNotification({
        eventId: "queued-live-tool-started",
        topic: "run.timeline",
        scope: { workspacePath, sessionId, runId: "live-run" },
        resourceVersion: 1,
        at: 1,
        payload: {
          runId: "live-run",
          item: {
            eventType: "tool.started",
            data: { toolName: "queued_read", args: "{}", providerCallId: "queued-read" },
          },
        },
      }),
    );
    const [, graph] = await beforeRunEnds(
      Promise.all([
        continuity.open(workspacePath, sessionId),
        desktop.handle(
          createRuntimeRequest("session.graph.query", {
            workspacePath,
            sessionId,
            action: "list",
          }),
        ),
      ]),
    );
    assert.deepEqual(graph, { graphs: [] });

    const reporter = new DesktopReporter({
      runId: "live-run",
      sessionId,
      publish: (event) => registry.publishReporterEvent(workspacePath, event),
    });
    reporter.onTurnStart(1);
    reporter.onToolCall("read_file", '{"path":"canary.txt"}', "read-call");
    reporter.onTurnStart(2);
    reporter.onReasoningDelta("工具后实时摘要");
    await beforeRunEnds(thinkingArrived);
    assert.equal(runFinished, false, "界面收到推理时运行必须尚未结束");
    releaseRun();
    await running;
    await beforeRunEnds(durableToolArrived);
  } finally {
    releaseRun();
    await running;
    continuity.dispose();
    registry.shutdown();
    await desktop.close();
    lease.release();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function beforeRunEnds<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("只读订阅/推理被运行锁阻塞")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
