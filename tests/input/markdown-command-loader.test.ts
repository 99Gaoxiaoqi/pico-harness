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
    const command = parseMarkdownCommand("Review $ARGUMENTS\nThen summarize $ARGUMENTS", "review", "project");

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
      "Review src/index.ts against main branch\nAll: src/index.ts \"main branch\" --strict",
    );
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
});
