import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStrictRuntimeParams, publicProviderEndpoint } from "@pico/protocol";
import { parseRemoteRequest, toRuntimeParams } from "@pico/protocol/remote";

test("public patch boundary: remote input cannot opt into local flags, Host patch preserves strict modes", () => {
  const rpc = {
    version: 1,
    requestId: "patch",
    method: "mcp.user.upsert",
    params: {
      server: { name: "private-server", transport: "http" },
      expectedRevision: "r",
      idempotencyKey: "k",
    },
    secretEdits: { headers: { Authorization: { action: "keep" } } },
  };
  const params = toRuntimeParams(parseRemoteRequest(rpc));
  assert.equal((params as Record<string, unknown>).inputMode, "public-patch");
  assert.ok((params as Record<string, unknown>).secretEdits);
  for (const flag of ["inputMode", "secretEdits", "replayOnly"])
    assert.throws(() => parseRemoteRequest({ ...rpc, params: { ...rpc.params, [flag]: true } }));
  assert.throws(() => parseStrictRuntimeParams("mcp.user.upsert", rpc.params));
  assert.throws(() =>
    parseStrictRuntimeParams("mcp.user.upsert", {
      ...params,
      secretEdits: JSON.parse('{"headers":{"__proto__":{"action":"set","value":"fixture"}}}'),
    }),
  );
  assert.doesNotThrow(() =>
    parseStrictRuntimeParams("session.send", {
      workspacePath: "/workspace",
      input: { kind: "text", text: "x" },
      idempotencyKey: "k",
      replayOnly: true,
    }),
  );
  assert.throws(() =>
    parseStrictRuntimeParams("sideChat.create", {
      workspacePath: "/workspace",
      sourceSessionId: "s",
      panelId: "p",
      idempotencyKey: "k",
      replayOnly: true,
    }),
  );
  assert.equal(
    publicProviderEndpoint("https://user:fixture@provider.example/v1?token=fixture#fragment"),
    "https://provider.example/v1",
  );
});
