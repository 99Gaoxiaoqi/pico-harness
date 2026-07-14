import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentCatalog } from "../src/agents/catalog.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { DelegateTaskTool, type AgentRunner, type SubagentResult } from "../src/tools/subagent.js";

describe("统一 Agent 目录集成", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("Claude-only Profile 的 prompt 和映射后工具直接用于 delegate_task", async () => {
    const { homeDir, workDir } = await createWorkspace();
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "reviewer.md"),
      [
        "---",
        "description: 仅读审查",
        "tools: Read, Grep, UnknownPowerTool",
        "---",
        "只报告安全问题。",
      ].join("\n"),
    );
    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: false });
    const seen: { systemPrompt?: string; tools?: string[] } = {};
    const manager = new DelegationManager();
    const runner: AgentRunner = {
      async runSub(_task, registry, _reporter, options): Promise<SubagentResult> {
        seen.systemPrompt = options?.systemPrompt;
        seen.tools = registry
          .getAvailableTools()
          .map((tool) => tool.name)
          .sort();
        return { summary: "ok", artifacts: [] };
      },
    };
    const factory = createSubagentRegistryFactory({ workDir, runner, manager, profiles });
    const tool = new DelegateTaskTool(runner, factory, manager, { profiles });

    const result = JSON.parse(
      await tool.execute(JSON.stringify({ goal: "检查代码", agent_name: "reviewer" })),
    ) as { status: string };

    expect(result.status).toBe("completed");
    expect(seen.systemPrompt).toBe("只报告安全问题。");
    expect(seen.tools).toEqual(["delegate_status", "grep", "read_file"]);
  });

  it("按 native > project Claude > user Claude > builtin 整条覆盖，不拼接字段", async () => {
    const { homeDir, workDir } = await createWorkspace();
    await writeClaudeAgent(
      join(homeDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: user\nmodel: user/model\ntools: Read\n---\nuser prompt",
    );
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: project\nmodel: project/model\ntools: Write\n---\nproject prompt",
    );
    await writeClaudeAgent(
      join(homeDir, ".claude", "agents", "writer.md"),
      "---\ndescription: user writer\ntools: Read\n---\nuser writer prompt",
    );
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "writer.md"),
      "---\ndescription: project writer\ntools: Edit\n---\nproject writer prompt",
    );
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "agents.yaml"),
      [
        "agents:",
        "  - name: reviewer",
        "    description: native",
        "    systemPrompt: native prompt",
        "    tools: [grep]",
      ].join("\n"),
    );

    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: true });
    const reviewer = profiles.find((profile) => profile.name === "reviewer");
    const writer = profiles.find((profile) => profile.name === "writer");

    expect(reviewer).toMatchObject({
      description: "native",
      source: "project-native",
      systemPrompt: "native prompt",
      tools: ["grep"],
    });
    expect(reviewer?.modelRouteId).toBeUndefined();
    expect(writer).toMatchObject({
      description: "project writer",
      source: "project-claude",
      systemPrompt: "project writer prompt",
      tools: ["edit_file"],
    });
  });

  it("仅声明未知 Claude 工具时保留空权限 Profile，不回落默认工具", async () => {
    const { homeDir, workDir } = await createWorkspace();
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "locked.md"),
      "---\ndescription: locked\ntools: UnknownPowerTool\n---\nlocked prompt",
    );
    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: false });
    const manager = new DelegationManager();
    const runner: AgentRunner = {
      async runSub(): Promise<SubagentResult> {
        return { summary: "ok", artifacts: [] };
      },
    };
    const registry = createSubagentRegistryFactory({ workDir, runner, manager, profiles })({
      mode: "worker",
      role: "leaf",
      depth: 1,
      maxSpawnDepth: 2,
      agentName: "locked",
    });

    expect(profiles.find((profile) => profile.name === "locked")?.tools).toEqual([]);
    expect(registry.getAvailableTools().map((tool) => tool.name)).toEqual(["delegate_status"]);
  });

  it("同名覆盖按大小写不敏感键解析，高优先级保留自己的展示名", async () => {
    const { homeDir, workDir } = await createWorkspace();
    await writeClaudeAgent(
      join(homeDir, ".claude", "agents", "reviewer.md"),
      "---\nname: Reviewer\ndescription: user\ntools: Read\n---\nuser prompt",
    );
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\nname: REVIEWER\ndescription: project\ntools: Grep\n---\nproject prompt",
    );
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "agents.yaml"),
      [
        "agents:",
        "  - name: reviewer",
        "    description: native",
        "    systemPrompt: native prompt",
        "    tools: [read_file]",
      ].join("\n"),
    );

    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: false });

    expect(profiles.filter((profile) => profile.name.toLowerCase() === "reviewer")).toEqual([
      expect.objectContaining({
        name: "reviewer",
        source: "project-native",
        systemPrompt: "native prompt",
        tools: ["read_file"],
      }),
    ]);
  });

  it("native 空或全部无效权限作为 tombstone，不让同名 Claude/builtin 回落", async () => {
    const { homeDir, workDir } = await createWorkspace();
    await writeClaudeAgent(
      join(workDir, ".claude", "agents", "locked.md"),
      "---\ndescription: lower locked\ntools: Read\n---\nlower prompt",
    );
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "agents.yaml"),
      [
        "agents:",
        "  - name: LOCKED",
        "    systemPrompt: native locked",
        "    tools: []",
        "  - name: plan",
        "    systemPrompt: native plan",
        "    tools: [UnknownPowerTool]",
      ].join("\n"),
    );

    const profiles = await loadAgentCatalog({ workDir, homeDir, includeBuiltins: true });

    expect(profiles.some((profile) => profile.name.toLowerCase() === "locked")).toBe(false);
    expect(profiles.some((profile) => profile.name.toLowerCase() === "plan")).toBe(false);
  });

  async function createWorkspace(): Promise<{ homeDir: string; workDir: string }> {
    const workDir = await mkdtemp(join(tmpdir(), "pico-agent-catalog-work-"));
    const homeDir = await mkdtemp(join(tmpdir(), "pico-agent-catalog-home-"));
    tempDirs.push(workDir, homeDir);
    return { homeDir, workDir };
  }
});

async function writeClaudeAgent(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
