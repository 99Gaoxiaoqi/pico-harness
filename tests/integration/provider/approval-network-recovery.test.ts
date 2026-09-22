import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { ApprovalManager } from "@pico/pico-host/global-approval-manager";
import { globalSessionManager } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { SilentReporter } from "@pico/runtime/silent-reporter";

test("approved edit survives next-request TLS reset without repeating approval or tool execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-network-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  const sessionId = "approval-network-recovery";
  await mkdir(workDir);
  await writeFile(join(workDir, "drawing.txt"), "draft");
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    const released = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  let approvals = 0;
  const bodies: Array<{ messages: Array<{ role: string; tool_call_id?: string }> }> = [];
  const sse = (delta: unknown, finish: string) =>
    new Response(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 8 } })}\n\n` +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    calls++;
    if (calls === 1) {
      return sse(
        {
          tool_calls: [
            {
              index: 0,
              id: "edit-once",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "drawing.txt",
                  old_text: "draft",
                  new_text: "rendered",
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    assert.equal(approvals, 1);
    assert.equal(await readFile(join(workDir, "drawing.txt"), "utf8"), "rendered");
    assert.equal(
      bodies.at(-1)!.messages.filter((m) => m.role === "tool" && m.tool_call_id === "edit-once")
        .length,
      1,
    );
    if (calls === 2) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_TLS_DETAIL"), { code: "ECONNRESET" }),
      });
    }
    return sse({ content: "Drawing ready" }, "stop");
  };
  const manager = new ApprovalManager(60_000);
  const result = await executeAgentRuntime(
    {
      prompt: "Edit drawing.txt once, then report completion.",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      collaborationMode: "agent",
      permissionMode: "ask",
      allowedTools: ["edit_file"],
    },
    {
      picoHome,
      provider: new AiSdkProvider("openai", {
        baseURL: "https://fixture.invalid/v1",
        apiKey: "PRIVATE_KEY",
        model: "test",
      }),
      reporter: new SilentReporter(),
      approvalManager: manager,
      approvalNotifier: (notice) => {
        approvals++;
        assert.equal(notice.toolName, "edit_file");
        setTimeout(() => manager.resolveApproval(notice.taskId, true, "approved by fixture"), 30);
      },
    },
  );
  assert.equal(result.finalMessage, "Drawing ready");
  assert.equal(calls, 3);
  assert.equal(approvals, 1);
  assert.deepEqual(bodies[1], bodies[2], "retry only re-sends the pending model request");
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  try {
    const events = await store.readSession(sessionId);
    const settled = events.filter((e) => e.kind === "model.call.settled");
    assert.deepEqual(
      settled.map((e) => e.data.status),
      ["succeeded", "failed", "succeeded"],
    );
    assert.deepEqual(
      settled.map((e) => e.data.retryAttempt),
      [0, 0, 1],
    );
    assert.equal(settled[1]!.data.logicalCallId, settled[2]!.data.logicalCallId);
    assert.equal(events.filter((e) => e.kind === "approval.settled").length, 1);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_TLS_DETAIL|PRIVATE_KEY/);
  } finally {
    store.close();
  }
});
