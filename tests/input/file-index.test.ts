import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex } from "../../src/input/file-index.js";

describe("FileIndex", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-file-index-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("builds the index on first query and reuses cached files", async () => {
    const calls: string[] = [];
    const index = FileIndex.create({
      cwd: workDir,
      commandRunner: async (command) => {
        calls.push(command);
        return "src/app.ts\nsrc/api.ts\nREADME.md\n";
      },
    });

    await expect(index.query("src/", 10)).resolves.toEqual([
      "src/api.ts",
      "src/app.ts",
    ]);
    await expect(index.query("README", 10)).resolves.toEqual(["README.md"]);

    expect(calls).toEqual(["git"]);
  });

  it("refreshes the cached file list explicitly", async () => {
    let output = "src/app.ts\n";
    const calls: string[] = [];
    const index = FileIndex.create({
      cwd: workDir,
      commandRunner: async (command) => {
        calls.push(command);
        return output;
      },
    });

    await expect(index.query("new", 10)).resolves.toEqual([]);
    output = "src/app.ts\nsrc/new.ts\n";
    await expect(index.query("new", 10)).resolves.toEqual([]);

    await index.refresh();

    await expect(index.query("new", 10)).resolves.toEqual(["src/new.ts"]);
    expect(calls).toEqual(["git", "git"]);
  });

  it("falls back from git ls-files to rg --files", async () => {
    const calls: string[] = [];
    const index = FileIndex.create({
      cwd: workDir,
      commandRunner: async (command) => {
        calls.push(command);
        if (command === "git") throw new Error("not a git repo");
        return "src/app.ts\nnotes.md\n";
      },
    });

    await expect(index.query(".ts", 10)).resolves.toEqual(["src/app.ts"]);
    expect(calls).toEqual(["git", "rg"]);
  });

  it("falls back to a Node scan and ignores generated directories", async () => {
    await mkdir(join(workDir, "src"), { recursive: true });
    await mkdir(join(workDir, "node_modules"), { recursive: true });
    await mkdir(join(workDir, ".git"), { recursive: true });
    await writeFile(join(workDir, "src", "app.ts"), "");
    await writeFile(join(workDir, "README.md"), "");
    await writeFile(join(workDir, "node_modules", "hidden.ts"), "");
    await writeFile(join(workDir, ".git", "config"), "");

    const index = FileIndex.create({
      cwd: workDir,
      commandRunner: async () => {
        throw new Error("missing command");
      },
    });

    await expect(index.query("", 10)).resolves.toEqual([
      "README.md",
      "src/app.ts",
    ]);
  });

  it("filters ignored directories from command output", async () => {
    const index = FileIndex.create({
      cwd: workDir,
      commandRunner: async () =>
        "src/app.ts\nnode_modules/hidden.ts\n.git/config\n",
    });

    await expect(index.query("", 10)).resolves.toEqual(["src/app.ts"]);
  });
});
