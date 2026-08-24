import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDesktopRuntimeResult,
  parseRuntimeResult,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
} from "../../packages/protocol/src/index.js";

test("Runtime result boundary rejects malformed responses for previously unchecked methods", () => {
  assert.throws(
    () => parseDesktopRuntimeResult("config.get", { config: [], version: "1" }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeProtocolError);
      assert.equal(error.code, RUNTIME_ERROR_CODES.INVALID_REQUEST);
      return true;
    },
  );
});

test("Runtime result boundary accepts the declared config.get response", () => {
  const result = { config: { model: "demo" }, version: 1 } as const;
  assert.deepEqual(parseDesktopRuntimeResult("config.get", result), result);
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
