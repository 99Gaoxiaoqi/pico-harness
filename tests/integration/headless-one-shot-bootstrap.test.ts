import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapHeadlessCaseJson } from "../../src/internal/headless-bootstrap.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { loadModelRouter } from "../../src/provider/model-router.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

test("headless bootstrap writes secret-free pinned routes and trusts the isolated workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

  const canonicalWorkspace = await realpath(workspacePath);
  for (const modelId of ["gpt-5.4", "gpt-5.6-terra"] as const) {
    const picoHome = join(root, `pico-home-${modelId}`);
    await mkdir(picoHome);
    const modelRouteId = `codex-oauth/${modelId}`;
    const outcome = await bootstrapHeadlessCaseJson(
      JSON.stringify({
        schemaVersion: 1,
        workspacePath,
        picoHome,
        route: {
          id: modelRouteId,
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
          output: 8_192,
        },
      }),
    );

    assert.equal(outcome.exitCode, 0, modelId);
    assert.equal(outcome.result.workspacePath, canonicalWorkspace, modelId);
    const snapshot = await new UserConfigStore({ picoHome }).read();
    assert.equal(snapshot.config.defaults?.modelRouteId, modelRouteId, modelId);
    assert.equal(
      snapshot.config.providers["codex-oauth"]?.modelCapabilities?.[modelId]?.output,
      8_192,
      modelId,
    );
    assert.equal(
      snapshot.config.providers["codex-oauth"]?.modelCapabilities?.[modelId]?.outputTokenField,
      "max_completion_tokens",
      modelId,
    );
    const configJson = await readFile(join(picoHome, "config.json"), "utf8");
    assert.doesNotMatch(configJson, /apiKey":/u, modelId);
    assert.match(configJson, /"output": 8192/u, modelId);
    assert.match(configJson, /"outputTokenField": "max_completion_tokens"/u, modelId);
    const router = await loadModelRouter({
      config: {
        model: snapshot.config.defaults?.modelRouteId,
        providers: snapshot.config.providers,
      },
      env: { PICO_TB_GATEWAY_TOKEN: "process-local-fixture-token" },
      legacyProvider: "openai",
      legacyModel: "unused-legacy-model",
    });
    const route = router.require(modelRouteId);
    assert.equal(route.capabilities.maxOutputTokens, 8_192, modelId);
    assert.equal(route.capabilities.outputSource, "config", modelId);
    assert.equal(route.capabilities.outputTokenField, "max_completion_tokens", modelId);
    assert.equal(
      await new WorkspaceTrustStore({ userStateDirectory: picoHome }).isTrusted(canonicalWorkspace),
      true,
      modelId,
    );
  }
});

test("headless bootstrap keeps non-pinned routes compatible with optional output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-compatible-output-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const candidate of [
    {
      name: "missing",
      routeId: "fixture/model",
      modelId: "model",
      output: undefined,
      expectedSource: "profile_default",
    },
    {
      name: "configured",
      routeId: "fixture/model",
      modelId: "model",
      output: 4_096,
      expectedSource: "config",
    },
    {
      name: "slash-model",
      routeId: "fixture/org/model",
      modelId: "org/model",
      output: 4_096,
      expectedSource: "config",
    },
  ] as const) {
    const picoHome = join(root, `pico-home-${candidate.name}`);
    await mkdir(picoHome);
    const outcome = await bootstrapHeadlessCaseJson(
      JSON.stringify({
        schemaVersion: 1,
        workspacePath,
        picoHome,
        route: {
          id: candidate.routeId,
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
          ...(candidate.output === undefined ? {} : { output: candidate.output }),
        },
      }),
    );

    assert.equal(outcome.exitCode, 0, candidate.name);
    const snapshot = await new UserConfigStore({ picoHome }).read();
    assert.equal(
      snapshot.config.providers["fixture"]?.modelCapabilities?.[candidate.modelId]?.output,
      candidate.output,
      candidate.name,
    );
    const router = await loadModelRouter({
      config: {
        model: snapshot.config.defaults?.modelRouteId,
        providers: snapshot.config.providers,
      },
      env: { PICO_TB_GATEWAY_TOKEN: "process-local-fixture-token" },
      legacyProvider: "openai",
      legacyModel: "unused-legacy-model",
    });
    const route = router.require(candidate.routeId);
    assert.equal(route.capabilities.maxOutputTokens, 4_096, candidate.name);
    assert.equal(route.capabilities.outputSource, candidate.expectedSource, candidate.name);
    assert.equal(route.capabilities.outputTokenField, "max_tokens", candidate.name);
  }
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

test("headless bootstrap requires exact unpolluted 8192-token pinned route outputs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-output-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

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

  for (const modelId of ["gpt-5.4", "gpt-5.6-terra"] as const) {
    const baseRequest = {
      schemaVersion: 1,
      picoHome: join(root, "pico-home"),
      workspacePath,
      route: {
        id: `codex-oauth/${modelId}`,
        protocol: "openai",
        baseURL: "https://provider.invalid/v1",
        apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
        output: 8_192,
      },
    };
    for (const candidate of cases) {
      const request = structuredClone(baseRequest) as unknown as Record<string, unknown>;
      request["picoHome"] = join(root, `pico-home-${modelId}-${candidate.name}`);
      candidate.mutate(request);
      const outcome = await bootstrapHeadlessCaseJson(JSON.stringify(request));
      assert.equal(outcome.exitCode, 2, `${modelId}: ${candidate.name}`);
      assert.equal(
        outcome.result.error?.code,
        candidate.errorCode,
        `${modelId}: ${candidate.name}`,
      );
    }
  }
});

test("headless bootstrap rejects unsafe output values on non-pinned routes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-headless-bootstrap-unsafe-output-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const [name, output] of [
    ["null", null],
    ["boolean", true],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "4096"],
    ["object", {}],
    ["array", []],
  ] as const) {
    const outcome = await bootstrapHeadlessCaseJson(
      JSON.stringify({
        schemaVersion: 1,
        picoHome: join(root, `pico-home-${name}`),
        workspacePath,
        route: {
          id: "fixture/model",
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TB_GATEWAY_TOKEN",
          output,
        },
      }),
    );
    assert.equal(outcome.exitCode, 2, name);
    assert.equal(outcome.result.error?.code, "INVALID_ROUTE_OUTPUT", name);
  }
});
