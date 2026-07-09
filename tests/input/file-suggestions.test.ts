import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex } from "../../src/input/file-index.js";
import { listFileSuggestions } from "../../src/input/file-index.js";

describe("listFileSuggestions", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-file-suggestions-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("prefers git ls-files output", async () => {
    const calls: string[] = [];
    const suggestions = await listFileSuggestions({
      cwd: workDir,
      query: "src/",
      commandRunner: async (command) => {
        calls.push(command);
        if (command === "git") return "src/app.ts\nREADME.md\n";
        return "";
      },
    });

    expect(suggestions).toEqual(["src/app.ts"]);
    expect(calls).toEqual(["git"]);
  });

  it("disables git quoted paths so Chinese file names are suggested normally", async () => {
    const quotedOctalPath = String.raw`"\345\206\205\345\256\271/\350\257\264\346\230\216.md"`;
    let gitArgs: string[] | undefined;

    const suggestions = await listFileSuggestions({
      cwd: workDir,
      query: "@内容",
      commandRunner: async (command, args) => {
        if (command !== "git") return "";
        gitArgs = args;
        if (args.includes("core.quotepath=false")) {
          return "内容/说明.md\nsrc/app.ts\n";
        }
        return `${quotedOctalPath}\nsrc/app.ts\n`;
      },
    });

    expect(gitArgs).toEqual(["-c", "core.quotepath=false", "ls-files"]);
    expect(suggestions).toEqual(["内容/说明.md"]);
    expect(suggestions).not.toContain(quotedOctalPath);
  });

  it("falls back to rg --files when git fails", async () => {
    const calls: string[] = [];
    const suggestions = await listFileSuggestions({
      cwd: workDir,
      query: ".ts",
      commandRunner: async (command) => {
        calls.push(command);
        if (command === "git") throw new Error("not git");
        return "src/app.ts\nnotes.md\n";
      },
    });

    expect(suggestions).toEqual(["src/app.ts"]);
    expect(calls).toEqual(["git", "rg"]);
  });

  it("falls back to Node directory scan outside git and rg", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await mkdir(join(workDir, "node_modules"), { recursive: true });
    await writeFile(join(workDir, "src", "app.ts"), "");
    await writeFile(join(workDir, "README.md"), "");
    await writeFile(join(workDir, "node_modules", "hidden.ts"), "");

    const suggestions = await listFileSuggestions({
      cwd: workDir,
      query: "src",
      commandRunner: async () => {
        throw new Error("missing command");
      },
    });

    expect(suggestions).toEqual(["src/app.ts"]);
  });

  it("treats @-prefixed query text as a relative file path", async () => {
    const suggestions = await listFileSuggestions({
      cwd: workDir,
      query: "@src",
      commandRunner: async () => "src/app.ts\nREADME.md\n",
    });

    expect(suggestions).toEqual(["src/app.ts"]);
  });

  it("can use a long-lived FileIndex cache", async () => {
    const calls: string[] = [];
    const fileIndex = FileIndex.create({
      cwd: workDir,
      commandRunner: async (command) => {
        calls.push(command);
        return "src/app.ts\nREADME.md\n";
      },
    });

    await expect(
      listFileSuggestions({ cwd: workDir, query: "src", fileIndex }),
    ).resolves.toEqual(["src/app.ts"]);
    await expect(
      listFileSuggestions({ cwd: workDir, query: "README", fileIndex }),
    ).resolves.toEqual(["README.md"]);

    expect(calls).toEqual(["git"]);
  });
});
