import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeNotification } from "../../../packages/protocol/src/index.js";
import { buildApprovalRequestedPayload } from "../../../src/daemon/approval-wire.js";
import { ingestDesktopRuntimeNotification } from "../../../src/daemon/desktop-transcript-persistence.js";
import { Session } from "../../../src/engine/session.js";
import { parseDesktopToolApproval } from "../../../apps/desktop/src/renderer/runtime-projections/approval.js";
import {
  parseConversation,
  pendingToolApprovalFromTranscript,
} from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";

test("approval preview and exact authorization survive live delivery, durable replay and resolution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-preview-"));
  const session = new Session("approval-preview", root, {
    persistence: true,
    picoHome: join(root, ".pico"),
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const payload = buildApprovalRequestedPayload(
    {
      kind: "tool",
      taskId: "approval-preview-1",
      toolName: "edit_file",
      providerCallId: "call-1",
      args: JSON.stringify({ path: "hello.txt", old_string: "before", new_string: "after" }),
      message: "更新说明",
      preview: { target: "hello.txt", summary: "修改 hello.txt" },
      diff: "--- hello.txt\n+++ hello.txt\n@@ -1 +1 @@\n-before\n+after",
      sessionScope: { type: "all-edits" },
    },
    "run-1",
  );
  const live = parseDesktopToolApproval(payload, { runId: "run-1", sessionId: session.id });
  assert.ok(live);
  await ingestDesktopRuntimeNotification(
    session,
    createRuntimeNotification({
      eventId: "preview-request",
      topic: "approval.requested",
      scope: { workspacePath: root, sessionId: session.id, runId: "run-1" },
      resourceVersion: 1,
      at: 1,
      payload,
    }),
  );
  const replay = async () => {
    const page = await session.runtimeEventStore!.readTranscriptProjectionPage({
      sessionId: session.id,
      maxBytes: 512 * 1024,
    });
    return parseConversation(
      { items: page.items.map(({ payload: item }) => item) },
      root,
      session.id,
    );
  };
  const pending = pendingToolApprovalFromTranscript((await replay()).items);
  assert.ok(pending);
  for (const key of ["diff", "sessionScope", "command", "toolName", "providerCallId"] as const)
    assert.deepEqual(pending[key], live[key], key);
  assert.equal(pending.diff?.includes("+after"), true);
  assert.deepEqual(pending.sessionScope, { type: "all-edits" });
  await ingestDesktopRuntimeNotification(
    session,
    createRuntimeNotification({
      eventId: "preview-denied",
      topic: "approval.resolved",
      scope: { workspacePath: root, sessionId: session.id, runId: "run-1" },
      resourceVersion: 2,
      at: 2,
      payload: { approvalId: live.id, decision: "deny" },
    }),
  );
  assert.equal(pendingToolApprovalFromTranscript((await replay()).items), undefined);
  const malformed = parseDesktopToolApproval(
    {
      approvalId: "bad",
      runId: "run-1",
      request: {
        kind: "tool",
        title: "bad",
        detail: "bad",
        risk: "medium",
        toolName: "edit_file",
        args: "{}",
        providerCallId: "call-bad",
        sessionScope: { type: "directories", directories: ["/tmp"] },
      },
    },
    { runId: "run-1" },
  );
  assert.equal(malformed, undefined);
});

test("重启后的旧待审批记录不会冒充新运行，当前审批仍能回放和解决", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-stale-approval-"));
  const session = new Session("stale-approval", root, {
    persistence: true,
    picoHome: join(root, "home"),
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  let version = 0;
  const approval = async (runId: string, id: string) =>
    ingestDesktopRuntimeNotification(
      session,
      createRuntimeNotification({
        eventId: id,
        topic: "approval.requested",
        scope: { workspacePath: root, sessionId: session.id, runId },
        resourceVersion: ++version,
        at: version,
        payload: buildApprovalRequestedPayload(
          {
            kind: "tool",
            taskId: id,
            toolName: "bash",
            args: '{"command":"echo check"}',
            message: "执行命令",
            preview: { target: "echo check", summary: "执行命令" },
            providerCallId: `call-${id}`,
          },
          runId,
        ),
      }),
    );
  const boundary = async (runId: string, status: "running" | "failed") =>
    ingestDesktopRuntimeNotification(
      session,
      createRuntimeNotification({
        eventId: `${runId}-${status}`,
        topic: status === "running" ? "run.started" : "run.finished",
        scope: { workspacePath: root, sessionId: session.id, runId },
        resourceVersion: ++version,
        at: version,
        payload: {
          run: {
            runId,
            sessionId: session.id,
            status,
            startedAt: 1,
            version,
            ...(status === "failed" ? { finishedAt: version } : {}),
          },
        },
      }),
    );
  const replay = async () => {
    const page = await session.runtimeEventStore!.readTranscriptProjectionPage({
      sessionId: session.id,
      maxBytes: 512 * 1024,
    });
    return parseConversation(
      { items: page.items.map(({ payload: item }) => item) },
      root,
      session.id,
    ).items;
  };
  await approval("old-run", "old-approval");
  let items = await replay();
  assert.equal(pendingToolApprovalFromTranscript(items, "old-run")?.runId, "old-run");
  assert.equal(
    pendingToolApprovalFromTranscript(items, "new-run"),
    undefined,
    "即使结束边界尚未同步也不能关联到新run",
  );
  assert.equal(await boundary("old-run", "failed"), true);
  assert.equal(await boundary("new-run", "running"), true);
  items = await replay();
  assert.equal(pendingToolApprovalFromTranscript(items, "new-run"), undefined);
  assert.equal(
    pendingToolApprovalFromTranscript(items),
    undefined,
    "历史末尾有新运行边界，不回捞旧卡",
  );
  assert.ok(
    items.some((item) => item.kind === "approval" && item.id === "approval:old-approval"),
    "审计记录仍保留",
  );
  await approval("new-run", "new-approval");
  items = await replay();
  const pending = pendingToolApprovalFromTranscript(items, "new-run");
  assert.equal(pending?.id, "approval:new-approval");
  assert.equal(pending?.providerCallId, "call-new-approval");
  assert.equal(pending?.command, "echo check");
  assert.equal(
    pendingToolApprovalFromTranscript(
      items.map((item) => (item.kind === "approval" ? { ...item, runId: undefined } : item)),
      "new-run",
    ),
    undefined,
    "缺少运行身份的历史卡不能冒充当前审批",
  );
  await ingestDesktopRuntimeNotification(
    session,
    createRuntimeNotification({
      eventId: "new-resolved",
      topic: "approval.resolved",
      scope: { workspacePath: root, sessionId: session.id, runId: "new-run" },
      resourceVersion: ++version,
      at: version,
      payload: { approvalId: "new-approval", decision: "deny" },
    }),
  );
  assert.equal(
    pendingToolApprovalFromTranscript(await replay(), "new-run"),
    undefined,
    "解决新卡后也不能回退到旧卡",
  );
});
