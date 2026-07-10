// loadHooksConfig 单元测试。
//
// 用 mkdtemp 隔离每个用例的工作区,避免相互污染。
// 覆盖:有 settings.json→加载;无→undefined;畸形→undefined。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHooksConfig } from "../../src/hooks/config.js";

describe("loadHooksConfig", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-hooks-cfg-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("无 .claw/settings.json 时返回 undefined(全新工作区)", async () => {
    const config = await loadHooksConfig(workDir);
    expect(config).toBeUndefined();
  });

  it("settings.json 存在且含合法 hooks 时返回配置", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo pre", timeout: 5000 }],
            },
          ],
          PostToolUse: [
            {
              hooks: [{ type: "command", command: "echo post" }],
            },
          ],
        },
      }),
    );

    const config = await loadHooksConfig(workDir);
    expect(config).toBeDefined();
    expect(config!.PreToolUse).toHaveLength(1);
    expect(config!.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(config!.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(config!.PreToolUse?.[0]?.hooks[0]?.command).toBe("echo pre");
    expect(config!.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(5000);
    expect(config!.PostToolUse?.[0]?.matcher).toBeUndefined();
    expect(config!.PostToolUse?.[0]?.hooks[0]?.timeout).toBeUndefined();
  });

  it("settings.json 存在但无 hooks 字段时返回 undefined", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({ someOtherSetting: true }),
    );

    expect(await loadHooksConfig(workDir)).toBeUndefined();
  });

  it("settings.json 为畸形 JSON 时返回 undefined(不抛)", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(join(workDir, ".claw", "settings.json"), "{ not valid json");

    expect(await loadHooksConfig(workDir)).toBeUndefined();
  });

  it("settings.json 顶层非对象时返回 undefined", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(join(workDir, ".claw", "settings.json"), JSON.stringify([1, 2, 3]));

    expect(await loadHooksConfig(workDir)).toBeUndefined();
  });

  it("丢弃非法事件名,只保留 PreToolUse/PostToolUse", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          BogusEvent: [{ hooks: [{ type: "command", command: "echo x" }] }],
          PreToolUse: [{ hooks: [{ type: "command", command: "echo ok" }] }],
        },
      }),
    );

    const config = await loadHooksConfig(workDir);
    expect(config).toBeDefined();
    expect(config!.PreToolUse).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(config, "BogusEvent")).toBe(false);
  });

  it("丢弃非 command 类型或空 command 的 handler", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "webhook", command: "should-be-dropped" },
                { type: "command", command: "   " },
                { type: "command", command: "valid-cmd" },
              ],
            },
          ],
        },
      }),
    );

    const config = await loadHooksConfig(workDir);
    expect(config).toBeDefined();
    const hooks = config!.PreToolUse?.[0]?.hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks?.[0]?.command).toBe("valid-cmd");
  });

  it("所有 handler 都非法时返回 undefined", async () => {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "" }] }],
        },
      }),
    );

    expect(await loadHooksConfig(workDir)).toBeUndefined();
  });
});
