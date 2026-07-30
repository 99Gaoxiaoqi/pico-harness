import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapHeadlessCaseJson } from "../../src/internal/headless-bootstrap.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { loadModelRouter } from "../../src/provider/model-router.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

test("headless bootstrap writes a secret-free route and trusts the isolated workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-"));
  const picoHome = join(root, "pico-home");
  const workspacePath = join(root, "workspace");
  await Promise.all([mkdir(workspacePath), mkdir(picoHome)]);
  context.after(() => rm(root, { recursive: true, force: true }));

  const outcome = await bootstrapHeadlessCaseJson(
    JSON.stringify({
      schemaVersion: 1,
      workspacePath,
      picoHome,
      route: {
        id: "fixture/model",
        protocol: "openai",
        baseURL: "https://provider.invalid/v1",
        apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
        output: 8_192,
      },
    }),
  );

  const canonicalWorkspace = await realpath(workspacePath);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.workspacePath, canonicalWorkspace);
  const snapshot = await new UserConfigStore({ picoHome }).read();
  assert.equal(snapshot.config.defaults?.modelRouteId, "fixture/model");
  assert.equal(snapshot.config.providers["fixture"]?.modelCapabilities?.["model"]?.output, 8_192);
  const configJson = await readFile(join(picoHome, "config.json"), "utf8");
  assert.doesNotMatch(configJson, /apiKey":/u);
  assert.match(configJson, /"output": 8192/u);
  const router = await loadModelRouter({
    config: {
      model: snapshot.config.defaults?.modelRouteId,
      providers: snapshot.config.providers,
    },
    env: { PICO_TB_GATEWAY_TOKEN: "process-local-fixture-token" },
    legacyProvider: "openai",
    legacyModel: "unused-legacy-model",
  });
  const route = router.require("fixture/model");
  assert.equal(route.capabilities.maxOutputTokens, 8_192);
  assert.equal(route.capabilities.outputSource, "config");
  assert.equal(
    await new WorkspaceTrustStore({ userStateDirectory: picoHome }).isTrusted(canonicalWorkspace),
    true,
  );
});

test("headless bootstrap rejects plaintext provider credentials", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-secret-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

  const outcome = await bootstrapHeadlessCaseJson(
    JSON.stringify({
      schemaVersion: 1,
      picoHome: join(root, "pico-home"),
      workspacePath,
      route: {
        id: "fixture/model",
        protocol: "openai",
        baseURL: "https://provider.invalid/v1",
        apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
        output: 8_192,
        apiKey: "secret-canary",
      },
    }),
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.error?.code, "SECRET_FIELD_FORBIDDEN");
});

test("headless bootstrap requires an exact unpolluted 8192-token route output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-output-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

  const baseRequest = {
    schemaVersion: 1,
    picoHome: join(root, "pico-home"),
    workspacePath,
    route: {
      id: "fixture/model",
      protocol: "openai",
      baseURL: "https://provider.invalid/v1",
      apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
      output: 8_192,
    },
  };
  const cases: Array<{
    readonly name: string;
    readonly mutate: (request: Record<string, unknown>) => void;
    readonly errorCode: string;
  }> = [
    {
      name: "missing",
      mutate(request) {
        delete (request["route"] as Record<string, unknown>)["output"];
      },
      errorCode: "INVALID_ROUTE_OUTPUT",
    },
    {
      name: "4096",
      mutate(request) {
        (request["route"] as Record<string, unknown>)["output"] = 4_096;
      },
      errorCode: "INVALID_ROUTE_OUTPUT",
    },
    {
      name: "8193",
      mutate(request) {
        (request["route"] as Record<string, unknown>)["output"] = 8_193;
      },
      errorCode: "INVALID_ROUTE_OUTPUT",
    },
    {
      name: "polluted",
      mutate(request) {
        (request["route"] as Record<string, unknown>)["maxOutputTokens"] = 8_192;
      },
      errorCode: "UNKNOWN_FIELD",
    },
  ];

  for (const candidate of cases) {
    const request = structuredClone(baseRequest) as unknown as Record<string, unknown>;
    request["picoHome"] = join(root, `pico-home-${candidate.name}`);
    candidate.mutate(request);
    const outcome = await bootstrapHeadlessCaseJson(JSON.stringify(request));
    assert.equal(outcome.exitCode, 2, candidate.name);
    assert.equal(outcome.result.error?.code, candidate.errorCode, candidate.name);
  }
});
