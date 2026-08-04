import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { RuntimeProtocolError } from "../../src/daemon/protocol.js";
import { ensureTuiPlanRevisionRunAdmission } from "../../src/tui/repl.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";

test("Plan review Run admission replays one durable run for the same operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  let executions = 0;
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  const request = {
    workspacePath: workspace,
    sessionId: "session-1",
    prompt: "execute approved plan",
    execution: {
      resumeExistingSession: true,
      planReview: {
        action: "execute" as const,
        planId: "plan-1",
        expectedRevision: 1,
        expectedSessionSequence: 4,
        operationId: "operation-1",
      },
    },
    idempotencyKey: "plan-review-run:operation-1",
  };
  const first = await service.startForegroundRun(request);
  const replay = await service.startForegroundRun(request);
  assert.equal((first as { runId: string }).runId, (replay as { runId: string }).runId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);

  await assert.rejects(
    service.startForegroundRun({ ...request, prompt: "different request" }),
    RuntimeProtocolError,
  );
});

test("TUI Plan revision admission is durable and reuses one RuntimeRun", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-tui-admission-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));

  const request = {
    sessionId: "session-1",
    workDir: workspace,
    picoHome,
    operationId: "revision-operation-1",
    requestedAt: "2026-08-05T00:00:00.000Z",
  };
  const [first, concurrentReplay] = await Promise.all([
    ensureTuiPlanRevisionRunAdmission(request),
    ensureTuiPlanRevisionRunAdmission(request),
  ]);
  const replay = await ensureTuiPlanRevisionRunAdmission(request);
  assert.deepEqual(concurrentReplay, first);
  assert.deepEqual(replay, first);
  assert.ok(first);

  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workspace, { picoHome }).workspace.root,
  });
  const events = await store.readRun(request.sessionId, first.runId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "run.started");
  assert.equal(events[0]?.eventId, first.runStartedEventId);
});
