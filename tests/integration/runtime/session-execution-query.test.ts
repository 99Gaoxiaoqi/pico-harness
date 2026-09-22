import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";

test("execution projection survives reopen and paginates a fixed session snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-execution-query-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    for (let n = 0; n < 18; n++) {
      const runId = `run-${n}`;
      const base = (id: string) => ({
        schemaVersion: 2 as const,
        eventId: `${runId}-${id}`,
        sessionId: "session",
        invocationId: `inv-${n}`,
        runId,
        turnId: `turn-${n}`,
        at: "2026-09-22T00:00:00.000Z",
        partial: false,
        visibility: "internal" as const,
      });
      const events: RuntimeEvent[] = [
        {
          ...base("start"),
          partial: false,
          kind: "run.started",
          data: { workDir: root, agentSwarmAuthorization: "none" },
        },
        {
          ...base("model"),
          kind: "model.call.started",
          data: { providerCallId: "call", model: "test", purpose: "main" },
        },
        {
          ...base("meter"),
          kind: "model.call.settled",
          data: {
            providerCallId: "call",
            status: "succeeded",
            latencyMs: 20,
            usage: { promptTokens: 5, completionTokens: 7 },
            costCNY: 0.01,
            costStatus: "estimated",
          },
        },
        {
          ...base("response"),
          partial: false,
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "assistant", content: "response", reasoning: "thinking" } },
        },
        {
          ...base("approval"),
          kind: "approval.requested",
          data: { approvalId: "permission", toolName: "Read" },
        },
        {
          ...base("approved"),
          kind: "approval.settled",
          data: { approvalId: "permission", decision: "approved" },
        },
        {
          ...base("tool"),
          kind: "tool.started",
          refs: { toolCallId: "tool" },
          data: {
            toolName: "Read",
            argumentsJson: '{"path":"file"}',
            argumentsHash: createHash("sha256").update('{"path":"file"}').digest("hex"),
            argumentsRedacted: false,
            recoveryMode: "replay_safe",
          },
        },
        {
          ...base("result"),
          partial: false,
          visibility: "model",
          kind: "tool.result.recorded",
          refs: { toolCallId: "tool" },
          data: {
            toolName: "Read",
            status: "succeeded",
            body: {
              storage: "inline",
              content: "result",
              sizeBytes: 6,
              sha256: createHash("sha256").update("result").digest("hex"),
            },
            projection: {
              version: 1,
              mode: "full",
              text: "result",
              strategy: "full",
              truncated: false,
            },
          },
        },
        { ...base("end"), partial: false, kind: "run.terminal", data: { status: "completed" } },
      ];
      await store.appendBatch(events, { ownerFence });
    }
    store.close();
    const first = querySessionExecution(root, { sessionId: "session" });
    assert.equal(first.runs.length, 16);
    assert.equal(first.runs[0]?.runId, "run-17");
    assert.equal(first.summary.modelCalls, 18);
    assert.equal(first.summary.inputTokens, 90);
    assert.equal(first.coverage.modelAttempts, "logical_only");
    assert.equal(first.runs[0]?.steps[0]?.output, "思考：thinking\n\nresponse");
    assert.equal(first.runs[0]?.steps.find((s) => s.kind === "permission")?.status, "completed");
    assert.equal(first.runs[0]?.steps.find((s) => s.kind === "tool")?.output, "result");
    const reopened = new SqliteRuntimeEventStore({ storageRoot: root });
    try {
      await reopened.append(
        {
          schemaVersion: 2,
          eventId: "new-start",
          sessionId: "session",
          invocationId: "new",
          runId: "new",
          turnId: "new",
          at: "2026-09-22T01:00:00.000Z",
          partial: false,
          visibility: "internal",
          kind: "run.started",
          data: { workDir: root, agentSwarmAuthorization: "none" },
        },
        { ownerFence },
      );
    } finally {
      reopened.close();
    }
    const second = querySessionExecution(root, { sessionId: "session", cursor: first.nextCursor! });
    assert.deepEqual(
      second.runs.map((r) => r.runId),
      ["run-1", "run-0"],
    );
    assert.deepEqual(second.summary, first.summary);
    assert.equal(second.nextCursor, undefined);
    assert.equal(
      querySessionExecution(root, { sessionId: "session", runId: "run-3" }).runs[0]?.runId,
      "run-3",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized runs advance cursors and missing settlements remain visible", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-execution-boundary-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    await store.initializeSession({ sessionId: "other", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    for (let n = 0; n < 17; n++) {
      const base = {
        schemaVersion: 2 as const,
        sessionId: "session",
        invocationId: `i${n}`,
        runId: `r${n}`,
        turnId: `t${n}`,
        at: "2026-09-22T00:00:00.000Z",
        partial: false,
        visibility: "internal" as const,
      };
      await store.appendBatch(
        [
          {
            ...base,
            eventId: `start${n}`,
            kind: "run.started",
            data: { workDir: root, agentSwarmAuthorization: "none" },
          },
          ...(n === 16
            ? [
                {
                  ...base,
                  eventId: "huge",
                  kind: "message.committed" as const,
                  data: { message: { role: "user" as const, content: "x".repeat(513 * 1024) } },
                },
              ]
            : [
                {
                  ...base,
                  eventId: `model${n}`,
                  partial: false,
                  kind: "model.call.started" as const,
                  data: { providerCallId: "pending", purpose: "main" },
                },
              ]),
        ],
        { ownerFence },
      );
    }
    store.close();
    const page = querySessionExecution(root, { sessionId: "session" });
    assert.deepEqual(page.coverage.oversizedRunIds, ["r16"]);
    assert.ok(page.coverage.missingModelCallRunIds.includes("r15"));
    assert.ok(page.coverage.incompleteRunIds.includes("r15"));
    assert.equal(page.summary.costCNY, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024);
    assert.throws(
      () => querySessionExecution(root, { sessionId: "other", cursor: page.nextCursor! }),
      /cursor/,
    );
    assert.throws(
      () => querySessionExecution(root, { sessionId: "session", cursor: "garbage" }),
      /cursor/,
    );
    assert.throws(
      () => querySessionExecution(root, { sessionId: "other", runId: "r0" }),
      /Run not found/,
    );
    const next = querySessionExecution(root, { sessionId: "session", cursor: page.nextCursor! });
    assert.deepEqual(
      next.runs.map((r) => r.runId),
      ["r0"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
