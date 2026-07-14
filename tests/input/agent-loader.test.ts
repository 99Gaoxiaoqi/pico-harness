import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadClaudeAgents,
  parseClaudeAgent,
  summarizeClaudeAgents,
} from "../../src/input/agent-loader.js";

describe("Claude agent loader", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-agent-project-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("parses Claude agent markdown frontmatter and prompt body", () => {
    const agent = parseClaudeAgent(
      "---\nname: reviewer\ndescription: Review code\nmodel: volcengine/deepseek-v4-pro\ntools: Read, Grep\n---\n\nYou review code.",
      "fallback",
      "/tmp/reviewer.md",
    );

    expect(agent).toEqual({
      description: "Review code",
      model: "volcengine/deepseek-v4-pro",
      name: "reviewer",
      prompt: "You review code.",
      source: "project",
      sourcePath: "/tmp/reviewer.md",
      tools: ["Read", "Grep"],
    });
  });

  it("loads .claude/agents/*.md from the project", async () => {
    await mkdir(join(workDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: Review code\n---\n\nYou review code.",
    );

    const agents = await loadClaudeAgents({ workDir });

    expect(agents).toEqual([
      {
        description: "Review code",
        name: "reviewer",
        prompt: "You review code.",
        source: "project",
        sourcePath: join(workDir, ".claude", "agents", "reviewer.md"),
      },
    ]);
  });

  it("loads built-in agents below project priority", async () => {
    await mkdir(join(workDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "agents", "Explore.md"),
      "---\ndescription: Project explorer\ntools: Read\n---\n\nProject prompt",
    );

    const agents = await loadClaudeAgents({ workDir, includeBuiltins: true });

    expect(agents.some((agent) => agent.source === "builtin")).toBe(true);
    expect(agents.find((agent) => agent.name === "Explore")).toMatchObject({
      description: "Project explorer",
      prompt: "Project prompt",
      source: "project",
      tools: ["Read"],
    });
    expect(agents.map((agent) => agent.name)).toContain("Plan");
    expect(agents.map((agent) => agent.name)).toContain("general-purpose");
  });

  it("loads user Claude agents below project priority", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "pico-agent-home-"));
    await mkdir(join(workDir, ".claude", "agents"), { recursive: true });
    await mkdir(join(fakeHome, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: Project reviewer\n---\n\nProject prompt",
    );
    await writeFile(
      join(fakeHome, ".claude", "agents", "reviewer.md"),
      "---\ndescription: User reviewer\n---\n\nUser prompt",
    );
    await writeFile(
      join(fakeHome, ".claude", "agents", "writer.md"),
      "---\ndescription: User writer\n---\n\nWriter prompt",
    );

    const agents = await loadClaudeAgents({ homeDir: fakeHome, workDir });

    expect(
      agents
        .filter((agent) => agent.source !== "builtin")
        .map((agent) => [agent.name, agent.description, agent.prompt]),
    ).toEqual([
      ["reviewer", "Project reviewer", "Project prompt"],
      ["writer", "User writer", "Writer prompt"],
    ]);
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("summarizes agents with tools and source", () => {
    const agent = parseClaudeAgent(
      "---\nname: reviewer\ndescription: Review code\nmodel: inherit\ntools: Read, Grep\n---\n\nPrompt",
      "fallback",
      "/tmp/reviewer.md",
    );

    expect(summarizeClaudeAgents([agent], { includeSource: true })).toEqual([
      {
        description: "Review code",
        model: "inherit",
        name: "reviewer",
        source: "project",
        sourcePath: "/tmp/reviewer.md",
        tools: ["Read", "Grep"],
      },
    ]);
  });

  it("does not let invalid frontmatter block other agents", async () => {
    await mkdir(join(workDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "agents", "broken.md"),
      "---\nname: [broken\ndescription: Broken\n---\n\nBroken prompt",
    );
    await writeFile(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: Review code\n---\n\nReview prompt",
    );

    const agents = await loadClaudeAgents({ workDir });

    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "",
          name: "broken",
          prompt: "Broken prompt",
          source: "project",
        }),
        expect.objectContaining({
          description: "Review code",
          name: "reviewer",
          prompt: "Review prompt",
          source: "project",
        }),
      ]),
    );
  });
});
