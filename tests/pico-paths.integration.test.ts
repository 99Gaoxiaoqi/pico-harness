import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePicoHome, resolvePicoPaths, workspaceIdForPath } from "../src/paths/pico-paths.js";

describe("Pico paths", () => {
  it("separates project resources, user resources and workspace runtime state", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-paths-project-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-paths-home-"));
    const paths = resolvePicoPaths(workDir, { picoHome });

    expect(paths.project.skills).toBe(join(await realpath(workDir), ".pico", "skills"));
    expect(paths.home.skills).toBe(join(picoHome, "skills"));
    expect(paths.workspace.root).toBe(join(picoHome, "workspaces", paths.workspace.id));
    expect(paths.workspace.sessions).toBe(join(paths.workspace.root, "sessions"));
    expect(paths.workspace.runtimeDatabase).toBe(join(paths.workspace.root, "runtime.sqlite"));
  });

  it("uses the canonical real path so aliases share one workspace id", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pico-paths-alias-"));
    const workspace = join(parent, "workspace");
    const alias = join(parent, "workspace-link");
    await mkdir(workspace);
    await symlink(workspace, alias, "dir");

    expect(workspaceIdForPath(alias)).toBe(workspaceIdForPath(workspace));
    expect(String(workspaceIdForPath(workspace))).toContain(basename(workspace));
  });

  it("honors an explicit PICO_HOME override", () => {
    expect(
      resolvePicoHome({ env: { PICO_HOME: "./custom-pico-home" }, homeDir: "/ignored" }),
    ).toMatch(/custom-pico-home$/u);
  });
});
