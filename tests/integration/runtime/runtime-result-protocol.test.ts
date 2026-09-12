import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
} from "../../../packages/protocol/src/index.js";

test("session.get accepts durable parent navigation and current optional metadata", () => {
  const session = {
    sessionId: "child",
    workspacePath: "/child-worktree",
    title: "Local Read",
    status: "active",
    pinned: false,
    createdAt: 1,
    updatedAt: 2,
  };
  assert.deepEqual(parseRuntimeResult("session.get", { session }), { session });
  const linked = {
    ...session,
    parentSession: {
      sessionId: "parent",
      workspacePath: "/parent-project",
      agentName: "Local Read",
    },
  };
  assert.deepEqual(parseRuntimeResult("session.get", { session: linked }), {
    session: linked,
  });
  for (const parentSession of [
    null,
    { sessionId: "parent" },
    { sessionId: "", workspacePath: "/parent-project" },
  ]) {
    assert.throws(() =>
      parseRuntimeResult("session.get", { session: { ...session, parentSession } }),
    );
  }
});

test("resource diagnostics reject the retired legacy origin", () => {
  const result = {
    workDir: "/workspace",
    picoHome: "/state",
    workspaceStateRoot: "/state/workspaces/demo",
    entries: [
      {
        kind: "skills",
        origin: "pico-native",
        path: "/workspace/.pico/skills",
        status: "present",
        authority: true,
      },
    ],
    findings: [],
    output: "ok",
  } as const;
  assert.deepEqual(parseRuntimeResult("diagnostics.resources", result), result);
  assert.throws(() =>
    parseRuntimeResult("diagnostics.resources", {
      ...result,
      entries: [{ ...result.entries[0], origin: "legacy" }],
    }),
  );
});

test("rewind.apply keeps one strict v2 request/result contract", () => {
  const baseParams = {
    workspacePath: "/workspace",
    sessionId: "source",
    checkpointId: "checkpoint",
    expectedFingerprint: "fingerprint",
    mode: "both",
    idempotencyKey: "rewind-both",
  } as const;
  assert.deepEqual(parseStrictRuntimeParams("rewind.apply", baseParams), baseParams);
  for (const mode of ["code", "conversation", "both"] as const) {
    const params = { ...baseParams, mode, idempotencyKey: `rewind-${mode}` };
    assert.deepEqual(parseStrictRuntimeParams("rewind.apply", params), params);
  }
  assert.throws(() =>
    parseStrictRuntimeParams("rewind.apply", { ...baseParams, sourceSessionId: "source" }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("rewind.apply", { ...baseParams, idempotencyKey: "" }),
  );
  const { mode: _mode, ...withoutMode } = baseParams;
  assert.throws(() => parseStrictRuntimeParams("rewind.apply", withoutMode));
  const { idempotencyKey: _idempotencyKey, ...withoutIdempotencyKey } = baseParams;
  assert.throws(() => parseStrictRuntimeParams("rewind.apply", withoutIdempotencyKey));

  const legacy = { applied: true, sessionId: "target" } as const;
  const current = { ...legacy, sourceSessionId: "source" } as const;
  assert.deepEqual(parseRuntimeResult("rewind.apply", current), current);
  assert.throws(() => parseRuntimeResult("rewind.apply", legacy));
  assert.throws(() =>
    parseRuntimeResult("rewind.apply", { ...current, unexpected: "protocol-drift" }),
  );
  assert.throws(() => parseRuntimeResult("rewind.apply", { ...legacy, sourceSessionId: "" }));
});

test("rewind.list requires the current changed-file summary", () => {
  const checkpoint = {
    checkpointId: "checkpoint",
    label: "prompt",
    createdAt: 1,
    changedFileCount: 2,
    additions: 3,
    deletions: 1,
  } as const;
  assert.deepEqual(parseRuntimeResult("rewind.list", { checkpoints: [checkpoint] }), {
    checkpoints: [checkpoint],
  });
  const { changedFileCount: _changedFileCount, ...retiredSummary } = checkpoint;
  assert.throws(() => parseRuntimeResult("rewind.list", { checkpoints: [retiredSummary] }));
});

test("Runtime result boundary rejects malformed responses for previously unchecked methods", () => {
  assert.throws(
    () => parseRuntimeResult("config.get", { config: [], version: "1" }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeProtocolError);
      assert.equal(error.code, RUNTIME_ERROR_CODES.INVALID_REQUEST);
      return true;
    },
  );
});

test("Runtime result boundary accepts the declared config.get response", () => {
  const result = { config: { model: "demo" }, version: 1 } as const;
  assert.deepEqual(parseRuntimeResult("config.get", result), result);
});

test("daemon-only Runtime methods use the same fail-closed result decoder", () => {
  assert.deepEqual(parseRuntimeResult("terminal.stopAll", { stopped: 2 }), { stopped: 2 });
  assert.throws(
    () => parseRuntimeResult("terminal.stopAll", { stopped: -1 }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeProtocolError);
      assert.equal(error.code, RUNTIME_ERROR_CODES.INVALID_REQUEST);
      return true;
    },
  );

  assert.throws(() =>
    parseRuntimeResult("provider.list", {
      providers: [
        {
          id: "demo",
          protocol: "openai",
          baseURL: "https://example.test/v1",
          apiKeyEnv: "DEMO_API_KEY",
          models: ["demo-model"],
          discoverModels: false,
          modelCapabilities: [],
          origin: "user",
          fingerprint: "fp-demo",
          credentialStatus: "missing",
          credentialSource: "none",
          storedCredentialPresent: false,
        },
      ],
      revision: "rev-1",
    }),
  );
});

