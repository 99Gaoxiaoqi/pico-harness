import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { HookTrustStore } from "../../src/hooks/trust/store.js";

describe("Hook canonical config snapshot", () => {
  let root: string;
  let workDir: string;
  let userHome: string;
  let trustStore: HookTrustStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pico-hook-snapshot-"));
    workDir = join(root, "workspace");
    userHome = join(root, "home");
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await mkdir(join(userHome, ".pico"), { recursive: true });
    trustStore = new HookTrustStore({ userHome });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("按 user/project/local/legacy 顺序合并，canonical 秒与 legacy 毫秒语义分离", async () => {
    await writeFile(
      join(userHome, ".pico", "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: "command", command: "echo user", timeout: 2 }] }],
      }),
    );
    await writeFile(
      join(workDir, ".pico", "hooks.json"),
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "project check" }] }] }),
    );
    await writeFile(
      join(workDir, ".claw", "hooks.local.json"),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1234/hook" }] }],
      }),
    );
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo old", timeout: 5000 }] }],
        },
      }),
    );

    const result = await loadHookSnapshot({ workDir, userHome, trustStore });
    const handlers = result.snapshot.handlers.PreToolUse;
    expect(handlers.map((entry) => entry.source.kind)).toEqual([
      "user",
      "project",
      "local",
      "legacy",
    ]);
    expect(handlers[0]?.handler.timeoutMs).toBe(2_000);
    expect(handlers[3]?.handler.timeoutMs).toBe(5_000);
    expect(handlers.map((entry) => entry.trusted)).toEqual([false, true, false, false]);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.handlers.PreToolUse)).toBe(true);
  });

  it("隔离非法 canonical source，仍加载其他合法 source", async () => {
    await writeFile(join(workDir, ".pico", "hooks.json"), JSON.stringify({ Unknown: [] }));
    await writeFile(
      join(workDir, ".claw", "hooks.local.json"),
      JSON.stringify({ Stop: [{ matcher: "[", hooks: [{ type: "prompt", prompt: "bad" }] }] }),
    );
    await writeFile(
      join(userHome, ".pico", "hooks.json"),
      JSON.stringify({ Stop: [{ hooks: [{ type: "prompt", prompt: "valid" }] }] }),
    );

    const result = await loadHookSnapshot({ workDir, userHome, trustStore });
    expect(result.hasErrors).toBe(true);
    expect(result.snapshot.handlers.Stop).toHaveLength(1);
    expect(result.sources.filter((source) => source.status === "invalid")).toHaveLength(2);
  });

  it("定义和引用脚本字节均纳入信任指纹", async () => {
    const script = join(workDir, "check.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    await chmod(script, 0o700);
    await writeFile(
      join(workDir, ".claw", "hooks.local.json"),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: "command", command: "./check.sh", args: [] }] }],
      }),
    );

    let loaded = await loadHookSnapshot({ workDir, userHome, trustStore });
    const pending = loaded.snapshot.handlers.PreToolUse[0];
    expect(pending?.trusted).toBe(false);
    await trustStore.trustResolved(workDir, pending!);
    loaded = await loadHookSnapshot({ workDir, userHome, trustStore, version: 2 });
    expect(loaded.snapshot.handlers.PreToolUse[0]?.trusted).toBe(true);

    await writeFile(script, "#!/bin/sh\nexit 2\n");
    loaded = await loadHookSnapshot({ workDir, userHome, trustStore, version: 3 });
    expect(loaded.snapshot.handlers.PreToolUse[0]?.trusted).toBe(false);
    expect((await lstat(join(userHome, ".pico"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(userHome, ".pico", "trusted-hooks.json"))).mode & 0o777).toBe(0o600);
  });

  it("拒绝将信任库写入符号链接", async () => {
    const target = join(root, "outside.json");
    await writeFile(target, JSON.stringify({ version: 1, records: [] }));
    await symlink(target, join(userHome, ".pico", "trusted-hooks.json"));
    await expect(trustStore.list()).rejects.toThrow("符号链接");
    expect(await readFile(target, "utf8")).toContain("records");
  });
});
