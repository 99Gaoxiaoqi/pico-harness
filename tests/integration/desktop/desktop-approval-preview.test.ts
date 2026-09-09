import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeNotification } from "../../../src/daemon/protocol.js";
import { buildApprovalRequestedPayload } from "../../../src/daemon/approval-wire.js";
import { ingestDesktopRuntimeNotification } from "../../../src/daemon/desktop-transcript-persistence.js";
import { projectRuntimeTranscript } from "../../../src/daemon/desktop-transcript.js";
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
  const live = parseDesktopToolApproval(payload, { sessionId: session.id });
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
  const replay = () =>
    session
      .readHydrationSnapshot()
      .then((snapshot) =>
        parseConversation(projectRuntimeTranscript(snapshot, {}), root, session.id),
      );
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
  const legacy = parseDesktopToolApproval({
    approvalId: "old",
    request: { toolName: "bash", command: "npm test" },
  });
  assert.equal(legacy?.sessionScope, undefined);
  const malformed = parseDesktopToolApproval({
    approvalId: "bad",
    request: { sessionScope: { type: "directories", directories: ["/tmp"] } },
  });
  assert.equal(malformed?.sessionScope, undefined);
});
