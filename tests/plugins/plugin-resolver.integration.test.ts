import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPluginVariableMap,
  resolvePluginContributions,
  substitutePluginVariables,
  substitutePluginVariablesDeep,
} from "../../src/plugins/plugin-resolver.js";

describe("plugin contribution resolver", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "pico-plugin-resolver-"));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("原生 manifest 优先并按规则解析六类贡献", async () => {
    const plugin = join(fixtureRoot, "quality-suite");
    await mkdir(join(plugin, ".pico"), { recursive: true });
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
      name: "claude-name-must-not-win",
    });
    await writeJson(join(plugin, ".pico", "plugin.json"), {
      name: "quality-suite",
      displayName: "Quality Suite",
      skills: "./extra-skills",
      commands: "./custom-command.md",
      agents: ["./custom-agents"],
      hooks: { hooks: { PostToolUse: [] } },
      mcpServers: "./config/mcp.json",
      lspServers: { typescript: { command: "typescript-language-server" } },
    });
    await mkdir(join(plugin, "skills", "review"), { recursive: true });
    await writeFile(join(plugin, "skills", "review", "SKILL.md"), "# Review\n");
    await mkdir(join(plugin, "extra-skills", "audit"), { recursive: true });
    await writeFile(join(plugin, "extra-skills", "audit", "SKILL.md"), "# Audit\n");
    await mkdir(join(plugin, "commands"), { recursive: true });
    await writeFile(join(plugin, "commands", "ignored.md"), "ignored\n");
    await writeFile(join(plugin, "custom-command.md"), "custom\n");
    await mkdir(join(plugin, "custom-agents"), { recursive: true });
    await writeFile(join(plugin, "custom-agents", "reviewer.md"), "reviewer\n");
    await mkdir(join(plugin, "hooks"), { recursive: true });
    await writeJson(join(plugin, "hooks", "hooks.json"), { hooks: {} });
    await writeJson(join(plugin, ".mcp.json"), { mcpServers: {} });
    await mkdir(join(plugin, "config"), { recursive: true });
    await writeJson(join(plugin, "config", "mcp.json"), { mcpServers: {} });
    await writeJson(join(plugin, ".lsp.json"), {});

    const result = await resolvePluginContributions(plugin);

    expect(result.compatibility).toBe("compatible");
    expect(result.plugin).toMatchObject({
      id: "quality-suite",
      displayName: "Quality Suite",
      manifestSource: "pico-native",
      root: await realpath(plugin),
    });
    expect(result.skills.map((item) => [item.origin, item.path])).toEqual([
      ["default", await realpath(join(plugin, "skills"))],
      ["manifest", await realpath(join(plugin, "extra-skills"))],
    ]);
    expect(result.commands.map((item) => item.path)).toEqual([
      await realpath(join(plugin, "custom-command.md")),
    ]);
    expect(result.agents[0]).toMatchObject({
      namespace: "quality-suite:",
      path: await realpath(join(plugin, "custom-agents")),
    });
    expect(result.hooks).toHaveLength(2);
    expect(result.mcpServers).toHaveLength(2);
    expect(result.lspServers).toHaveLength(2);
    expect(result.fingerprint).toMatchObject({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("无 skills 目录与显式声明时识别根 SKILL.md", async () => {
    const plugin = join(fixtureRoot, "single-skill");
    await mkdir(plugin);
    await writeFile(join(plugin, "SKILL.md"), "# Single\n");

    const result = await resolvePluginContributions(plugin);

    expect(result.compatibility).toBe("compatible");
    expect(result.plugin).toMatchObject({
      id: "single-skill",
      manifestSource: "manifestless",
    });
    expect(result.skills).toEqual([
      expect.objectContaining({
        namespace: "single-skill:",
        origin: "root-skill",
        path: await realpath(join(plugin, "SKILL.md")),
      }),
    ]);
  });

  it("显式资源缺失时 degraded，路径穿越时 blocked 且零贡献", async () => {
    const degradedPlugin = await pluginWithManifest("degraded", {
      name: "degraded",
      commands: "./missing-command.md",
    });
    const degraded = await resolvePluginContributions(degradedPlugin);
    expect(degraded.compatibility).toBe("degraded");
    expect(degraded.diagnostics).toContainEqual(
      expect.objectContaining({ code: "component_path_missing", compatibility: "degraded" }),
    );

    const blockedPlugin = await pluginWithManifest("blocked", {
      name: "blocked",
      agents: "../outside",
    });
    const blocked = await resolvePluginContributions(blockedPlugin);
    expect(blocked.compatibility).toBe("blocked");
    expect(blocked.agents).toEqual([]);
    expect(blocked.diagnostics).toContainEqual(
      expect.objectContaining({ code: "component_path_not_relative", compatibility: "blocked" }),
    );
  });

  it("拒绝指向 plugin 根目录外的符号链接", async () => {
    const outside = join(fixtureRoot, "outside-skills");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "outside\n");
    const plugin = await pluginWithManifest("symlink-plugin", {
      name: "symlink-plugin",
      skills: "./linked-skills",
    });
    await symlink(outside, join(plugin, "linked-skills"), "dir");

    const result = await resolvePluginContributions(plugin);

    expect(result.compatibility).toBe("blocked");
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "component_path_outside_root", compatibility: "blocked" }),
      ]),
    );
  });

  it("全资源指纹覆盖支持文件变更", async () => {
    const plugin = await pluginWithManifest("fingerprinted", { name: "fingerprinted" });
    await mkdir(join(plugin, "skills", "review", "references"), { recursive: true });
    const reference = join(plugin, "skills", "review", "references", "guide.md");
    await writeFile(join(plugin, "skills", "review", "SKILL.md"), "review\n");
    await writeFile(reference, "version one\n");

    const first = await resolvePluginContributions(plugin);
    await writeFile(reference, "version two\n");
    const second = await resolvePluginContributions(plugin);

    expect(first.fingerprint?.fileCount).toBe(3);
    expect(second.fingerprint?.digest).not.toBe(first.fingerprint?.digest);
  });

  it("路径变量映射到 PicoPaths 且不替换未授权环境变量", async () => {
    const project = join(fixtureRoot, "project");
    const plugin = join(fixtureRoot, "plugin-root");
    const picoHome = join(fixtureRoot, "pico-home");
    await mkdir(project);
    await mkdir(plugin);
    const variables = createPluginVariableMap(
      { id: "vendor/plugin", root: await realpath(plugin) },
      project,
      { picoHome },
    );

    expect(variables.CLAUDE_PLUGIN_ROOT).toBe(await realpath(plugin));
    expect(variables.CLAUDE_PLUGIN_DATA).toBe(join(picoHome, "plugin-data", "vendor-plugin"));
    expect(
      substitutePluginVariables("${CLAUDE_PLUGIN_ROOT}/bin:${PICO_PLUGIN_DATA}:${HOME}", variables),
    ).toBe(`${await realpath(plugin)}/bin:${variables.PICO_PLUGIN_DATA}:\${HOME}`);
    expect(
      substitutePluginVariablesDeep(
        { command: "${CLAUDE_PLUGIN_ROOT}/server", env: ["${PICO_PROJECT_DIR}"] },
        variables,
      ),
    ).toEqual({ command: `${await realpath(plugin)}/server`, env: [await realpath(project)] });
  });

  it("legacy root manifest 可加载但标记 degraded", async () => {
    const plugin = join(fixtureRoot, "legacy");
    await mkdir(plugin);
    await writeJson(join(plugin, "plugin.json"), { name: "legacy" });

    const result = await resolvePluginContributions(plugin);

    expect(result.compatibility).toBe("degraded");
    expect(result.plugin.manifestSource).toBe("legacy-root");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "legacy_root_manifest", compatibility: "degraded" }),
    );
  });

  async function pluginWithManifest(
    directoryName: string,
    manifest: Record<string, unknown>,
  ): Promise<string> {
    const plugin = join(fixtureRoot, directoryName);
    await mkdir(join(plugin, ".pico"), { recursive: true });
    await writeJson(join(plugin, ".pico", "plugin.json"), manifest);
    return plugin;
  }
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
