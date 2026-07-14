import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentCatalog } from "../src/agents/catalog.js";
import { SkillLoader } from "../src/context/skill.js";
import { loadMarkdownCommands } from "../src/input/markdown-command-loader.js";
import type { AgentProfile } from "../src/tools/agent-profile.js";
import { DelegateTaskTool, type AgentRunner, type SubagentResult } from "../src/tools/subagent.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";

describe("Pico resource catalog", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uses one NFKC/case-insensitive Skill entry for view and dynamic command projection", async () => {
    const { homeDir, workDir } = await workspace();
    await writeSkill(
      join(homeDir, ".claude", "skills", "review", "SKILL.md"),
      "REVIEW",
      "user claude",
      "user claude body",
    );
    await writeSkill(
      join(homeDir, ".pico", "skills", "review", "SKILL.md"),
      "Review",
      "user pico",
      "user pico body",
    );
    await writeSkill(
      join(workDir, ".claude", "skills", "review", "SKILL.md"),
      "Ｒｅｖｉｅｗ",
      "project claude",
      "project claude body",
      ["Read", "UnknownClaudeTool"],
    );
    await writeSkill(
      join(workDir, ".pico", "skills", "review", "SKILL.md"),
      "review",
      "project pico",
      "project pico body",
      ["read_file"],
    );

    const loader = new SkillLoader(workDir, { homeDir, includeUserResources: true });
    const selected = await loader.view("REVIEW");
    const commands = await loadMarkdownCommands({
      workDir,
      homeDir,
      includeSkillCommands: true,
      skillLoader: loader,
      userCommandsDir: join(homeDir, "isolated-commands"),
    });
    const projected = commands.find((command) => command.name === "review");

    expect(selected).toMatchObject({
      body: "project pico body",
      description: "project pico",
      sourcePath: join(workDir, ".pico", "skills", "review", "SKILL.md"),
      allowedTools: ["read_file"],
    });
    expect(projected).toMatchObject({
      prompt: "project pico body",
      sourcePath: selected?.sourcePath,
      allowedTools: ["read_file"],
    });
  });

  it("maps Claude allowed-tools while preserving unknown names for fail-closed execution", async () => {
    const { homeDir, workDir } = await workspace();
    await writeSkill(
      join(workDir, ".claude", "skills", "review", "SKILL.md"),
      "review",
      "review",
      "review body",
      ["Read", "Bash", "UnknownClaudeTool"],
    );
    const loader = new SkillLoader(workDir, { homeDir });

    const [command] = await loadMarkdownCommands({
      workDir,
      homeDir,
      includeSkillCommands: true,
      skillLoader: loader,
      userCommandsDir: join(homeDir, "isolated-commands"),
    });

    expect(command?.allowedTools).toEqual(["read_file", "bash", "UnknownClaudeTool"]);
  });

  it("orders explicit commands by project Pico, project Claude, user Pico and user Claude", async () => {
    const { homeDir, workDir } = await workspace();
    await writeCommand(join(homeDir, ".claude", "commands", "review.md"), "user claude");
    await writeCommand(join(homeDir, ".pico", "commands", "review.md"), "user pico");
    await writeCommand(join(workDir, ".claude", "commands", "review.md"), "project claude");
    await writeCommand(join(workDir, ".pico", "commands", "review.md"), "project pico");

    const commands = await loadMarkdownCommands({ workDir, homeDir });

    expect(commands.filter((command) => command.name.toLowerCase() === "review")).toEqual([
      expect.objectContaining({
        prompt: "project pico",
        sourcePath: join(workDir, ".pico", "commands", "review.md"),
      }),
    ]);
  });

  it("loads native project and user Agents above Claude compatibility entries", async () => {
    const { homeDir, workDir } = await workspace();
    await writeClaudeAgent(join(homeDir, ".claude", "agents", "reviewer.md"), "user claude");
    await writeNativeAgents(join(homeDir, ".pico", "agents.yaml"), "user pico");
    await writeClaudeAgent(join(workDir, ".claude", "agents", "reviewer.md"), "project claude");
    await writeNativeAgents(join(workDir, ".pico", "agents.yaml"), "project pico");

    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: false });

    expect(profiles).toEqual([
      expect.objectContaining({
        name: "reviewer",
        source: "project-native",
        systemPrompt: "project pico",
        sourcePath: join(workDir, ".pico", "agents.yaml"),
      }),
    ]);
  });

  it("namespaces Pico YAML Agent contributions from Plugins", async () => {
    const { homeDir, workDir } = await workspace();
    const pluginAgents = join(workDir, "plugin", "agents.yaml");
    await writeNativeAgents(pluginAgents, "plugin prompt");

    const profiles = await loadAgentCatalog({
      workDir,
      homeDir,
      includeBuiltins: false,
      externalSources: [
        {
          id: "plugin:quality:agent",
          scope: "external",
          format: "pico-native",
          root: pluginAgents,
          priority: 35,
          namespace: "quality:",
          adapter: "pico-agent-yaml",
        },
      ],
    });

    expect(profiles).toEqual([
      expect.objectContaining({ name: "quality:reviewer", systemPrompt: "plugin prompt" }),
    ]);
  });

  it("discloses persistent Agent names and bounded descriptions in delegate_task schema", async () => {
    const profiles: AgentProfile[] = [
      {
        name: "security-reviewer",
        description: "Review authentication and authorization risks.",
        systemPrompt: "Review security risks.",
        tools: ["read_file", "grep"],
      },
    ];
    const runner: AgentRunner = {
      async runSub(): Promise<SubagentResult> {
        return { summary: "ok", artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), new DelegationManager(), {
      profiles,
    });

    const schema = tool.definition().inputSchema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };

    expect(schema.properties.agent_name?.enum).toEqual(["security-reviewer"]);
    expect(schema.properties.agent_name?.description).toContain(
      "security-reviewer: Review authentication and authorization risks.",
    );
  });

  async function workspace(): Promise<{ workDir: string; homeDir: string }> {
    const workDir = await mkdtemp(join(tmpdir(), "pico-resource-work-"));
    const homeDir = await mkdtemp(join(tmpdir(), "pico-resource-home-"));
    tempDirs.push(workDir, homeDir);
    return { workDir: await realpath(workDir), homeDir };
  }
});

async function writeSkill(
  path: string,
  name: string,
  description: string,
  body: string,
  allowedTools?: string[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      ...(allowedTools ? ["allowed-tools:", ...allowedTools.map((tool) => `  - ${tool}`)] : []),
      "---",
      body,
    ].join("\n"),
  );
}

async function writeCommand(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\ndescription: review\n---\n${body}`);
}

async function writeClaudeAgent(path: string, prompt: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: reviewer\ndescription: review\ntools: Read\n---\n${prompt}`);
}

async function writeNativeAgents(path: string, prompt: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      "agents:",
      "  - name: reviewer",
      "    description: review",
      `    systemPrompt: ${prompt}`,
      "    tools: [read_file]",
    ].join("\n"),
  );
}
