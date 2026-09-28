import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EffectiveConfigResolver } from "@pico/pico-host/input/effective-config";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { loadEffectiveModelRuntime } from "@pico/pico-host/provider/effective-model-runtime";

test("single-route reads bypass discovery only for an exact valid configured model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-configured-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const store = new UserConfigStore({ picoHome: join(root, "home") });
  const empty = await store.read();
  await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "fixture/configured" },
      providers: {
        fixture: {
          protocol: "openai",
          baseURL: "https://fixture.invalid/v1",
          apiKeyEnv: "FIXTURE_KEY",
          apiKey: "fixture-secret",
          models: ["configured"],
          discoverModels: true,
        },
      },
    },
    { expectedRevision: empty.revision },
  );
  let requests = 0;
  const options = {
    workDir,
    projectTrusted: false,
    env: {},
    userConfigStore: store,
    configResolver: new EffectiveConfigResolver({ userConfigStore: store }),
    fetch: (async () => {
      requests++;
      return Response.json({ data: [{ id: "discovered" }] });
    }) as typeof fetch,
  };
  const configured = await loadEffectiveModelRuntime({
    ...options,
    preferredModelRouteId: "fixture/configured",
  });
  assert.equal(requests, 0, "configured settings reads must not wait on /models");
  assert.equal(
    configured.router.providerConfig("fixture/configured").config.apiKey,
    "fixture-secret",
  );
  assert.equal(
    configured.config.providers.fixture?.discoverModels,
    true,
    "durable discovery preference stays enabled",
  );

  const discovered = await loadEffectiveModelRuntime({
    ...options,
    preferredModelRouteId: "fixture/discovered",
  });
  assert.equal(requests, 1, "a model absent from configured routes still uses discovery");
  assert.equal(discovered.router.require("fixture/discovered").source, "discovered");
  const complete = await loadEffectiveModelRuntime(options);
  assert.equal(requests, 2, "full runtime/catalog assembly keeps discovery");
  assert.equal(complete.router.require("fixture/discovered").model, "discovered");
});

test("advertised discovered routes survive transient lookup failures without crossing connection boundaries", async () => {
  const { loadModelRouter } = await import("@pico/pico-host/provider/model-router");
  let response: "success" | "failure" | "empty" = "success";
  const target = "deepseek-v4-flash-vision-exp";
  const provider = {
    protocol: "openai" as const,
    baseURL: "https://discovery-fallback.invalid/v1",
    apiKeyEnv: "FIXTURE_KEY",
    models: ["glm-5.2", "kimi-k2.7-code"],
    discoverModels: true,
  };
  const options = {
    config: { providers: { "opencode-go": provider } },
    env: { FIXTURE_KEY: "first-credential" },
    fetch: (async () =>
      response === "failure"
        ? new Response("unavailable", { status: 503 })
        : Response.json({ data: response === "empty" ? [] : [{ id: target }] })) as typeof fetch,
  };
  assert.ok((await loadModelRouter(options)).resolve(`opencode-go/${target}`));
  response = "failure";
  assert.ok(
    (await loadModelRouter(options)).resolve(`opencode-go/${target}`),
    "clicking an advertised model still resolves after a transient directory failure",
  );
  assert.equal(
    (await loadModelRouter({ ...options, env: { FIXTURE_KEY: "changed-credential" } })).resolve(
      `opencode-go/${target}`,
    ),
    undefined,
  );
  assert.equal(
    (
      await loadModelRouter({
        ...options,
        config: {
          providers: { "opencode-go": { ...provider, baseURL: "https://other.invalid/v1" } },
        },
      })
    ).resolve(`opencode-go/${target}`),
    undefined,
  );
  assert.equal(
    (
      await loadModelRouter({
        ...options,
        config: { providers: { "opencode-go": { ...provider, disabledModels: [target] } } },
      })
    ).resolve(`opencode-go/${target}`),
    undefined,
  );
  assert.equal(
    (
      await loadModelRouter({
        ...options,
        config: { providers: { "opencode-go": { ...provider, discoverModels: false } } },
      })
    ).resolve(`opencode-go/${target}`),
    undefined,
  );
  response = "empty";
  assert.equal(
    (await loadModelRouter(options)).resolve(`opencode-go/${target}`),
    undefined,
    "a successful empty catalog replaces the stale one",
  );
  response = "failure";
  assert.equal((await loadModelRouter(options)).resolve(`opencode-go/${target}`), undefined);
});
