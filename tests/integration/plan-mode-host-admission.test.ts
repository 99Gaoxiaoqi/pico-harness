import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { RuntimeProtocolError } from "../../src/daemon/protocol.js";

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

// 注：原"TUI Plan revision admission"用例随 in-process TUI 路径退役删除
// （Phase 5，2026-08-16）：plan 审批 Run 的持久 admission 语义由上方
// daemon 侧 WorkspaceRuntimeService 用例覆盖（同一 operationId 重放同一 Run）。
