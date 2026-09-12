import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  isRuntimeMethod,
  RUNTIME_METHODS,
} from "../../../packages/protocol/src/index.js";
import { EffectiveConfigResolver } from "../../../src/input/effective-config.js";
import { loadPicoProjectConfig } from "../../../src/input/pico-config.js";
import { UserConfigStore } from "../../../src/input/user-config-store.js";

test("current project config loads while model routes remain user-scoped", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-model-retired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });

  const store = new UserConfigStore({ picoHome });
  const empty = await store.read();
  await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "user-side/default-model" },
      providers: {
        "user-side": {
          protocol: "openai",
          baseURL: "https://user-side.invalid/v1",
          apiKeyEnv: "USER_SIDE_API_KEY",
          apiKey: "user-side-secret",
          models: ["default-model"],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: empty.revision },
  );

  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(
    join(workDir, ".pico", "config.json"),
    JSON.stringify({
      version: 1,
      commandsDir: "project-commands",
      sandbox: { network: "allow" },
      extensionOwnedField: { enabled: true },
    }),
    { flag: "w" },
  );

  const project = await loadPicoProjectConfig(workDir);
  assert.equal(project.commandsDir, join(workDir, "project-commands"));
  assert.equal("providers" in project, false);

  const resolver = new EffectiveConfigResolver({ userConfigStore: store });
  const effective = await resolver.resolve({
    workDir,
    projectTrusted: true,
  });

  assert.equal(effective.defaultModelRouteId, "user-side/default-model", "默认路由必须来自用户级");
  assert.equal(
    effective.sources["defaults.modelRouteId"],
    "user",
    "defaults.modelRouteId 的来源必须标记为 user",
  );
});

test("project config rejects retired model and providers fields", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-model-retired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  const configPath = join(workDir, ".pico", "config.json");

  for (const [field, retired] of [
    ["model", { model: "ghost-provider/ghost-model" }],
    ["providers", { providers: {} }],
  ] as const) {
    await writeFile(configPath, JSON.stringify({ version: 1, ...retired }), { flag: "w" });
    await assert.rejects(
      loadPicoProjectConfig(workDir),
      new RegExp(`${field}.*no longer supported in project config`, "u"),
    );
  }
});

test("runtime contracts no longer expose project provider listing", () => {
  assert.equal((RUNTIME_METHODS as readonly string[]).includes("config.providers"), false);
  assert.equal((DESKTOP_RUNTIME_METHODS as readonly string[]).includes("config.providers"), false);
  assert.equal(isRuntimeMethod("config.providers"), false);
});
