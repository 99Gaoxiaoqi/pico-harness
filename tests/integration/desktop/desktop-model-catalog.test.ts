import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  MODEL_CATALOG_RUNTIME_CAPABILITY,
  parseRuntimeResult,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import type { CredentialVault } from "@pico/pico-host/provider/credential-vault";

// Assemble the same real Host services used by desktop-config-revision-token; no model request is needed.
test("Host model catalog projects only enabled effective routes and rejects untrusted folders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-model-catalog-"));
  const picoHome = join(root, "private-home");
  const workspacePath = join(root, "ordinary-folder");
  const untrustedPath = join(root, "untrusted-folder");
  await mkdir(workspacePath);
  await mkdir(join(untrustedPath, ".pico"), { recursive: true });
  await writeFile(join(untrustedPath, ".pico", "config.json"), "not valid JSON");
  const env = { PICO_HOME: picoHome, PICO_CATALOG_ENV_KEY: "synthetic-environment-catalog-secret" };
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const userConfigStore = new UserConfigStore({ picoHome });
  await registrationStore.register(workspacePath);
  await trustStore.trust(await trustStore.canonicalize(workspacePath));
  const unavailable = async (): Promise<never> => {
    throw new Error("synthetic unavailable vault");
  };
  const credentialVault: CredentialVault = {
    capability: () => ({
      available: false,
      backend: "unavailable",
      diagnostic: "unavailable",
      cleanupAvailable: false,
    }),
    put: unavailable,
    resolve: unavailable,
    has: unavailable,
    delete: unavailable,
  };
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    registrationStore,
    userConfigStore,
    credentialVault,
    env,
  });
  t.after(async () => {
    await desktop.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const initial = await userConfigStore.read();
  const configured = await userConfigStore.write(
    {
      version: 1,
      defaults: { modelRouteId: "configured/deep", thinkingEffort: "high" },
      providers: {
        configured: {
          protocol: "openai",
          baseURL: "https://catalog-fixture.invalid/v1?token=synthetic-address-secret",
          apiKeyEnv: "PICO_CATALOG_INLINE_KEY",
          apiKey: "synthetic-inline-catalog-secret",
          discoverModels: false,
          models: ["basic", "deep", "disabled"],
          disabledModels: ["disabled"],
          modelCapabilities: {
            basic: { reasoning: { enabled: false } },
            deep: {
              reasoning: {
                enabled: true,
                defaultLevel: "high",
                levels: ["low", "high"],
                providerOptionsByLevel: {
                  low: { openai: { set: [{ path: ["reasoning_effort"], value: "low" }] } },
                  high: { openai: { set: [{ path: ["reasoning_effort"], value: "high" }] } },
                },
              },
            },
          },
        },
        environment: {
          protocol: "openai",
          baseURL: "https://environment-catalog.invalid/v1",
          apiKeyEnv: "PICO_CATALOG_ENV_KEY",
          discoverModels: false,
          models: ["shared"],
          modelCapabilities: { shared: { reasoning: { enabled: false } } },
        },
        hidden: {
          protocol: "openai",
          baseURL: "https://hidden-catalog.invalid/v1",
          apiKeyEnv: "PICO_CATALOG_HIDDEN_KEY",
          auth: "none",
          discoverModels: false,
          models: ["off"],
          disabledModels: ["off"],
        },
      },
    },
    { expectedRevision: initial.revision },
  );
  const ping = parseRuntimeResult(
    "runtime.ping",
    await desktop.handle(createRuntimeRequest("runtime.ping", {})),
  );
  assert.ok(ping.capabilities.includes(MODEL_CATALOG_RUNTIME_CAPABILITY));
  const catalog = parseRuntimeResult(
    "catalog.models",
    await desktop.handle(createRuntimeRequest("catalog.models", { workspacePath })),
  );
  assert.deepEqual(Object.keys(catalog).sort(), ["defaultModelRouteId", "routes"]);
  assert.equal(catalog.defaultModelRouteId, "configured/deep");
  assert.deepEqual(
    catalog.routes.map(({ id, providerId, model, reasoningLevels }) => ({
      id,
      providerId,
      model,
      reasoningLevels,
    })),
    [
      { id: "configured/basic", providerId: "configured", model: "basic", reasoningLevels: [] },
      {
        id: "configured/deep",
        providerId: "configured",
        model: "deep",
        reasoningLevels: ["low", "high"],
      },
      { id: "environment/shared", providerId: "environment", model: "shared", reasoningLevels: [] },
    ],
  );
  const permitted = new Set(["id", "providerId", "model", "displayName", "reasoningLevels"]);
  for (const route of catalog.routes) {
    assert.ok(
      Object.keys(route).every((key) => permitted.has(key)),
      "catalog routes expose only selection fields",
    );
    assert.equal(route.id, `${route.providerId}/${route.model}`);
  }
  const wire = JSON.stringify(catalog);
  for (const hidden of [
    "synthetic-inline-catalog-secret",
    "synthetic-environment-catalog-secret",
    "synthetic-address-secret",
    "catalog-fixture.invalid",
    "environment-catalog.invalid",
    "hidden-catalog.invalid",
    "PICO_CATALOG_INLINE_KEY",
    "PICO_CATALOG_ENV_KEY",
    "PICO_CATALOG_HIDDEN_KEY",
    workspacePath,
    picoHome,
    "baseURL",
    "apiKey",
    "credentialRef",
    "sourcePath",
  ])
    assert.equal(wire.includes(hidden), false, `catalog must omit ${hidden}`);

  await userConfigStore.write(
    { ...configured.config, defaults: { modelRouteId: "environment/shared" } },
    { expectedRevision: configured.revision },
  );
  const updated = parseRuntimeResult(
    "catalog.models",
    await desktop.handle(createRuntimeRequest("catalog.models", { workspacePath })),
  );
  assert.equal(
    updated.defaultModelRouteId,
    "environment/shared",
    "catalog uses the current effective default, not a stale cached route",
  );
  await assert.rejects(
    desktop.handle(createRuntimeRequest("catalog.models", { workspacePath: untrustedPath })),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.code === RUNTIME_ERROR_CODES.FORBIDDEN &&
      /尚未信任/u.test(error.message),
  );
});
