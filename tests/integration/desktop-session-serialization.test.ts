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
import { globalSessionManager } from "../../src/engine/session.js";

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
    const desktop = new DesktopRuntimeService({ runtimeService: runtime, env });
    const sessionId = "desktop-serialized-session";
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, canonicalWorkspace, {
      persistence: true,
      picoHome,
    });
    const runtimeErrors: unknown[] = [];
    let resolveProjection!: () => void;
    const projectionSettled = new Promise<void>((resolve) => {
      resolveProjection = resolve;
    });
    const unsubscribe = desktop.subscribe((notification) => {
      if (notification.topic === "runtime.error") {
        runtimeErrors.push(notification.payload);
        resolveProjection();
        return;
      }
      if (
        notification.topic === "session.transcriptUpdated" &&
        notification.scope.sessionId === sessionId
      ) {
        resolveProjection();
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
              data: { toolName: "read_file", args: "{}" },
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
