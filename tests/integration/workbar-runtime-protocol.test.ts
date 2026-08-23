import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RuntimeProtocolError,
} from "@pico/protocol";

test("workbar data methods reject unknown and oversized parameters", () => {
  assert.deepEqual(
    parseStrictRuntimeParams("session.tasks.command", {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "tool-call",
      title: "task",
    }),
    {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "tool-call",
      title: "task",
    },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.artifacts.command", {
        workspacePath: "/workspace",
        sessionId: "session",
        action: "append",
        contentBase64: "a".repeat(48_001),
      }),
    RuntimeProtocolError,
  );
});

test("review, terminal and side chat contracts are renderer allowlisted and strictly decoded", () => {
  for (const method of [
    "git.review.snapshot",
    "git.review.diff",
    "terminal.create",
    "terminal.list",
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "terminal.stop",
    "terminal.detach",
    "sideChat.create",
    "sideChat.close",
  ] as const) {
    assert.ok(DESKTOP_RUNTIME_METHODS.includes(method));
  }

  parseStrictRuntimeParams("sideChat.create", {
    workspacePath: "/workspace",
    sourceSessionId: "source",
    panelId: "panel",
    idempotencyKey: "create-panel",
  });
  assert.throws(
    () =>
      parseStrictRuntimeParams("terminal.input", {
        workspacePath: "/workspace",
        sessionId: "session",
        terminalId: "terminal",
        resourceEpoch: "epoch",
        data: "x",
        unexpected: true,
      }),
    RuntimeProtocolError,
  );
  parseDesktopRuntimeResult("terminal.attach", {
    terminal: {
      terminalId: "terminal",
      workspacePath: "/workspace",
      sessionId: "session",
      resourceEpoch: "epoch",
      sequence: 2,
      status: "running",
      capability: "pty",
      resizeSupported: true,
      createdAt: 1,
      updatedAt: 2,
    },
    resourceEpoch: "epoch",
    sequence: 2,
    snapshot: "ready",
    truncated: false,
  });
  assert.throws(
    () =>
      parseDesktopRuntimeResult("terminal.attach", {
        terminal: {
          terminalId: "terminal",
          workspacePath: "/workspace",
          sessionId: "session",
          resourceEpoch: "epoch",
          sequence: 2,
          status: "running",
          capability: "pty",
          resizeSupported: true,
          createdAt: 1,
          updatedAt: 2,
        },
        resourceEpoch: "epoch",
        sequence: 2,
        snapshot: "x".repeat(256 * 1024 + 1),
        truncated: false,
      }),
    RuntimeProtocolError,
  );
});
