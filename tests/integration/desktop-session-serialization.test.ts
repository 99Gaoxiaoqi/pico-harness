import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeNotification,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { ingestDesktopRuntimeNotification } from "../../src/daemon/desktop-transcript-persistence.js";
import { globalSessionManager, Session } from "../../src/engine/session.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";

test(
  "Desktop transcript persistence reuses the active Session serialization scope",
  { timeout: 5_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-session-serialization-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workspace, { recursive: true });
    await mkdir(picoHome, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const env = { PICO_HOME: picoHome };
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async () => undefined,
    });
    const sessionId = "desktop-serialized-session";
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, canonicalWorkspace, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    const runtimeErrors: unknown[] = [];
    let resolveProjection!: () => void;
    const projectionSettled = new Promise<void>((resolve) => {
      resolveProjection = resolve;
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      env,
      onTranscriptAdvanced: (_workspacePath, advancedSessionId) => {
        if (advancedSessionId === sessionId) resolveProjection();
      },
    });
    const unsubscribe = desktop.subscribe((notification) => {
      if (notification.topic === "runtime.error") {
        runtimeErrors.push(notification.payload);
        resolveProjection();
        return;
      }
    });
    context.after(async () => {
      unsubscribe();
      try {
        await desktop.close();
      } finally {
        lease.release();
        const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
        try {
          await session?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    });

    await lease.session.serialize(async () => {
      runtime.publishDesktopNotification(
        createRuntimeNotification({
          eventId: "serialized-turn-started",
          topic: "run.timeline",
          scope: {
            workspacePath: canonicalWorkspace,
            sessionId,
            runId: "run-serialized",
          },
          resourceVersion: 1,
          at: 1,
          payload: {
            runId: "run-serialized",
            item: { eventType: "turn.started", data: { turn: 1 } },
          },
        }),
      );
      runtime.publishDesktopNotification(
        createRuntimeNotification({
          eventId: "serialized-tool-started",
          topic: "run.timeline",
          scope: {
            workspacePath: canonicalWorkspace,
            sessionId,
            runId: "run-serialized",
          },
          resourceVersion: 2,
          at: 2,
          payload: {
            runId: "run-serialized",
            item: {
              eventType: "tool.started",
              data: {
                providerCallId: "provider-call-serialized",
                toolName: "read_file",
                args: "{}",
              },
            },
          },
        }),
      );
      await projectionSettled;
    });

    assert.deepEqual(runtimeErrors, []);
    const hydration = await lease.session.readHydrationSnapshot();
    assert.ok(
      hydration.transcriptEvents.some(
        (event) => event.eventId === "runtime:serialized-tool-started",
      ),
    );
  },
);

test("Desktop does not persist a second plan entry for a Runtime-owned tool start", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-canonical-plan-start-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const session = new Session("desktop-canonical-plan-start", canonicalWorkspace, {
    persistence: true,
    picoHome,
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  await session.recover();
  const args = JSON.stringify({
    plan: [{ step: "核对 canonical start", status: "in_progress" }],
  });
  const [start] = await session.recordRuntimeTranscriptToolStarts({
    invocationId: "invocation:desktop-plan",
    runId: "run-desktop-plan",
    turnId: "turn:run-desktop-plan:1",
    createdAt: 1,
    toolCalls: [{ id: "call-desktop-plan", name: "update_plan", arguments: args }],
  });
  assert.ok(start);

  const inserted = await ingestDesktopRuntimeNotification(
    session,
    createRuntimeNotification({
      eventId: "canonical-plan-tool-started",
      topic: "run.timeline",
      scope: {
        workspacePath: canonicalWorkspace,
        sessionId: session.id,
        runId: "run-desktop-plan",
      },
      resourceVersion: 1,
      at: 2,
      payload: {
        runId: "run-desktop-plan",
        item: {
          eventType: "tool.started",
          data: {
            providerCallId: start.providerCallId,
            toolName: start.name,
            args: start.args,
            canonicalTranscriptStart: {
              eventId: start.eventId,
              sequence: start.sequence,
              entryId: start.entryId,
              toolCallId: start.toolCallId,
            },
          },
        },
      },
    }),
  );

  assert.equal(inserted, false);
  const hydration = await session.readHydrationSnapshot();
  assert.deepEqual(hydration.transcriptEvents, [start]);
});
