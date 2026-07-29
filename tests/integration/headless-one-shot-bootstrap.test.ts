import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapHeadlessCaseJson } from "../../src/internal/headless-bootstrap.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
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
        apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
      },
    }),
  );

  const canonicalWorkspace = await realpath(workspacePath);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.workspacePath, canonicalWorkspace);
  const snapshot = await new UserConfigStore({ picoHome }).read();
  assert.equal(snapshot.config.defaults?.modelRouteId, "fixture/model");
  assert.doesNotMatch(await readFile(join(picoHome, "config.json"), "utf8"), /apiKey":/u);
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
        apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
        apiKey: "secret-canary",
      },
    }),
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.result.error?.code, "SECRET_FIELD_FORBIDDEN");
});
