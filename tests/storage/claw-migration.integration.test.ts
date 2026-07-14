import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashToolResultArtifactArgs,
  ToolResultArtifactStore,
} from "../../src/context/artifact-store.js";
import {
  ClawMigrationConflictError,
  ClawMigrationLockedError,
  migrateLegacyClawWorkspace,
} from "../../src/paths/claw-migration.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  createArtifactInspectorContext,
  createArtifactInspectorSource,
  readInspectorPage,
} from "../../src/tui/inspector.js";

describe("legacy .claw workspace migration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("splits declarations and runtime state without deleting legacy or importing trust", async () => {
    const { home, paths, workDir } = await fixture();
    await writeLegacy(workDir, "skills/review/SKILL.md", "# Review\n");
    await writeLegacy(workDir, "skills/review/reference.md", "reference\n");
    await writeLegacy(workDir, "skills/review/state.json", '{"runs":2}\n');
    await writeLegacy(workDir, "agents.yaml", "version: 1\nagents: []\n");
    await writeLegacy(workDir, "mcp.json", '{"mcpServers":{}}\n');
    await writeLegacy(workDir, "sessions/session-a.jsonl", '{"role":"user"}\n');
    await writeLegacy(workDir, "runtime.sqlite", "sqlite-bytes");
    await writeLegacy(workDir, "artifacts/result.txt", "artifact\n");
    await writeLegacy(workDir, "todo.json", '{"items":[]}\n');
    await writeLegacy(workDir, "trusted-hooks.json", '{"trusted":true}\n');

    const result = await migrateLegacyClawWorkspace(workDir, { picoHome: home });

    expect(result.status).toBe("migrated");
    await expect(readFile(join(paths.project.skills, "review", "SKILL.md"), "utf8")).resolves.toBe(
      "# Review\n",
    );
    await expect(
      readFile(join(paths.project.skills, "review", "reference.md"), "utf8"),
    ).resolves.toBe("reference\n");
    await expect(
      readFile(join(paths.workspace.memory, "skills", "review", "state.json"), "utf8"),
    ).resolves.toBe('{"runs":2}\n');
    await expect(readFile(paths.project.agents, "utf8")).resolves.toContain("version: 1");
    await expect(readFile(paths.project.mcp, "utf8")).resolves.toContain("mcpServers");
    await expect(
      readFile(join(paths.workspace.sessions, "session-a.jsonl"), "utf8"),
    ).resolves.toContain("user");
    await expect(readFile(paths.workspace.runtimeDatabase, "utf8")).resolves.toBe("sqlite-bytes");
    await expect(readFile(join(paths.workspace.artifacts, "result.txt"), "utf8")).resolves.toBe(
      "artifact\n",
    );
    await expect(readFile(paths.workspace.todo, "utf8")).resolves.toContain("items");

    await expect(readFile(join(workDir, ".claw", "mcp.json"), "utf8")).resolves.toContain(
      "mcpServers",
    );
    await expect(readFile(join(workDir, ".claw", "runtime.sqlite"), "utf8")).resolves.toBe(
      "sqlite-bytes",
    );
    expect(result.ignoredLegacyEntries).toContain("trusted-hooks.json");
    await expect(access(join(paths.workspace.root, "trusted-hooks.json"))).rejects.toThrow();
    await expect(access(join(paths.home.root, "trusted-hooks.json"))).rejects.toThrow();
    await expect(access(result.markerPath)).resolves.toBeUndefined();
    await expect(
      access(join(paths.workspace.migrations, "claw-v1.journal.json")),
    ).rejects.toThrow();
  });

  it("uses the marker as the idempotent authority and ignores later legacy changes", async () => {
    const { home, paths, workDir } = await fixture();
    await writeLegacy(workDir, "sessions/original.jsonl", "original\n");

    const first = await migrateLegacyClawWorkspace(workDir, { picoHome: home });
    await writeLegacy(workDir, "sessions/late.jsonl", "late\n");
    await writePath(join(paths.workspace.migrations, "claw-v1.lock"), '{"pid":1}\n');
    const second = await migrateLegacyClawWorkspace(workDir, { picoHome: home });

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("already-migrated");
    expect(second.migrated).toEqual(first.migrated);
    await expect(readFile(join(paths.workspace.sessions, "original.jsonl"), "utf8")).resolves.toBe(
      "original\n",
    );
    await expect(access(join(paths.workspace.sessions, "late.jsonl"))).rejects.toThrow();
  });

  it("fails closed before copying when a destination already exists", async () => {
    const { home, paths, workDir } = await fixture();
    await writeLegacy(workDir, "mcp.json", '{"legacy":true}\n');
    await writeLegacy(workDir, "sessions/session-a.jsonl", "session\n");
    await writePath(paths.project.mcp, '{"native":true}\n');

    const outcome = migrateLegacyClawWorkspace(workDir, { picoHome: home });

    await expect(outcome).rejects.toBeInstanceOf(ClawMigrationConflictError);
    await expect(readFile(paths.project.mcp, "utf8")).resolves.toBe('{"native":true}\n');
    await expect(access(join(paths.workspace.sessions, "session-a.jsonl"))).rejects.toThrow();
    await expect(access(join(paths.workspace.migrations, "claw-v1.marker.json"))).rejects.toThrow();
    await expect(
      access(join(paths.workspace.migrations, "claw-v1.journal.json")),
    ).rejects.toThrow();
    await expect(readFile(join(workDir, ".claw", "mcp.json"), "utf8")).resolves.toBe(
      '{"legacy":true}\n',
    );
  });

  it("rejects ambiguous agents.yaml and agents.yml instead of picking one", async () => {
    const { home, paths, workDir } = await fixture();
    await writeLegacy(workDir, "agents.yaml", "agents: []\n");
    await writeLegacy(workDir, "agents.yml", "agents: [other]\n");

    await expect(migrateLegacyClawWorkspace(workDir, { picoHome: home })).rejects.toBeInstanceOf(
      ClawMigrationConflictError,
    );
    await expect(access(paths.project.agents)).rejects.toThrow();
  });

  it("honors the workspace migration lock", async () => {
    const { home, paths, workDir } = await fixture();
    const lockPath = join(paths.workspace.migrations, "claw-v1.lock");
    await writePath(lockPath, '{"pid":1}\n');

    await expect(migrateLegacyClawWorkspace(workDir, { picoHome: home })).rejects.toEqual(
      expect.objectContaining<Partial<ClawMigrationLockedError>>({
        name: "ClawMigrationLockedError",
        lockPath,
      }),
    );
    await expect(readFile(lockPath, "utf8")).resolves.toContain("pid");
  });

  it("resumes a verified journal after a copy completed before marker creation", async () => {
    const { home, paths, workDir } = await fixture();
    await writeLegacy(workDir, "mcp.json", '{"mcpServers":{}}\n');
    const sourcePath = join(paths.canonicalWorkDir, ".claw", "mcp.json");
    await writePath(paths.project.mcp, '{"mcpServers":{}}\n');
    const sourceInfo = await stat(sourcePath);
    const sha256 = createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex");
    const item = {
      kind: "project-mcp",
      sourcePath,
      targetPath: paths.project.mcp,
      targetRoot: paths.project.root,
      size: sourceInfo.size,
      mode: sourceInfo.mode & 0o777,
      sha256,
      targetSize: sourceInfo.size,
      targetSha256: sha256,
    };
    await writePath(
      join(paths.workspace.migrations, "claw-v1.journal.json"),
      `${JSON.stringify(
        {
          version: 1,
          migrationId: "claw-v1",
          canonicalWorkDir: paths.canonicalWorkDir,
          legacyRoot: join(paths.canonicalWorkDir, ".claw"),
          items: [item],
          completedTargets: [],
        },
        null,
        2,
      )}\n`,
    );

    const result = await migrateLegacyClawWorkspace(workDir, { picoHome: home });

    expect(result.status).toBe("migrated");
    await expect(readFile(paths.project.mcp, "utf8")).resolves.toBe('{"mcpServers":{}}\n');
    await expect(readFile(sourcePath, "utf8")).resolves.toBe('{"mcpServers":{}}\n');
    await expect(access(result.markerPath)).resolves.toBeUndefined();
  });

  it("copies across separate legacy and PICO_HOME roots without renaming the source", async () => {
    const { home, paths, workDir } = await fixture();
    const sourcePath = await writeLegacy(workDir, "sessions/cross-device.jsonl", "portable\n");

    await migrateLegacyClawWorkspace(workDir, { picoHome: home });

    await expect(readFile(sourcePath, "utf8")).resolves.toBe("portable\n");
    await expect(
      readFile(join(paths.workspace.sessions, "cross-device.jsonl"), "utf8"),
    ).resolves.toBe("portable\n");
  });

  it("rewrites artifact metadata so migrated artifacts remain cloneable and inspectable", async () => {
    const { home, paths, workDir } = await fixture();
    const args = { command: "npm test" };
    const legacyStore = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    });
    const legacyMeta = await legacyStore.write({
      id: "result-a",
      sessionId: "session-a",
      toolName: "bash",
      args,
      output: "artifact body",
    });

    await migrateLegacyClawWorkspace(workDir, { picoHome: home });

    const migratedStore = new ToolResultArtifactStore({ baseDir: paths.workspace.artifacts });
    const migratedMeta = await migratedStore.readMeta("result-a", "session-a");
    expect(migratedMeta?.path).toBe(
      join(paths.workspace.artifacts, "sessions", "session-a", "tool-results", "result-a.txt"),
    );
    expect(migratedMeta?.path).not.toBe(legacyMeta.path);
    await expect(migratedStore.cloneSession("session-a", "session-b")).resolves.toMatchObject({
      sourceSessionId: "session-a",
      targetSessionId: "session-b",
    });

    const source = createArtifactInspectorSource({
      title: "bash result",
      artifactRef: "artifact://session-a/result-a",
      context: createArtifactInspectorContext({
        workDir,
        sessionId: "session-a",
        trustedRoot: paths.workspace.artifacts,
      }),
      expectedToolName: "bash",
      expectedArgsHash: hashToolResultArtifactArgs(args),
    });
    expect(source).toBeDefined();
    await expect(readInspectorPage(source!)).resolves.toMatchObject({
      content: "artifact body",
      availability: "complete",
    });
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pico-claw-migration-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const home = join(root, "pico-home-on-another-root");
    await mkdir(workDir, { recursive: true });
    return { workDir, home, paths: resolvePicoPaths(workDir, { picoHome: home }) };
  }

  async function writeLegacy(workDir: string, relativePath: string, content: string) {
    const path = join(workDir, ".claw", relativePath);
    await writePath(path, content);
    return path;
  }

  async function writePath(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
});
