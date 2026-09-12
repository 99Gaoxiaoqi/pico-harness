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
          data: { toolCallId: "call-1", entryId: "entry-1" },
        },
      },
    ],
    activeOverlay: [],
    queuedInputs: [],
  } as const;

  assert.deepEqual(parseRuntimeResult("session.subscription.open", result), result);
});
