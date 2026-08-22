import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";

// 项目侧 model 默认路由退役（2026-08-17）：模型路由与用户凭据强耦合，
// 项目配置只能引用路由 ID、无法保证其存在于用户侧。实测事故：项目钉死
// 已删除的 provider（lez/qwen3.8-max），用户级默认已切新路由，但工作区
// 所有新会话仍按项目值解析并直接报错挡启动。字段解析保留，值不再参与。
test("project model 字段不再覆盖用户级默认路由（即使指向不存在的路由）", async (context) => {
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

  // 项目配置钉一个用户侧根本不存在的路由——退役前这会覆盖用户级默认。
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(
    join(workDir, ".pico", "config.json"),
    JSON.stringify({ version: 1, model: "ghost-provider/ghost-model" }),
    { flag: "w" },
  );

  const resolver = new EffectiveConfigResolver({ userConfigStore: store });
  const effective = await resolver.resolve({
    workDir,
    projectTrusted: true,
    env: {},
    legacyProvider: "openai",
  });

  assert.equal(
    effective.defaultModelRouteId,
    "user-side/default-model",
    "默认路由必须来自用户级，不受项目 model 字段影响",
  );
  assert.equal(
    effective.sources["defaults.modelRouteId"],
    "user",
    "defaults.modelRouteId 的来源必须标记为 user",
  );
});

test("用户级未配置默认时项目 model 也不注入（不再回落到项目值）", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-model-retired-nouser-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(
    join(workDir, ".pico", "config.json"),
    JSON.stringify({ version: 1, model: "ghost-provider/ghost-model" }),
    { flag: "w" },
  );

  const store = new UserConfigStore({ picoHome });
  const resolver = new EffectiveConfigResolver({ userConfigStore: store });
  const effective = await resolver.resolve({
    workDir,
    projectTrusted: true,
    env: {},
    legacyProvider: "openai",
  });

  assert.equal(
    effective.defaultModelRouteId,
    undefined,
    "用户级无默认且无 legacy env 时，项目 model 不得注入默认路由",
  );
});

test("裸 LLM 环境变量不再注入 provider 或默认路由", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-legacy-env-retired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });

  const store = new UserConfigStore({ picoHome });
  const effective = await new EffectiveConfigResolver({ userConfigStore: store }).resolve({
    workDir,
    projectTrusted: false,
    env: {
      LLM_BASE_URL: "https://legacy.invalid/v1",
      LLM_MODEL: "legacy-model",
      LLM_MODELS: "legacy-model,legacy-model-2",
      LLM_API_KEY: "legacy-secret",
    },
    legacyProvider: "openai",
  });

  assert.deepEqual(effective.providers, {});
  assert.deepEqual(effective.defaults, {});
  assert.equal(effective.defaultModelRouteId, undefined);
  assert.equal(effective.sources["providers.legacy"], undefined);
  assert.equal(effective.sources["defaults.modelRouteId"], undefined);
});
