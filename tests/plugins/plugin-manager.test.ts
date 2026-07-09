import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginManager } from "../../src/plugins/plugin-manager.js";

describe("PluginManager", () => {
  let workDir: string;
  let statePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-plugin-"));
    statePath = join(workDir, "plugins.json");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("installFromDirectory 读取 .claude-plugin/plugin.json 并持久化安装记录", async () => {
    const pluginDir = await createPlugin("formatter", "1.2.3");
    const manager = new PluginManager({ statePath });

    const result = await manager.installFromDirectory(pluginDir, "project");

    expect(result).toMatchObject({
      success: true,
      pluginId: "formatter",
      pluginName: "formatter",
      scope: "project",
    });
    expect(await manager.list()).toEqual([
      {
        id: "formatter",
        scope: "project",
        manifest: { name: "formatter", version: "1.2.3" },
        installPath: pluginDir,
        enabled: false,
      },
    ]);

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.plugins.formatter.project).toMatchObject({
      installPath: pluginDir,
      manifest: { name: "formatter", version: "1.2.3" },
    });
  });

  it("enable/disable 按 scope 持久化 enabled 状态并可由新实例加载", async () => {
    const pluginDir = await createPlugin("reviewer", "0.1.0");
    const manager = new PluginManager({ statePath });
    await manager.installFromDirectory(pluginDir, "user");

    expect(await manager.enable("reviewer", "user")).toMatchObject({
      success: true,
      pluginId: "reviewer",
      scope: "user",
    });
    expect((await manager.list())[0]).toMatchObject({ id: "reviewer", enabled: true });

    const reloaded = new PluginManager({ statePath });
    expect((await reloaded.list())[0]).toMatchObject({ id: "reviewer", enabled: true });

    await reloaded.disable("reviewer", "user");
    expect((await reloaded.list())[0]).toMatchObject({ id: "reviewer", enabled: false });
  });

  it("支持 user/project/local 三种 scope 并按插件 id 和 scope 稳定列出", async () => {
    const manager = new PluginManager({ statePath });
    await manager.installFromDirectory(await createPlugin("zeta", "1.0.0"), "local");
    await manager.installFromDirectory(await createPlugin("alpha", "1.0.0"), "user");
    await manager.installFromDirectory(await createPlugin("alpha", "1.1.0"), "project");

    expect((await manager.list()).map((plugin) => `${plugin.id}:${plugin.scope}`)).toEqual([
      "alpha:user",
      "alpha:project",
      "zeta:local",
    ]);
  });

  it("拒绝缺少 name 或 version 的 manifest", async () => {
    const missingName = await createPluginWithManifest({ version: "1.0.0" });
    const missingVersion = await createPluginWithManifest({ name: "nameless-version" });
    const manager = new PluginManager({ statePath });

    await expect(manager.installFromDirectory(missingName, "local")).resolves.toMatchObject({
      success: false,
      message: expect.stringMatching(/name.*version|version.*name|name/i),
      scope: "local",
    });
    await expect(manager.installFromDirectory(missingVersion, "local")).resolves.toMatchObject({
      success: false,
      message: expect.stringMatching(/version/i),
      scope: "local",
    });
  });

  it("enable/disable 未安装插件返回失败结果且不创建状态", async () => {
    const manager = new PluginManager({ statePath });

    await expect(manager.enable("missing", "user")).resolves.toMatchObject({
      success: false,
      pluginId: "missing",
      scope: "user",
    });
    await expect(manager.disable("missing", "user")).resolves.toMatchObject({
      success: false,
      pluginId: "missing",
      scope: "user",
    });
    expect(await manager.list()).toEqual([]);
  });

  async function createPlugin(name: string, version: string): Promise<string> {
    return createPluginWithManifest({ name, version });
  }

  async function createPluginWithManifest(manifest: Record<string, unknown>): Promise<string> {
    const pluginDir = await mkdtemp(join(workDir, "plugin-src-"));
    const manifestDir = join(pluginDir, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
    return pluginDir;
  }
});
