import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigRevisionConflictError,
  UserConfigStore,
  type PicoUserConfig,
} from "../../src/input/user-config-store.js";

describe("UserConfigStore integration", () => {
  it("atomically persists a validated device config with private permissions and OCC", async () => {
    const picoHome = join(await mkdtemp(join(tmpdir(), "pico-user-config-parent-")), ".pico");
    const firstStore = new UserConfigStore({ picoHome });
    const secondStore = new UserConfigStore({ picoHome });
    const initial = await firstStore.read();

    expect(initial).toEqual({
      config: { version: 1, providers: {} },
      revision: EMPTY_USER_CONFIG_REVISION,
    });
    expect(initial.revision).toMatch(/^[a-f0-9]{64}$/u);

    const config = userConfig("https://models.example.test/v1", "alpha");
    const [firstWrite, secondWrite] = await Promise.allSettled([
      firstStore.write(config, { expectedRevision: initial.revision }),
      secondStore.write(userConfig("https://models.example.test/v1", "beta"), {
        expectedRevision: initial.revision,
      }),
    ]);
    const outcomes = [firstWrite, secondWrite];
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(UserConfigRevisionConflictError),
    });

    const persisted = await firstStore.read();
    expect(persisted.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.revision).not.toBe(initial.revision);
    expect(JSON.parse(await readFile(firstStore.filePath, "utf8"))).toEqual(persisted.config);
    expect((await stat(picoHome)).mode & 0o777).toBe(0o700);
    expect((await stat(firstStore.filePath)).mode & 0o777).toBe(0o600);
    await expect(lstat(firstStore.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupt files and symbolic links instead of recovering unsafely", async () => {
    const corruptHome = await mkdtemp(join(tmpdir(), "pico-user-config-corrupt-"));
    await writeFile(join(corruptHome, "config.json"), "{not-json", { mode: 0o600 });
    await expect(new UserConfigStore({ picoHome: corruptHome }).read()).rejects.toThrow(
      /JSON 已损坏/u,
    );

    const symlinkHome = await mkdtemp(join(tmpdir(), "pico-user-config-symlink-"));
    const outside = join(symlinkHome, "outside.json");
    await writeFile(outside, JSON.stringify({ version: 1, providers: {} }));
    await symlink(outside, join(symlinkHome, "config.json"));
    await expect(new UserConfigStore({ picoHome: symlinkHome }).read()).rejects.toThrow(
      /符号链接/u,
    );

    const parent = await mkdtemp(join(tmpdir(), "pico-user-config-home-link-"));
    const target = join(parent, "target");
    await mkdir(target);
    const linkedHome = join(parent, "linked-home");
    await symlink(target, linkedHome, "dir");
    await expect(new UserConfigStore({ picoHome: linkedHome }).read()).rejects.toThrow(
      /PICO_HOME.*符号链接/u,
    );
  });

  it("validates schema v1 before acquiring the write lock", async () => {
    const picoHome = await mkdtemp(join(tmpdir(), "pico-user-config-schema-"));
    const store = new UserConfigStore({ picoHome });
    const initial = await store.read();
    const invalid = {
      version: 1,
      defaults: { modelRouteId: "missing-separator" },
      providers: {},
    } as unknown as PicoUserConfig;

    await expect(store.write(invalid, { expectedRevision: initial.revision })).rejects.toThrow(
      "defaults.modelRouteId",
    );
    await expect(lstat(store.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function userConfig(baseURL: string, model: string): PicoUserConfig {
  return {
    version: 1,
    defaults: { modelRouteId: `shared/${model}`, mode: "yolo", thinkingEffort: "high" },
    providers: {
      shared: {
        protocol: "openai",
        baseURL,
        apiKeyEnv: "SHARED_API_KEY",
        models: [model],
        discoverModels: false,
      },
    },
  };
}
