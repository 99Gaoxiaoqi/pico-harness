import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFileSuggestions } from "../../src/input/file-suggestions.js";

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
});
