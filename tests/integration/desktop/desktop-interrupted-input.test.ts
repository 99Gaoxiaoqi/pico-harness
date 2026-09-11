import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../../src/daemon/index.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import { materializeRuntimeHistory } from "../../../src/engine/session-runtime-read-model.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("Desktop 新输入先收尾中断批次，再开始执行；重复请求不重复入账", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-interrupted-input-"));
  const picoHome = join(root, "home");
  await mkdir(join(root, "workspace"));
  await mkdir(picoHome);
  const workspacePath = await realpath(join(root, "workspace"));
  await writeDesktopModelRouting(picoHome);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  let executions = 0;
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async () => {
      executions++;
      return { ok: true };
    },
  });
  const sessionId = "interrupted-input";
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    createSessionId: () => sessionId,
  });
  await desktop.handle(createRuntimeRequest("session.create", { workspacePath }));
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const session = lease.session;
  t.after(async () => {
    await desktop.close();
    lease.release();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  const abandoned = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await abandoned.recordTurnStarted(1);
  await abandoned.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "unapproved", name: "bash", arguments: '{"command":"echo never-dispatched"}' },
      ],
    },
  ]);
  const request = createRuntimeRequest("session.send", {
    workspacePath,
    sessionId,
    input: { kind: "text", text: "重新跑" },
    idempotencyKey: "resume-once",
  });
  await desktop.handle(request);
  await desktop.handle(request);
  const events = await session.runtimeEventStore!.readSession(sessionId);
  const resultIndex = events.findIndex((e) => e.kind === "tool.result.recorded");
  const inputIndex = events.findIndex(
    (e) => e.kind === "message.committed" && e.data.message.content === "重新跑",
  );
  assert.ok(resultIndex >= 0 && resultIndex < inputIndex, "恢复结果必须先于新输入写入");
  assert.equal(events.filter((e) => e.kind === "tool.result.recorded").length, 1);
  assert.equal(
    events.filter((e) => e.kind === "message.committed" && e.data.message.content === "重新跑")
      .length,
    1,
  );
  assert.equal(events.filter((e) => e.kind === "tool.started").length, 0);
  assert.equal(materializeRuntimeHistory(events).at(-1)!.content, "重新跑");
  assert.ok(executions <= 1);
});
