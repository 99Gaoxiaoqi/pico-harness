import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonEndpoint } from "../../apps/desktop/src/main/runtime-client-adapter.js";
import { resolveLocalDaemonEndpoint } from "../../src/daemon/endpoint.js";

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
});
