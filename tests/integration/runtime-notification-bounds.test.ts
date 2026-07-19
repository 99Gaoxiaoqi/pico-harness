import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeRuntimeFrame } from "../../src/daemon/protocol.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { createRuntimeNotification } from "../../src/daemon/protocol.js";

test("oversized durable notifications are bounded before entering replay", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-notification-bounds-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  service.publishDesktopNotification(
    createRuntimeNotification({
      eventId: "oversized",
      topic: "run.timeline",
      scope: { workspacePath: canonicalWorkspace, sessionId: "session", runId: "run" },
      resourceVersion: 1,
      at: 1,
      payload: {
        runId: "run",
        item: { kind: "status", title: "x".repeat(2 * 1024 * 1024) },
      },
    }),
  );
  service.publishDesktopNotification(
    createRuntimeNotification({
      eventId: "next",
      topic: "run.timeline",
      scope: { workspacePath: canonicalWorkspace, sessionId: "session", runId: "run" },
      resourceVersion: 2,
      at: 2,
      payload: { runId: "run", item: { kind: "status", title: "next" } },
    }),
  );

  const replay = await service.replayEvents({ workspacePath: canonicalWorkspace });
  assert.deepEqual(
    replay.events.map(({ eventId }) => eventId),
    ["oversized", "next"],
  );
  const first = replay.events[0]!;
  assert.doesNotThrow(() =>
    encodeRuntimeFrame({ kind: "event", protocolVersion: 1, event: first }),
  );
  assert.match(JSON.stringify(first.payload), /truncated/u);
});
