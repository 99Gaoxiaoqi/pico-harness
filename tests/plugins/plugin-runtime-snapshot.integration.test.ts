import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentCatalog } from "../../src/agents/catalog.js";
import { SkillLoader } from "../../src/context/skill.js";
import { loadMarkdownCommands } from "../../src/input/markdown-command-loader.js";
import { PluginManagementService } from "../../src/plugins/plugin-management-service.js";
import { loadPluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";

describe("Plugin runtime snapshot", () => {
  it("只投影已显式信任和启用的贡献，并使用插件命名空间", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-home-"));
    const pluginDir = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-source-"));
    await mkdir(join(pluginDir, ".claude-plugin"));
    await writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), {
      name: "quality",
      skills: "./SKILL.md",
      commands: "./review.md",
      agents: "./reviewer.md",
      hooks: {
        hooks: {
          PostToolUse: [
            { matcher: "read_file", hooks: [{ type: "command", command: "echo checked" }] },
          ],
        },
      },
      mcpServers: {
        browser: {
          command: "${CLAUDE_PLUGIN_ROOT}/server.js",
          args: ["${PICO_PROJECT_DIR}"],
        },
      },
      lspServers: {
        typescript: {
          command: "${PICO_PLUGIN_ROOT}/typescript-language-server",
          languages: ["typescript"],
        },
      },
    });
    await writeFile(
      join(pluginDir, "SKILL.md"),
      "---\nname: skill-review\ndescription: Review code\nallowed-tools: Read, Bash\n---\nReview carefully.\n",
    );
    await writeFile(
      join(pluginDir, "review.md"),
      "---\ndescription: Review\nallowed-tools: Read, Bash\n---\nReview $ARGUMENTS\n",
    );
    await writeFile(
      join(pluginDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviewer\ntools: Read, Grep\n---\nReview the code.\n",
    );
    await writeFile(join(pluginDir, "server.js"), "export {};\n");
    await writeFile(join(pluginDir, "typescript-language-server"), "#!/bin/sh\n");

    const service = new PluginManagementService({ workDir, picoHome });
    await service.install(pluginDir, "project");
    const disabledSnapshot = await loadPluginRuntimeSnapshot({ workDir, picoHome, service });
    expect(disabledSnapshot.pluginIds).toEqual([]);
    await disabledSnapshot.dispose();
    const proposal = await service.prepareTrust({ id: "quality", scope: "project" });
    await service.trust(proposal);
    await service.enable({ id: "quality", scope: "project" });

    const snapshot = await loadPluginRuntimeSnapshot({ workDir, picoHome, service });
    const runtimeRoot = dirname(snapshot.skillSources[0]!.root);
    expect(snapshot.pluginIds).toEqual(["quality"]);
    expect(snapshot.diagnostics).toEqual([]);
    expect(runtimeRoot).not.toBe(await realpath(pluginDir));
    expect(snapshot.skillSources[0]!.root.startsWith(runtimeRoot)).toBe(true);
    expect(snapshot.commandSources[0]!.root.startsWith(runtimeRoot)).toBe(true);
    expect(snapshot.agentSources[0]!.root.startsWith(runtimeRoot)).toBe(true);

    await writeFile(join(pluginDir, "SKILL.md"), "changed after snapshot\n");
    await writeFile(join(pluginDir, "review.md"), "changed after snapshot\n");
    await writeFile(join(pluginDir, "reviewer.md"), "changed after snapshot\n");
    expect(
      (await new SkillLoader(workDir, { externalSources: snapshot.skillSources }).list())[0],
    ).toMatchObject({
      name: "quality:skill-review",
      body: "Review carefully.",
      allowedTools: ["read_file", "bash"],
    });
    const commands = await loadMarkdownCommands({
      workDir,
      homeDir: picoHome,
      includeSkillCommands: true,
      skillLoader: new SkillLoader(workDir, { externalSources: snapshot.skillSources }),
      externalSources: snapshot.commandSources,
    });
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "quality:review",
          allowedTools: ["read_file", "bash"],
        }),
        expect.objectContaining({
          name: "quality:skill-review",
          source: "skill",
          allowedTools: ["read_file", "bash"],
        }),
      ]),
    );
    expect(
      (
        await loadAgentCatalog({
          workDir,
          homeDir: picoHome,
          includeBuiltins: false,
          externalSources: snapshot.agentSources,
        })
      )[0],
    ).toMatchObject({ name: "quality:reviewer", tools: ["read_file", "grep"] });
    expect(snapshot.hookSources[0]).toMatchObject({
      kind: "plugin",
      componentId: "quality",
      inlineHooks: { PostToolUse: expect.any(Array) },
    });
    expect(snapshot.mcpSources[0]?.config).toEqual({
      mcpServers: {
        "quality:browser": expect.objectContaining({
          command: join(runtimeRoot, "server.js"),
          args: [await realpath(workDir)],
        }),
      },
    });
    expect(snapshot.lspServers).toEqual([
      {
        id: "quality:typescript",
        command: join(runtimeRoot, "typescript-language-server"),
        languages: ["typescript"],
      },
    ]);
    await snapshot.dispose();
    await snapshot.dispose();
    await expect(access(runtimeRoot)).rejects.toThrow();
  });

  it("同 ID 只激活 local > project > user 的最高优先级 winner", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-home-"));
    const service = new PluginManagementService({ workDir, picoHome });

    for (const scope of ["user", "project", "local"] as const) {
      const pluginDir = await createScopedPlugin(scope);
      await service.install(pluginDir, scope);
      await service.trust(await service.prepareTrust({ id: "winner", scope }));
      await service.enable({ id: "winner", scope });
    }

    const snapshot = await loadPluginRuntimeSnapshot({ workDir, picoHome, service });
    expect(snapshot.pluginIds).toEqual(["winner"]);
    expect(snapshot.skillSources).toHaveLength(1);
    expect(
      (await new SkillLoader(workDir, { externalSources: snapshot.skillSources }).list())[0],
    ).toMatchObject({ body: "local winner" });
    expect(snapshot.mcpSources).toHaveLength(1);
    expect(snapshot.mcpSources[0]!.config).toEqual({
      mcpServers: { "winner:server": { command: "local-server" } },
    });
    await snapshot.dispose();
  });

  it("复制前内容变化时 fail closed，不把源目录或外部符号链接投影到运行时", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-home-"));
    const pluginDir = await mkdtemp(join(tmpdir(), "pico-plugin-runtime-source-"));
    await mkdir(join(pluginDir, ".pico"));
    await writeJson(join(pluginDir, ".pico", "plugin.json"), { name: "raced" });
    await writeJson(join(pluginDir, ".mcp.json"), {
      mcpServers: { safe: { command: "safe" } },
    });
    const service = new PluginManagementService({ workDir, picoHome });
    await service.install(pluginDir, "project");
    await service.trust(await service.prepareTrust({ id: "raced", scope: "project" }));
    await service.enable({ id: "raced", scope: "project" });

    const outside = join(await mkdtemp(join(tmpdir(), "pico-plugin-runtime-outside-")), "mcp.json");
    await writeJson(outside, { mcpServers: { unsafe: { command: "unsafe" } } });
    await rm(join(pluginDir, ".mcp.json"));
    await symlink(outside, join(pluginDir, ".mcp.json"));

    const snapshot = await loadPluginRuntimeSnapshot({ workDir, picoHome, service });
    expect(snapshot.pluginIds).toEqual([]);
    expect(snapshot.mcpSources).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "raced",
        sourcePath: await realpath(pluginDir),
        message: expect.stringContaining("changed while creating runtime snapshot"),
      }),
    );
    await snapshot.dispose();
  });
});

async function createScopedPlugin(scope: "user" | "project" | "local"): Promise<string> {
  const pluginDir = await mkdtemp(join(tmpdir(), `pico-plugin-runtime-${scope}-`));
  await mkdir(join(pluginDir, ".pico"));
  await writeJson(join(pluginDir, ".pico", "plugin.json"), {
    name: "winner",
    skills: "./SKILL.md",
    mcpServers: { server: { command: `${scope}-server` } },
  });
  await writeFile(
    join(pluginDir, "SKILL.md"),
    `---\nname: winner\ndescription: ${scope} winner\n---\n${scope} winner\n`,
  );
  return pluginDir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
