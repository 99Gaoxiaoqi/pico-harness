import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "../../src/context/skill.js";
import {
  loadMarkdownCommands,
  parseMarkdownCommand,
  renderMarkdownCommandPrompt,
} from "../../src/input/markdown-command-loader.js";

describe("markdown command loader", () => {
  let workDir: string;
  let userCommandsDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-command-project-"));
    userCommandsDir = await mkdtemp(join(tmpdir(), "pico-command-user-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(userCommandsDir, { recursive: true, force: true });
  });

  it("parses supported frontmatter and keeps markdown body as prompt", () => {
    const command = parseMarkdownCommand(
      `---\ndescription: Review staged changes\nargument-hint: "[path]"\nallowed-tools:\n  - Bash\n  - Read\nmodel: gpt-5\n---\n\nReview $ARGUMENTS`,
      "review",
      "project",
    );

    expect(command).toMatchObject({
      allowedTools: ["Bash", "Read"],
      argumentHint: "[path]",
      description: "Review staged changes",
      model: "gpt-5",
      name: "review",
      prompt: "Review $ARGUMENTS",
      source: "project",
    });
  });

  it("preserves an explicit empty tool list and rejects empty scalar values downstream", () => {
    expect(
      parseMarkdownCommand("---\nallowed-tools: []\n---\n\nNo tools", "none", "project")
        .allowedTools,
    ).toEqual([]);
    expect(
      parseMarkdownCommand("---\nallowed-tools:\n---\n\nInvalid", "invalid", "project")
        .allowedTools,
    ).toEqual([""]);
  });

  it("loads project and user .pico/commands/*.md files with project priority", async () => {
    await writeCommand(workDir, "review", "project review", "Project prompt");
    await writeCommand(workDir, "ship", "ship it", "Ship prompt");
    await writeCommand(userCommandsDir, "review", "user review", "User prompt");
    await writeCommand(userCommandsDir, "explain", "explain code", "Explain prompt");

    const commands = await loadMarkdownCommands({ userCommandsDir, workDir });

    expect(commands.map((command) => [command.name, command.source, command.prompt])).toEqual([
      ["explain", "user", "Explain prompt"],
      ["review", "project", "Project prompt"],
      ["ship", "project", "Ship prompt"],
    ]);
  });

  it("loads commands from an explicit project command directory", async () => {
    const projectCommandsDir = join(workDir, "automation", "commands");
    await mkdir(projectCommandsDir, { recursive: true });
    await writeFile(
      join(projectCommandsDir, "release.md"),
      "---\ndescription: release project\n---\n\nRelease prompt",
    );

    const commands = await loadMarkdownCommands({
      projectCommandsDir,
      userCommandsDir,
      workDir,
    });

    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "release",
        prompt: "Release prompt",
        source: "project",
      }),
    );
  });

  it("loads ~/.pico/commands by default when userCommandsDir is omitted", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "pico-command-home-"));
    await mkdir(join(fakeHome, ".pico", "commands"), { recursive: true });
    await writeFile(
      join(fakeHome, ".pico", "commands", "notes.md"),
      "---\ndescription: take notes\n---\n\nTake notes",
    );

    const commands = await loadMarkdownCommands({ homeDir: fakeHome, workDir });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      description: "take notes",
      name: "notes",
      prompt: "Take notes",
      source: "user",
    });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("loads Claude project and user commands recursively with colon names", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "pico-claude-home-"));
    await mkdir(join(workDir, ".claude", "commands", "git"), { recursive: true });
    await mkdir(join(fakeHome, ".claude", "commands", "ops"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "commands", "git", "review.md"),
      "---\ndescription: review git changes\n---\n\nProject git review",
    );
    await writeFile(
      join(fakeHome, ".claude", "commands", "ops", "deploy.md"),
      "---\ndescription: deploy service\n---\n\nUser deploy",
    );

    const commands = await loadMarkdownCommands({ homeDir: fakeHome, workDir });

    expect(commands.map((command) => [command.name, command.source, command.prompt])).toEqual([
      ["git:review", "project", "Project git review"],
      ["ops:deploy", "user", "User deploy"],
    ]);
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("only registers explicit command markdown and skips resource-like directories", async () => {
    await mkdir(join(workDir, ".claude", "commands", "resources"), { recursive: true });
    await mkdir(join(workDir, ".claude", "commands", "references"), { recursive: true });
    await mkdir(join(workDir, ".claude", "commands", "workflows"), { recursive: true });
    await mkdir(join(workDir, ".claude", "commands", "templates"), { recursive: true });
    await mkdir(join(workDir, ".claude", "commands", "agents"), { recursive: true });
    await mkdir(join(workDir, ".claude", "commands", "node_modules", "pkg"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".claude", "commands", "deploy.md"),
      "---\ndescription: deploy service\n---\n\nDeploy",
    );
    await writeFile(
      join(workDir, ".claude", "commands", "resources", "README.md"),
      "# Shared resources",
    );
    await writeFile(
      join(workDir, ".claude", "commands", "references", "api.md"),
      "# API reference",
    );
    await writeFile(
      join(workDir, ".claude", "commands", "workflows", "release.md"),
      "# Release workflow",
    );
    await writeFile(join(workDir, ".claude", "commands", "templates", "pr.md"), "# PR template");
    await writeFile(
      join(workDir, ".claude", "commands", "agents", "reviewer.md"),
      "# Agent prompt",
    );
    await writeFile(
      join(workDir, ".claude", "commands", "node_modules", "pkg", "index.md"),
      "# Package docs",
    );

    const commands = await loadMarkdownCommands({ userCommandsDir, workDir });

    expect(commands.map((command) => command.name)).toEqual(["deploy"]);
  });

  it("keeps skills as a legal command namespace under command roots", async () => {
    await mkdir(join(workDir, ".claude", "commands", "skills"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "commands", "skills", "review.md"),
      "---\ndescription: review with a skill\n---\n\nUse review skill",
    );

    const commands = await loadMarkdownCommands({ userCommandsDir, workDir });

    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "skills:review",
        description: "review with a skill",
        prompt: "Use review skill",
        source: "project",
      }),
    );
  });

  it("does not apply command directory blacklist to skill projection scanning", async () => {
    await writeClaudeSkill(
      "workflows/release",
      "---\nname: release-flow\ndescription: release workflow\n---\n\n# Release",
    );
    await writeClaudeSkill(
      "agents/reviewer",
      "---\nname: agent-review\ndescription: agent workflow\n---\n\n# Agent",
    );
    await writeClaudeSkill(
      "templates/pr",
      "---\nname: pr-template\ndescription: PR template\n---\n\n# PR",
    );

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });

    expect(commands.map((command) => command.name)).toEqual([
      "agent-review",
      "pr-template",
      "release-flow",
    ]);
  });

  it("optionally projects .claw/skills/**/SKILL.md as prompt commands below user commands", async () => {
    await writeSkill("review", "skill review", "# Skill Review");
    await writeSkill("deploy", "deploy service", "# Deploy");
    await writeCommand(userCommandsDir, "review", "user review", "User prompt");

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      skillLoader: new SkillLoader(workDir),
      userCommandsDir,
      workDir,
    });

    expect(commands.map((command) => [command.name, command.source, command.prompt])).toEqual([
      ["deploy", "skill", "# Deploy"],
      ["review", "user", "User prompt"],
    ]);
    expect(commands.find((command) => command.name === "deploy")).toMatchObject({
      description: "deploy service",
      sourcePath: join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
    });
  });

  it("projects .claude/skills/**/SKILL.md with prompt command metadata", async () => {
    await writeClaudeSkill(
      "review",
      `---\nname: review\ndescription: review code\nargument-hint: "[path]"\nallowed-tools:\n  - Read\n  - Bash\n---\n\n# Review\nUse $ARGUMENTS`,
    );

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      allowedTools: ["Read", "Bash"],
      argumentHint: "[path]",
      description: "review code",
      name: "review",
      prompt: "# Review\nUse $ARGUMENTS",
      source: "skill",
      sourcePath: join(workDir, ".claude", "skills", "review", "SKILL.md"),
    });
  });

  it("preserves projected Skill hooks for run-scoped activation", async () => {
    await writeClaudeSkill(
      "guard",
      `---\nname: guard\ndescription: guard tools\nhooks:\n  PreToolUse:\n    - matcher: bash\n      hooks:\n        - type: prompt\n          prompt: Check command\n---\n\n# Guard`,
    );

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });

    expect(commands[0]?.hooks).toEqual({
      PreToolUse: [{ matcher: "bash", hooks: [{ type: "prompt", prompt: "Check command" }] }],
    });
  });

  it("skips skill projections with invalid command names", async () => {
    await writeSkill("valid", "valid skill", "Valid prompt");
    await writeClaudeSkill(
      "bad name",
      "---\nname: bad name\ndescription: invalid\n---\n\nInvalid prompt",
    );
    await writeClaudeSkill(
      "nested",
      "---\nname: git:review\ndescription: invalid nested command\n---\n\nNested prompt",
    );

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });

    expect(commands.map((command) => [command.name, command.prompt])).toEqual([
      ["valid", "Valid prompt"],
    ]);
  });

  it("keeps project and user markdown commands above skill projections", async () => {
    await writeSkill("project-wins", "skill project", "Skill project prompt");
    await writeSkill("user-wins", "skill user", "Skill user prompt");
    await writeCommand(workDir, "project-wins", "project", "Project prompt");
    await writeCommand(userCommandsDir, "user-wins", "user", "User prompt");

    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });

    expect(commands.map((command) => [command.name, command.source, command.prompt])).toEqual([
      ["project-wins", "project", "Project prompt"],
      ["user-wins", "user", "User prompt"],
    ]);
  });

  it("uses priority project > user > skill projection > builtin", async () => {
    await writeCommand(workDir, "same", "project", "Project prompt");
    await writeCommand(userCommandsDir, "same", "user", "User prompt");
    await writeSkill("same", "skill", "Skill prompt");
    await writeSkill("builtin-only", "skill wins builtin", "Skill prompt");

    const commands = await loadMarkdownCommands({
      builtinNames: ["same", "builtin-only", "help"],
      includeSkillCommands: true,
      skillLoader: new SkillLoader(workDir),
      userCommandsDir,
      workDir,
    });

    expect(commands.map((command) => [command.name, command.source, command.prompt])).toEqual([
      ["builtin-only", "skill", "Skill prompt"],
      ["same", "project", "Project prompt"],
    ]);
  });

  it("renders prompt command arguments by replacing $ARGUMENTS", () => {
    const command = parseMarkdownCommand(
      "Review $ARGUMENTS\nThen summarize $ARGUMENTS",
      "review",
      "project",
    );

    expect(renderMarkdownCommandPrompt(command, "src/index.ts")).toBe(
      "Review src/index.ts\nThen summarize src/index.ts",
    );
  });

  it("renders positional prompt command arguments", () => {
    const command = parseMarkdownCommand(
      "Review $1 against $2\nAll: $ARGUMENTS",
      "review",
      "project",
    );

    expect(renderMarkdownCommandPrompt(command, 'src/index.ts "main branch" --strict')).toBe(
      'Review src/index.ts against main branch\nAll: src/index.ts "main branch" --strict',
    );
  });

  it("renders skill projections as explicit activations with zero-based arguments", async () => {
    await writeClaudeSkill(
      "review",
      "---\nname: review\ndescription: review code\n---\n\nReview $0 then $ARGUMENTS[1]",
    );
    const commands = await loadMarkdownCommands({
      includeSkillCommands: true,
      userCommandsDir,
      workDir,
    });
    const command = commands[0];

    expect(command).toBeDefined();
    expect(renderMarkdownCommandPrompt(command!, 'src/a.ts "main branch"')).toBe(
      [
        'User explicitly activated skill "review". Follow the loaded skill instructions and use them to complete the request.',
        "",
        `<pico-skill-loaded name="review" trigger="user-slash" source="${join(workDir, ".claude", "skills", "review", "SKILL.md")}">`,
        "Review src/a.ts then main branch",
        "</pico-skill-loaded>",
      ].join("\n"),
    );
  });

  it("keeps ordinary markdown commands on the existing renderer", () => {
    const command = parseMarkdownCommand("Follow this workflow", "review", "project");

    expect(renderMarkdownCommandPrompt(command, "fix login")).toBe("Follow this workflow");
  });

  async function writeCommand(
    root: string,
    name: string,
    description: string,
    prompt: string,
  ): Promise<void> {
    const commandsDir = root === userCommandsDir ? root : join(root, ".pico", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, `${name}.md`),
      `---\ndescription: ${description}\n---\n\n${prompt}`,
    );
  }

  async function writeSkill(name: string, description: string, body: string): Promise<void> {
    await mkdir(join(workDir, ".claw", "skills", name), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    );
  }

  async function writeClaudeSkill(name: string, content: string): Promise<void> {
    await mkdir(join(workDir, ".claude", "skills", name), { recursive: true });
    await writeFile(join(workDir, ".claude", "skills", name, "SKILL.md"), content);
  }
});
