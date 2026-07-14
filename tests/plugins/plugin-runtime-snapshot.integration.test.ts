import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "---\nname: review\ndescription: Review code\n---\nReview carefully.\n",
    );
    await writeFile(join(pluginDir, "review.md"), "---\ndescription: Review\n---\nReview $ARGUMENTS\n");
    await writeFile(
      join(pluginDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviewer\ntools: Read, Grep\n---\nReview the code.\n",
    );
    await writeFile(join(pluginDir, "server.js"), "export {};\n");
    await writeFile(join(pluginDir, "typescript-language-server"), "#!/bin/sh\n");

    const service = new PluginManagementService({ workDir, picoHome });
    await service.install(pluginDir, "project");
    expect(
      (await loadPluginRuntimeSnapshot({ workDir, picoHome, service })).pluginIds,
    ).toEqual([]);
    const proposal = await service.prepareTrust({ id: "quality", scope: "project" });
    await service.trust(proposal);
    await service.enable({ id: "quality", scope: "project" });

    const snapshot = await loadPluginRuntimeSnapshot({ workDir, picoHome, service });
    expect(snapshot.pluginIds).toEqual(["quality"]);
    expect(snapshot.diagnostics).toEqual([]);
    expect((await new SkillLoader(workDir, { externalSources: snapshot.skillSources }).list())[0])
      .toMatchObject({ name: "quality:review", body: "Review carefully." });
    expect(
      (
        await loadMarkdownCommands({
          workDir,
          homeDir: picoHome,
          includeSkillCommands: false,
          externalSources: snapshot.commandSources,
        })
      ).map((command) => command.name),
    ).toContain("quality:review");
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
          command: join(await realpath(pluginDir), "server.js"),
          args: [await realpath(workDir)],
        }),
      },
    });
    expect(snapshot.lspServers).toEqual([
      {
        id: "quality:typescript",
        command: join(await realpath(pluginDir), "typescript-language-server"),
        languages: ["typescript"],
      },
    ]);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
