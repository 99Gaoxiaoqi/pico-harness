import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonEndpoint } from "../../apps/desktop/src/main/runtime-client-adapter.js";
import {
  prepareLocalDaemonEndpoint,
  resolveLocalDaemonEndpoint,
} from "../../src/daemon/endpoint.js";

describe("local Runtime daemon endpoint namespace", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("shares one helper across Desktop and daemon while isolating canonical PICO_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-endpoint-"));
    cleanups.push(root);
    const runtimeDir = join(root, "runtime");
    const firstHome = join(root, "first-home");
    const firstHomeAlias = join(root, "first-home-alias");
    const secondHome = join(root, "second-home");
    await Promise.all([mkdir(firstHome), mkdir(secondHome)]);
    await symlink(firstHome, firstHomeAlias, "dir");

    const options = {
      runtimeDir,
      userIdentity: "same-user",
      picoHome: firstHome,
    } as const;
    const first = resolveLocalDaemonEndpoint(options);
    const alias = resolveLocalDaemonEndpoint({ ...options, picoHome: firstHomeAlias });
    const second = resolveLocalDaemonEndpoint({ ...options, picoHome: secondHome });

    expect(resolveDaemonEndpoint(options)).toEqual(first);
    expect(alias).toEqual(first);
    expect(second.address).not.toBe(first.address);
    expect(second.authTokenPath).not.toBe(first.authTokenPath);
  });

  it("keeps an injected shared runtime root untouched and secures only its Pico child", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-shared-root-"));
    cleanups.push(root);
    await chmod(root, 0o755);
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: root,
      userIdentity: "shared-root-user",
      picoHome: join(root, "home"),
    });

    await prepareLocalDaemonEndpoint(endpoint);

    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(dirname(endpoint.address))).mode & 0o777).toBe(0o700);
    expect(dirname(endpoint.address)).not.toBe(root);
  });

  it("rejects a pre-existing symlink in place of the Pico-private runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-daemon-symlink-root-"));
    cleanups.push(root);
    const target = join(root, "attacker-controlled");
    await mkdir(target);
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: root,
      userIdentity: "symlink-user",
      picoHome: join(root, "home"),
    });
    await symlink(target, dirname(endpoint.address), "dir");

    await expect(prepareLocalDaemonEndpoint(endpoint)).rejects.toThrow(/Runtime 目录/u);
  });
});
