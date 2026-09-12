import assert from "node:assert/strict";
import test from "node:test";
import { TRANSCRIPT_PROJECTOR_VERSION } from "@pico/protocol";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";

test("Desktop conversation only derives hasEarlier from nextCursor", () => {
  const withoutCursor = parseConversation({ items: [] }, "/workspace", "session");
  assert.equal(withoutCursor.hasEarlier, false);

  const withCursor = parseConversation(
    {
      items: [],
      nextCursor: {
        historyEpoch: "history-1",
        projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
        throughSequence: 4,
        positionSequence: 2,
        positionOrdinal: 1,
        byteOffset: 0,
      },
    },
    "/workspace",
    "session",
  );
  assert.equal(withCursor.hasEarlier, true);
});

test("Desktop conversation projects only canonical terminal identities and states", () => {
  const result = {
    version: 1,
    toolCallId: "provider-current",
    toolName: "read_file",
    status: "succeeded",
    rawSizeBytes: 12,
    sha256: "a".repeat(64),
    deliveryTruncated: false,
    projection: {
      version: 1,
      mode: "full",
      text: "canonical output",
      strategy: "full",
      truncated: false,
    },
  } as const;
  const conversation = parseConversation(
    {
      items: [
        {
          id: "running-tool",
          kind: "tool",
          name: "read_file",
          args: "{}",
          status: "running",
          data: {
            toolCallId: "runtime-current",
            providerCallId: "provider-current",
            entryId: "entry-current",
          },
        },
        {
          id: "terminal-tool",
          kind: "tool",
          name: "read_file",
          args: "{}",
          status: "success",
          providerCallId: "retired-top-level",
          summary: "approval summary is not output",
          result,
        },
        {
          id: "terminal-without-result",
          kind: "tool",
          name: "read_file",
          args: "{}",
          status: "success",
          summary: "retired output fallback",
        },
        {
          id: "old-run",
          kind: "runBoundary",
          runId: "run-old",
          status: "completed",
          startedAt: 1,
        },
        {
          id: "failed-run",
          kind: "runBoundary",
          runId: "run-current",
          status: "failed",
          startedAt: 1,
          finishedAt: 2,
          detail: "retired detail",
        },
        {
          id: "old-approval",
          kind: "approval",
          title: "old approval",
          state: "allowed",
          data: {},
        },
        {
          id: "current-approval",
          kind: "approval",
          title: "current approval",
          state: "allow_once",
          data: { approvalId: "current", runId: "run-current", decision: "allow_once" },
        },
        {
          id: "old-prompt",
          kind: "prompt",
          title: "old prompt",
          state: "resolved",
          data: {},
        },
        {
          id: "current-prompt",
          kind: "prompt",
          title: "current prompt",
          state: "answered",
          data: { promptId: "current", runId: "run-current" },
        },
      ],
    },
    "/workspace",
    "session",
  );

  const running = conversation.items.find((item) => item.id === "running-tool");
  assert.equal(running?.kind === "tool" && running.toolCallId, "runtime-current");
  const terminal = conversation.items.find((item) => item.id === "terminal-tool");
  assert.equal(terminal?.kind === "tool" && terminal.toolCallId, "provider-current");
  assert.equal(terminal?.kind === "tool" && terminal.output, "canonical output");
  assert.equal(
    conversation.items.some((item) => item.id === "terminal-without-result"),
    false,
  );
  assert.equal(
    conversation.items.some((item) => item.id === "old-run"),
    false,
  );
  const failedRun = conversation.items.find((item) => item.id === "failed-run");
  assert.equal(failedRun?.kind === "runBoundary" && failedRun.detail, undefined);
  assert.equal(
    conversation.items.some((item) => item.id === "old-approval"),
    false,
  );
  const approval = conversation.items.find((item) => item.id === "approval:current");
  assert.equal(approval?.kind === "approval" && approval.state, "allowed");
  assert.equal(
    conversation.items.some((item) => item.id === "old-prompt"),
    false,
  );
  const prompt = conversation.items.find((item) => item.id === "prompt:current");
  assert.equal(prompt?.kind === "prompt" && prompt.state, "answered");
});
