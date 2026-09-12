import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialRefForProvider,
  parseProviderCredentialRef,
} from "../../../src/provider/credential-vault.js";

test("credential vault only accepts the current provider-scoped reference", () => {
  const current = credentialRefForProvider({
    providerId: "test-provider",
    protocol: "openai",
    baseURL: "https://test.invalid/v1",
  });
  assert.equal(parseProviderCredentialRef(current).providerId, "test-provider");

  assert.throws(
    () =>
      parseProviderCredentialRef(
        `pico-keychain://model-route/v1/${"a".repeat(64)}/${"b".repeat(64)}/test-provider%2Ftest-model`,
      ),
    /不支持的 v2 credentialRef/u,
  );
});
