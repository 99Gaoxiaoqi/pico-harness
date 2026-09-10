import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_RUNTIME_PROTOCOL_VERSION, type RuntimeNotification } from "@pico/protocol";
import { TuiReporter } from "../../../src/tui/tui-reporter.js";
import { sendTuiTurn } from "../../e2e/helpers/tui-turn.js";

function fixture() {
  let listener: (event: RuntimeNotification) => void = () => undefined;
  let disposed = false;
  const reporter = new TuiReporter();
  reporter.onMessage("old assistant reply");
  reporter.onFinish();
  const emit = (topic: string, payload: RuntimeNotification["payload"]) =>
    listener({
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      eventId: `event-${topic}`,
      topic,
      scope: { workspacePath: "/fixture", sessionId: "session" },
      resourceVersion: 1,
      at: Date.now(),
      payload,
    });
  const finish = (status: "succeeded" | "failed", error?: string) => {
    runtime.running = false;
    reporter.onFinish();
    emit("run.finished", {
      run: { runId: "run", status, ...(error ? { error } : {}) },
    });
  };
  const runtime = {
    activeSessionId: "session",
    running: false,
    sendText: async (_text: string) => true,
    resolvePlain: async (_action: "approve" | "approve-session" | "reject", _id: string) => true,
  };
  const options = {
    runtime,
    reporter,
    workspacePath: "/fixture",
    text: "fixture request",
    timeoutMs: 250,
    client: {
      subscribe: async (_params: unknown, callback: typeof listener) => {
        listener = callback;
        return {
          replay: { subscribed: true as const, events: [], hasMore: false },
          dispose: () => {
            disposed = true;
          },
        };
      },
    },
  };
  return { runtime, reporter, emit, finish, options, disposed: () => disposed };
}

test("TUI E2E turn observes a new reply and resolves the actual one-shot approval", async () => {
  const f = fixture();
  const resolutions: string[] = [];
  f.runtime.sendText = async () => {
    f.runtime.running = true;
    f.reporter.pushError(
      "应用启动覆盖失败：Session session 仍有活动 Run，不能修改会话设置（将在下次触发点重试）",
      {
        action: "session.settings.update",
        retryable: true,
      },
    );
    f.emit("run.started", { run: { runId: "run", status: "running" } });
    f.emit("approval.requested", {
      approvalId: "approval",
      runId: "run",
      request: { toolName: "write_file" },
    });
    return true;
  };
  f.runtime.resolvePlain = async (action, id) => {
    resolutions.push(`${action}:${id}`);
    f.reporter.onStart("/fixture");
    f.reporter.onMessage("new reply");
    f.finish("succeeded");
    return true;
  };
  assert.equal(
    await sendTuiTurn({ ...f.options, approve: (notice) => notice.toolName === "write_file" }),
    true,
  );
  assert.deepEqual(resolutions, ["approve:approval"]);
  assert.equal(f.disposed(), true);
});

test("TUI E2E turn fails promptly on terminal errors and unhandled approvals; old replies cannot pass", async (context) => {
  for (const scenario of [
    "failed",
    "approval",
    "old-reply",
    "send-error",
    "settings-error",
  ] as const) {
    await context.test(scenario, async () => {
      const f = fixture();
      let sends = 0;
      f.runtime.sendText = async () => {
        sends++;
        if (scenario === "failed") f.finish("failed", "apiKey=fixture-private model unavailable");
        if (scenario === "approval")
          f.emit("approval.requested", { approvalId: "approval", request: { toolName: "bash" } });
        if (scenario === "old-reply") f.finish("succeeded");
        if (scenario === "send-error") {
          f.reporter.pushError("session.send failed");
          return false;
        }
        if (scenario === "settings-error")
          f.reporter.pushError("invalid model route", {
            action: "session.settings.update",
            retryable: true,
          });
        return true;
      };
      await assert.rejects(sendTuiTurn(f.options), (error: Error) => {
        assert.doesNotMatch(error.message, /fixture-private/);
        assert.match(
          error.message,
          scenario === "failed"
            ? /model unavailable/
            : scenario === "approval"
              ? /unexpected approval/
              : scenario === "old-reply"
                ? /deadline exceeded/
                : scenario === "settings-error"
                  ? /invalid model route/
                  : /session.send failed/,
        );
        return true;
      });
      assert.equal(sends, 1);
      assert.equal(f.disposed(), true);
    });
  }
});
