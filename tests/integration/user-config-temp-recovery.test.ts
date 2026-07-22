import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigLockTimeoutError,
  UserConfigRevisionConflictError,
  UserConfigStore,
  type PicoUserConfig,
} from "../../src/input/user-config-store.js";

test("first read removes only strict orphan temporaries while preserving secure modes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-config-temp-recovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const orphan = join(root, temporaryName("11111111-1111-4111-8111-111111111111"));
  const unrelated = join(root, ".config.json.not-a-writer-temp.tmp");
  await writeFile(orphan, "synthetic orphaned plaintext\n", { mode: 0o644 });
  await writeFile(unrelated, "must remain\n", { mode: 0o644 });
  const store = new UserConfigStore({ picoHome: root });

  const snapshots = await Promise.all([store.read(), store.read(), store.read()]);
  assert.ok(snapshots.every((snapshot) => snapshot.revision === EMPTY_USER_CONFIG_REVISION));
  await assert.rejects(access(orphan), isMissing);
  assert.equal(await readFile(unrelated, "utf8"), "must remain\n");

  const written = await store.write(config("secure"), {
    expectedRevision: EMPTY_USER_CONFIG_REVISION,
  });
  assert.equal(written.config.providers.secure?.models[0], "secure-model");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
});

test("active lock prevents recovery from deleting a live writer temporary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-config-live-temp-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome: root, lockTimeoutMs: 30, staleLockMs: 0 });
  const temporary = join(root, temporaryName("22222222-2222-4222-8222-222222222222"));
  await writeFile(temporary, "live writer payload\n", { mode: 0o600 });
  await writeFile(
    store.lockPath,
    `${JSON.stringify({
      version: 1,
      token: "live-writer-token",
      pid: process.pid,
      acquiredAt: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(store.read(), UserConfigLockTimeoutError);
  assert.equal(await readFile(temporary, "utf8"), "live writer payload\n");

  await unlink(store.lockPath);
  await store.read();
  await assert.rejects(access(temporary), isMissing);
});

test("temporary recovery rejects symlinks and abnormal targets without following them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-config-temp-type-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const external = join(root, "external-value");
  await writeFile(external, "external remains\n", { mode: 0o600 });
  const linked = join(root, temporaryName("33333333-3333-4333-8333-333333333333"));
  await symlink(external, linked);
  const store = new UserConfigStore({ picoHome: root });

  await assert.rejects(store.read(), /临时文件必须是普通文件/u);
  assert.equal(await readFile(external, "utf8"), "external remains\n");
  assert.equal((await stat(linked)).isFile(), true, "the symlink target remains readable");

  await unlink(linked);
  const abnormal = join(root, temporaryName("44444444-4444-4444-8444-444444444444"));
  await mkdir(abnormal);
  await assert.rejects(store.read(), /临时文件必须是普通文件/u);
  assert.equal((await stat(abnormal)).isDirectory(), true);
});

test("concurrent writers serialize normally and leave no plaintext temporaries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-config-temp-concurrent-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const left = new UserConfigStore({ picoHome: root });
  const right = new UserConfigStore({ picoHome: root });

  const writes = await Promise.allSettled([
    left.write(config("left"), { expectedRevision: EMPTY_USER_CONFIG_REVISION }),
    right.write(config("right"), { expectedRevision: EMPTY_USER_CONFIG_REVISION }),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = writes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof UserConfigRevisionConflictError);

  const snapshot = await left.read();
  assert.equal(Object.keys(snapshot.config.providers).length, 1);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(left.filePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(root)).filter((name) => /^\.config\.json\..+\.tmp$/u.test(name)),
    [],
  );
});

function temporaryName(uuid: string): string {
  return `.config.json.999999.${Date.now()}.${uuid}.tmp`;
}

function config(id: string): PicoUserConfig {
  return {
    version: 1,
    providers: {
      [id]: {
        protocol: "openai",
        baseURL: `https://${id}.invalid/v1`,
        apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
        apiKey: `synthetic-${id}-secret`,
        models: [`${id}-model`],
        discoverModels: false,
      },
    },
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
