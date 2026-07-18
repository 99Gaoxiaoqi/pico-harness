import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeRequest, type RuntimeRequest } from "../../src/daemon/protocol.js";
import { createDesktopProviderRequestHandlers } from "../../src/daemon/desktop-provider-request-handlers.js";

test("Desktop provider handlers keep protocol mapping and dependency locking in one boundary", async () => {
  const calls: string[] = [];
  const handlers = createDesktopProviderRequestHandlers({
    getUserConfig: () => {
      calls.push("user.get");
      return { kind: "config" };
    },
    updateUserConfig: () => {
      calls.push("user.update");
      return { updated: true };
    },
    listUserProviders: () => {
      calls.push("provider.list");
      return { providers: [] };
    },
    upsertUserProvider: () => {
      calls.push("provider.upsert");
      return { updated: true };
    },
    importEnvironmentProvider: () => {
      calls.push("provider.import");
      return { imported: true };
    },
    deleteUserProvider: () => {
      calls.push("provider.delete");
      return { deleted: true };
    },
    getProviderCredentialStatus: () => {
      calls.push("credential.status");
      return { status: "missing" };
    },
    setProviderCredential: () => {
      calls.push("credential.set");
      return { status: "ready" };
    },
    deleteProviderCredential: () => {
      calls.push("credential.delete");
      return { status: "missing" };
    },
    withProviderDependencyLock: async (operation) => {
      calls.push("lock.start");
      const result = await operation();
      calls.push("lock.end");
      return result;
    },
  });

  assert.deepEqual(
    await handlers["provider.upsert"]!(
      createRuntimeRequest("provider.upsert", {
        provider: {
          id: "fixture",
          protocol: "openai",
          baseURL: "https://example.test/v1",
          apiKeyEnv: "FIXTURE_KEY",
          models: ["fixture-model"],
        },
        expectedRevision: "revision",
      }) as RuntimeRequest<"provider.upsert">,
    ),
    { updated: true },
  );
  assert.deepEqual(
    await handlers["provider.credential.status"]!(
      createRuntimeRequest("provider.credential.status", {
        providerId: "fixture",
      }) as RuntimeRequest<"provider.credential.status">,
    ),
    { status: "missing" },
  );
  assert.deepEqual(calls, ["lock.start", "provider.upsert", "lock.end", "credential.status"]);
});
