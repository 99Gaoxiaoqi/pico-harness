import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigLockTimeoutError,
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

  it("never steals an old lock from a paused writer whose process is still alive", async () => {
    const picoHome = await mkdtemp(join(tmpdir(), "pico-user-config-live-lock-"));
    const contender = new UserConfigStore({
      picoHome,
      staleLockMs: 1,
      lockTimeoutMs: 100,
    });
    const initial = await contender.read();
    const liveConfig = userConfig("https://live.example.test/v1", "live");
    const lockHandle = await open(contender.lockPath, "wx", 0o600);
    await lockHandle.writeFile(
      `${JSON.stringify({
        version: 1,
        token: "paused-live-writer",
        pid: process.pid,
        acquiredAt: Date.now() - 60_000,
      })}\n`,
      "utf8",
    );
    await lockHandle.sync();
    await lockHandle.close();
    const old = new Date(Date.now() - 60_000);
    await utimes(contender.lockPath, old, old);

    const resumeWriter = deferred<void>();
    const liveWriter = (async () => {
      await resumeWriter.promise;
      await writeFile(contender.filePath, `${JSON.stringify(liveConfig, null, 2)}\n`, {
        mode: 0o600,
      });
      await unlink(contender.lockPath);
    })();

    try {
      await expect(
        contender.write(userConfig("https://contender.example.test/v1", "contender"), {
          expectedRevision: initial.revision,
        }),
      ).rejects.toBeInstanceOf(UserConfigLockTimeoutError);
    } finally {
      resumeWriter.resolve();
      await liveWriter;
    }

    expect(JSON.parse(await readFile(contender.filePath, "utf8"))).toEqual(liveConfig);
  });

  it("recovers an old lock after its owning process has exited", async () => {
    const picoHome = await mkdtemp(join(tmpdir(), "pico-user-config-dead-lock-"));
    const store = new UserConfigStore({ picoHome, staleLockMs: 1, lockTimeoutMs: 500 });
    const initial = await store.read();
    const deadPid = await exitedProcessId();
    await writeFile(
      store.lockPath,
      `${JSON.stringify({
        version: 1,
        token: "dead-writer",
        pid: deadPid,
        acquiredAt: Date.now() - 60_000,
      })}\n`,
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(store.lockPath, old, old);

    const config = userConfig("https://recovered.example.test/v1", "recovered");
    await expect(
      store.write(config, { expectedRevision: initial.revision }),
    ).resolves.toMatchObject({
      config,
    });
    await expect(lstat(store.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn lock owner process");
  await once(child, "exit");
  return pid;
}

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