test("session continuity accepts projected tool identity metadata", () => {
  const result = {
    session: {
      sessionId: "session-1",
      workspacePath: "/workspace",
      title: "Session",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    },
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    nextSequence: 1,
    watermark: {
      historyEpoch: "history-1",
      projectorVersion: 4,
      throughSequence: 1,
    },
    durableTail: [
      {
        itemId: "tool:call-1",
        itemRevision: 1,
        positionSequence: 1,
        positionOrdinal: 0,
        item: {
          id: "tool:call-1",
          kind: "tool",
          name: "write_file",
          args: '{"path":"smoke.txt"}',
          status: "running",
          data: { toolCallId: "call-1", providerCallId: "provider-1", entryId: "entry-1" },
        },
      },
    ],
    activeOverlay: [],
    queuedInputs: [],
  } as const;

  assert.deepEqual(parseRuntimeResult("session.subscription.open", result), result);
});

test("transcript result boundary rejects retired tool, run and interaction aliases", () => {
  const envelope = {
    version: 1,
    toolCallId: "provider-1",
    toolName: "read_file",
    status: "succeeded",
    rawSizeBytes: 2,
    sha256: "a".repeat(64),
    deliveryTruncated: false,
    projection: {
      version: 1,
      mode: "full",
      text: "ok",
      strategy: "full",
      truncated: false,
    },
  } as const;
  const result = (item: unknown) => ({
    watermark: {
      historyEpoch: "history-1",
      projectorVersion: 4,
      throughSequence: 1,
    },
    items: [
      {
        itemId: "item-1",
        itemRevision: 1,
        positionSequence: 1,
        positionOrdinal: 0,
        item,
      },
    ],
  });
  const terminal = {
    id: "tool:call-1",
    kind: "tool",
    name: "read_file",
    args: "{}",
    status: "success",
    data: { providerCallId: "provider-1" },
    result: envelope,
  } as const;
  assert.deepEqual(
    parseRuntimeResult("session.transcript.page", result(terminal)),
    result(terminal),
  );
  for (const current of [
    {
      id: "approval:tool",
      kind: "approval",
      title: "Approve tool",
      detail: "Run read_file",
      state: "waiting",
      data: {
        approvalId: "tool",
        runId: "run-1",
        kind: "tool",
        title: "Approve tool",
        detail: "Run read_file",
        risk: "low",
        toolName: "read_file",
        args: "{}",
        providerCallId: "provider-1",
      },
    },
    {
      id: "approval:plan",
      kind: "approval",
      title: "Approve plan",
      detail: "Execute plan",
      state: "waiting",
      data: {
        approvalId: "plan",
        runId: "run-1",
        kind: "plan",
        title: "Approve plan",
        detail: "Execute plan",
        risk: "high",
        planId: "plan-1",
        expectedRevision: 1,
        expectedSessionSequence: 0,
        controlEpoch: "epoch-1",
        operationId: "operation-1",
      },
    },
    {
      id: "approval:done",
      kind: "approval",
      title: "Approval granted",
      state: "allow_session",
      data: { approvalId: "done", runId: "run-1", decision: "allow_session" },
    },
    {
      id: "prompt:waiting",
      kind: "prompt",
      title: "Choose",
      state: "waiting",
      data: { promptId: "waiting", runId: "run-1", options: [{ optionId: "1" }] },
    },
    {
      id: "prompt:answered",
      kind: "prompt",
      title: "Question answered",
      state: "answered",
      data: { promptId: "answered", runId: "run-1" },
    },
  ]) {
    assert.deepEqual(
      parseRuntimeResult("session.transcript.page", result(current)),
      result(current),
    );
  }

  for (const retired of [
    { ...terminal, result: undefined },
    {
      id: "tool:call-1",
      kind: "tool",
      name: "read_file",
      args: "{}",
      status: "running",
      data: { toolCallId: "call-1", providerCallId: "provider-1", entryId: "entry-1" },
      result: envelope,
    },
    { ...terminal, providerCallId: "provider-1" },
    { ...terminal, result: { ...envelope, toolName: "write_file" } },
    { ...terminal, result: { ...envelope, status: "failed" } },
    {
      id: "run:1",
      kind: "runBoundary",
      runId: "run-1",
      status: "completed",
      startedAt: 1,
    },
    {
      id: "run:1",
      kind: "runBoundary",
      runId: "run-1",
      status: "failed",
      startedAt: 1,
      detail: "old failure alias",
    },
    {
      id: "approval:1",
      kind: "approval",
      title: "Approval granted",
      state: "allowed",
      data: { approvalId: "1", runId: "run-1", decision: "allowed" },
    },
    {
      id: "prompt:1",
      kind: "prompt",
      title: "Question answered",
      state: "resolved",
      data: { promptId: "1", runId: "run-1" },
    },
    { id: "message:1", kind: "userMessage", content: "hello", providerCallId: "old" },
    { id: "message:1", kind: "userMessage", content: "hello", truncated: true },
  ]) {
    assert.throws(() => parseRuntimeResult("session.transcript.page", result(retired)));
  }
});
