import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "../../src/context/skill.js";
import {
  renderAgentListCommand,
  renderSkillCommand,
  renderSkillListCommand,
  resolveSkillCommand,
} from "../../src/input/skill-commands.js";

describe("skill command helpers", () => {
  let workDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-skill-command-"));
    loader = new SkillLoader(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("renders /skills with all skill names and descriptions", async () => {
    await writeSkill("review", "审查代码", "# Review\n检查风险");
    await writeSkill("deploy", "部署服务", "# Deploy\n发布步骤");

    const output = await renderSkillListCommand(loader);

    expect(output).toContain("可用 Skills");
    expect(output).toContain("- deploy: 部署服务");
    expect(output).toContain("- review: 审查代码");
    expect(output).not.toContain("发布步骤");
    expect(output).not.toContain("检查风险");
  });

  it("renders /skills empty state when no skills exist", async () => {
    await expect(renderSkillListCommand(loader)).resolves.toBe("当前没有可用 Skills。");
  });

  it("renders /skill <name> with full skill body", async () => {
    await writeSkill("review", "审查代码", "# Review\n检查风险");

    await expect(renderSkillCommand(loader, " review ")).resolves.toBe("# Review\n检查风险");
  });

  it("renders available skill names when /skill <name> cannot be found", async () => {
    await writeSkill("deploy", "部署服务", "# Deploy");
    await writeSkill("review", "审查代码", "# Review");

    const output = await renderSkillCommand(loader, "missing");

    expect(output).toContain("未找到 Skill: missing");
    expect(output).toContain("可用 Skills: deploy, review");
  });

  it("resolves /skill <name> as structured data for command routers", async () => {
    await writeSkill("review", "审查代码", "# Review\n检查风险");

    await expect(resolveSkillCommand(loader, "review")).resolves.toEqual({
      found: true,
      name: "review",
      body: "# Review\n检查风险",
    });
    await expect(resolveSkillCommand(loader, "missing")).resolves.toEqual({
      available: [{ name: "review", description: "审查代码" }],
      found: false,
      name: "missing",
    });
  });

  it("renders /agents with Claude agent summaries and data", async () => {
    await mkdir(join(workDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查代码\n---\n\n# Reviewer",
    );
    await writeFile(
      join(workDir, ".claude", "agents", "writer.md"),
      "---\ndescription: 撰写文档\n---\n\n# Writer",
    );

    const output = await renderAgentListCommand({ workDir });

    expect(output.message).toContain("可用 Agents");
    expect(output.message).toContain("- reviewer: 审查代码");
    expect(output.message).toContain("- writer: 撰写文档");
    expect(output.data).toEqual([
      {
        description: "审查代码",
        name: "reviewer",
        sourcePath: join(workDir, ".claude", "agents", "reviewer.md"),
      },
      {
        description: "撰写文档",
        name: "writer",
        sourcePath: join(workDir, ".claude", "agents", "writer.md"),
      },
    ]);
  });

  it("renders /agents empty state when no Claude agents exist", async () => {
    await expect(renderAgentListCommand({ workDir })).resolves.toEqual({
      data: [],
      message: "当前没有可用 Agents。",
    });
  });

  async function writeSkill(name: string, description: string, body: string): Promise<void> {
    await mkdir(join(workDir, ".claw", "skills", name), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    );
  }
});
