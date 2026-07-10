import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandMentionsToPrompt,
  injectContextAttachments,
  resolveContextAttachments,
} from "../../src/input/context-attachments.js";
import { parseMentions } from "../../src/input/mentions.js";

describe("context attachments", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-mentions-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves a file line range and injects it into prompt text", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "src", "app.ts"), "one\ntwo\nthree\n");

    const result = await expandMentionsToPrompt("fix @src/app.ts#L2-99", {
      cwd: workDir,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      type: "file",
      reference: "src/app.ts",
      lineStart: 2,
      lineEnd: 3,
      truncated: true,
    });
    expect(result.prompt).toContain("fix @src/app.ts#L2-99");
    expect(result.prompt).toContain('<attachment type="file" reference="src/app.ts"');
    expect(result.prompt).toContain("2: two");
    expect(result.prompt).toContain("3: three");
    expect(result.prompt).toContain("已截断");
  });

  it("limits full file reads by line count and byte count", async () => {
    await writeFile(
      join(workDir, "big.txt"),
      Array.from({ length: 250 }, (_, index) => `line-${index}`).join("\n"),
    );

    const attachments = await resolveContextAttachments(parseMentions("@big.txt"), {
      cwd: workDir,
      limits: { maxFileLines: 5, maxFileBytes: 40 },
    });

    expect(attachments[0]?.type).toBe("file");
    expect(attachments[0]?.truncated).toBe(true);
    expect(attachments[0]?.content).toContain("1: line-0");
    expect(attachments[0]?.content).toContain("已截断");
    expect(attachments[0]?.content).not.toContain("line-20");
  });

  it("returns readable context for missing files instead of throwing", async () => {
    await expect(
      resolveContextAttachments(parseMentions("@missing.ts"), { cwd: workDir }),
    ).resolves.toMatchObject([
      {
        type: "missing",
        reference: "missing.ts",
        truncated: false,
      },
    ]);

    const attachments = await resolveContextAttachments(parseMentions("@missing.ts"), {
      cwd: workDir,
    });
    expect(attachments[0]?.content).toContain("File not found");
    expect(attachments[0]?.content).toContain("missing.ts");
  });

  it("lists directory entries with a hard limit", async () => {
    await mkdir(join(workDir, "docs"), { recursive: true });
    for (let index = 0; index < 5; index++) {
      await writeFile(join(workDir, "docs", `${index}.md`), "");
    }

    const attachments = await resolveContextAttachments(parseMentions("@docs"), {
      cwd: workDir,
      limits: { maxDirectoryEntries: 3 },
    });

    expect(attachments[0]).toMatchObject({
      type: "directory",
      reference: "docs",
      truncated: true,
    });
    expect(attachments[0]?.content.split("\n")).toHaveLength(4);
    expect(attachments[0]?.content).toContain("共 5 项,已截断");
  });

  it("summarizes directory mentions with files and subdirectories", async () => {
    await mkdir(join(workDir, "docs", "guide"), { recursive: true });
    await writeFile(join(workDir, "docs", "intro.md"), "");

    const attachments = await resolveContextAttachments(parseMentions("@docs"), { cwd: workDir });

    expect(attachments[0]).toMatchObject({
      type: "directory",
      reference: "docs",
      truncated: false,
    });
    expect(attachments[0]?.content).toContain("guide/");
    expect(attachments[0]?.content).toContain("intro.md");
  });

  it("resolves skill and agent mentions without changing Message schema", async () => {
    const attachments = await resolveContextAttachments(
      parseMentions("@skill:review @agent:tester"),
      {
        cwd: workDir,
        skills: { review: "Review checklist" },
        agents: { tester: "Test specialist" },
      },
    );

    expect(attachments).toMatchObject([
      {
        type: "skill",
        reference: "review",
        content: "Review checklist",
      },
      {
        type: "agent",
        reference: "tester",
        content: "Test specialist",
      },
    ]);

    const prompt = injectContextAttachments("hello", attachments);
    expect(prompt).toContain('<attachment type="skill" reference="review"');
    expect(prompt).toContain("Review checklist");
  });
});
