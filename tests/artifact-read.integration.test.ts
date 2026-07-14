import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import { ReadArtifactTool } from "../src/tools/artifact-read.js";
import { ReadFileTool } from "../src/tools/registry-impl.js";

describe("read_artifact capability", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads committed workspace artifacts without widening read_file roots", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-artifact-read-workspace-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-artifact-read-home-"));
    cleanup.push(workDir, picoHome);
    const artifactBaseDir = resolvePicoPaths(workDir, { picoHome }).workspace.artifacts;
    const store = new ToolResultArtifactStore({ baseDir: artifactBaseDir });
    const meta = await store.write({
      id: "large-output",
      sessionId: "session-a",
      toolName: "bash",
      args: { command: "test" },
      output: "line one\nline two\nline three",
    });

    const readArtifact = new ReadArtifactTool(workDir, artifactBaseDir);
    await expect(
      readArtifact.execute(JSON.stringify({ path: meta.path, offsetBytes: 9, limitBytes: 8 })),
    ).resolves.toContain("line two");

    const readFile = new ReadFileTool(workDir);
    await expect(readFile.execute(JSON.stringify({ path: meta.path }))).rejects.toThrow(
      "路径不在当前工作区",
    );
  });

  it("bounds a single huge line and returns a byte continuation cursor", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-artifact-page-workspace-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-artifact-page-home-"));
    cleanup.push(workDir, picoHome);
    const artifactBaseDir = resolvePicoPaths(workDir, { picoHome }).workspace.artifacts;
    const meta = await new ToolResultArtifactStore({ baseDir: artifactBaseDir }).write({
      id: "huge-line",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "x".repeat(200_000),
    });

    const output = await new ReadArtifactTool(workDir, artifactBaseDir).execute(
      JSON.stringify({ path: meta.path }),
    );
    expect(output.length).toBeLessThan(18_000);
    expect(output).toContain('"offsetBytes":16384');
    expect(output).toContain("PARTIAL:");
  });

  it("rejects arbitrary files even when their path is under PICO_HOME", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-artifact-reject-workspace-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-artifact-reject-home-"));
    cleanup.push(workDir, picoHome);
    const paths = resolvePicoPaths(workDir, { picoHome });
    const arbitrary = join(paths.workspace.root, "secret.txt");
    await mkdir(paths.workspace.root, { recursive: true });
    await writeFile(arbitrary, "secret");

    await expect(
      new ReadArtifactTool(workDir, paths.workspace.artifacts).execute(
        JSON.stringify({ path: arbitrary }),
      ),
    ).rejects.toThrow("outside the committed artifact layout");
  });
});
