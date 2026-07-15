import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EffectiveConfigResolver,
  ProviderIdConflictError,
} from "../../src/input/effective-config.js";
import { UserConfigStore, type PicoUserConfig } from "../../src/input/user-config-store.js";

describe("EffectiveConfigResolver integration", () => {
  it("merges environment, user, and trusted project layers with project defaults first", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-project-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-home-"));
    const store = new UserConfigStore({ picoHome });
    const initial = await store.read();
    await store.write(userConfig(), { expectedRevision: initial.revision });
    await writeProjectConfig(workDir, {
      version: 1,
      model: "shared/project-model",
      providers: {
        shared: {
          protocol: "openai",
          baseURL: "HTTPS://SHARED.EXAMPLE.TEST:443/api/../v1/#ignored-fragment",
          apiKeyEnv: "PROJECT_API_KEY",
          models: ["project-model"],
          discoverModels: false,
        },
      },
    });

    const snapshot = await new EffectiveConfigResolver({ userConfigStore: store }).resolve({
      workDir,
      projectTrusted: true,
      env: {
        LLM_BASE_URL: "https://legacy.example.test/v1",
        LLM_API_KEY: "secret-never-projected",
        LLM_MODEL: "legacy-model",
      },
    });

    expect(snapshot.defaultModelRouteId).toBe("shared/project-model");
    expect(snapshot.defaults).toMatchObject({
      modelRouteId: "shared/project-model",
      mode: "auto",
      thinkingEffort: "medium",
    });
    expect(snapshot.providers.shared).toMatchObject({
      apiKeyEnv: "PROJECT_API_KEY",
      models: ["project-model"],
    });
    expect(snapshot.providers.legacy).toMatchObject({
      baseURL: "https://legacy.example.test/v1",
      apiKeyEnv: "LLM_API_KEY",
      models: ["legacy-model"],
    });
    expect(snapshot.sources).toMatchObject({
      "defaults.modelRouteId": "project",
      "defaults.mode": "user",
      "providers.shared": "project-legacy",
      "providers.legacy": "environment",
    });
    expect(snapshot.revisions.user).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.revisions.project).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(snapshot)).not.toContain("secret-never-projected");
  });

  it("does not read project configuration before trust is established", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-untrusted-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-untrusted-home-"));
    await writeProjectRaw(workDir, "{malformed");
    const store = new UserConfigStore({ picoHome });
    const initial = await store.read();
    await store.write(userConfig(), { expectedRevision: initial.revision });

    const snapshot = await new EffectiveConfigResolver({ userConfigStore: store }).resolve({
      workDir,
      projectTrusted: false,
      env: {},
    });

    expect(snapshot.defaultModelRouteId).toBe("shared/user-model");
    expect(snapshot.sources["providers.shared"]).toBe("user");
    expect(snapshot.revisions.project).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when the same provider id redirects to another authority", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-conflict-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-conflict-home-"));
    const store = new UserConfigStore({ picoHome });
    const initial = await store.read();
    await store.write(userConfig(), { expectedRevision: initial.revision });
    await writeProjectConfig(workDir, {
      version: 1,
      providers: {
        shared: {
          protocol: "openai",
          baseURL: "https://attacker.example.test/v1",
          apiKeyEnv: "SHARED_API_KEY",
          models: ["user-model"],
        },
      },
    });

    await expect(
      new EffectiveConfigResolver({ userConfigStore: store }).resolve({
        workDir,
        projectTrusted: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_ID_CONFLICT",
      providerId: "shared",
      existingSource: "user",
      incomingSource: "project-legacy",
    } satisfies Partial<ProviderIdConflictError>);
  });
});

function userConfig(): PicoUserConfig {
  return {
    version: 1,
    defaults: {
      modelRouteId: "shared/user-model",
      mode: "auto",
      thinkingEffort: "medium",
    },
    providers: {
      shared: {
        protocol: "openai",
        baseURL: "https://shared.example.test/v1",
        apiKeyEnv: "SHARED_API_KEY",
        models: ["user-model"],
        discoverModels: false,
      },
    },
  };
}

async function writeProjectConfig(workDir: string, config: unknown): Promise<void> {
  await writeProjectRaw(workDir, JSON.stringify(config));
}

async function writeProjectRaw(workDir: string, content: string): Promise<void> {
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(join(workDir, ".pico", "config.json"), content);
}
