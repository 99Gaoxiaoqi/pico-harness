import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { loadPicoProjectConfig } from "../../src/input/pico-config.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import type { CredentialVault } from "../../src/provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../../src/provider/effective-model-runtime.js";
import { createProvider } from "../../src/provider/factory.js";

test("user config apiKey stays private and powers the effective model runtime without env", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-config-api-key-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });
  const secret = "user-config-secret-value";
  const store = new UserConfigStore({ picoHome });
  const empty = await store.read();
  const written = await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "configured/test-model" },
      providers: {
        configured: {
          protocol: "openai",
          baseURL: "https://configured.invalid/v1",
          apiKeyEnv: "CONFIGURED_API_KEY",
          apiKey: `  ${secret}  `,
          models: ["test-model"],
          discoverModels: false,
        },
        keychain: {
          protocol: "openai",
          baseURL: "https://keychain.invalid/v1",
          apiKeyEnv: "KEYCHAIN_API_KEY",
          models: ["keychain-model"],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: empty.revision },
  );

  assert.equal(written.config.providers.configured?.apiKey, secret);
  assert.equal((await stat(picoHome)).mode & 0o777, 0o700);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);

  const resolver = new EffectiveConfigResolver({ userConfigStore: store });
  const effective = await resolver.resolve({
    workDir,
    projectTrusted: false,
    env: {},
    legacyProvider: "openai",
  });
  const publicSnapshot = JSON.stringify(effective);
  assert.equal(publicSnapshot.includes(secret), false);
  assert.equal(Object.hasOwn(effective.providers.configured ?? {}, "apiKey"), false);
  assert.deepEqual(Object.keys(effective.providers.configured ?? {}).sort(), [
    "apiKeyEnv",
    "baseURL",
    "discoverModels",
    "models",
    "protocol",
  ]);

  let vaultResolveCalls = 0;
  const vault: CredentialVault = {
    capability: () => ({
      available: true,
      backend: "macos-keychain",
      diagnostic: "test vault",
    }),
    async resolve() {
      vaultResolveCalls++;
      return "keychain-secret";
    },
    async put() {},
    async has() {
      return true;
    },
    async delete() {},
  };
  const runtime = await loadEffectiveModelRuntime({
    workDir,
    projectTrusted: false,
    legacyProvider: "openai",
    legacyModel: "test-model",
    env: { KEYCHAIN_API_KEY: "environment-secret-must-not-win" },
    userConfigStore: store,
    configResolver: resolver,
    credentialVault: vault,
  });
  assert.equal(runtime.credentials.configured?.state, "config");
  assert.equal(runtime.credentials.keychain?.state, "keychain");
  assert.equal(vaultResolveCalls, 1, "the configured Provider must bypass keychain lookup");
  assert.equal(
    runtime.router.providerConfig("keychain/keychain-model").config.apiKey,
    "keychain-secret",
  );
  assert.equal(JSON.stringify(runtime.config).includes(secret), false);
  assert.equal(JSON.stringify(runtime.router.routes).includes(secret), false);

  const originalFetch = globalThis.fetch;
  context.after(() => void (globalThis.fetch = originalFetch));
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json({
      choices: [{ message: { role: "assistant", content: "configured key works" } }],
    });
  };
  const selected = runtime.router.providerConfig("configured/test-model");
  const response = await createProvider(selected.provider, selected.config).generate(
    [{ role: "user", content: "ping" }],
    [],
  );
  assert.equal(response.content, "configured key works");
  assert.equal(authorization, `Bearer ${secret}`);
});

test("project config rejects plaintext apiKey without echoing its value", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-config-api-key-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, ".pico");
  await mkdir(configDir, { recursive: true });
  const secret = "project-secret-must-not-appear";
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      version: 1,
      providers: {
        forbidden: {
          protocol: "openai",
          baseURL: "https://project.invalid/v1",
          apiKeyEnv: "PROJECT_API_KEY",
          apiKey: secret,
          models: ["test-model"],
          discoverModels: false,
        },
      },
    }),
  );

  await assert.rejects(loadPicoProjectConfig(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /providers\.forbidden\.apiKey/u);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("user config rejects an empty apiKey without echoing neighboring secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-empty-user-api-key-"));
  try {
    const store = new UserConfigStore({ picoHome: root });
    const initial = await store.read();
    await assert.rejects(
      store.write(
        {
          version: 1,
          providers: {
            invalid: {
              protocol: "openai",
              baseURL: "https://user.invalid/v1",
              apiKeyEnv: "USER_API_KEY",
              apiKey: "   ",
              models: ["test-model"],
              discoverModels: false,
            },
          },
        },
        { expectedRevision: initial.revision },
      ),
      /providers\.invalid\.apiKey.*non-empty/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
