import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectMcpConfigPath } from "../../src/mcp/config-path.js";

describe("project MCP config path", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("uses Pico-native config first and keeps .claw as a read-only fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-mcp-path-"));
    cleanups.push(workspace);
    const picoPath = join(workspace, ".pico", "mcp.json");
    const legacyPath = join(workspace, ".claw", "mcp.json");

    await expect(resolveProjectMcpConfigPath(workspace)).resolves.toEqual({
      path: picoPath,
      source: "pico",
      exists: false,
    });

    await mkdir(join(workspace, ".claw"));
    await writeFile(legacyPath, '{"mcpServers":{}}');
    await expect(resolveProjectMcpConfigPath(workspace)).resolves.toEqual({
      path: legacyPath,
      source: "claw-compat",
      exists: true,
    });

    await mkdir(join(workspace, ".pico"));
    await writeFile(picoPath, '{"mcpServers":{}}');
    await expect(resolveProjectMcpConfigPath(workspace)).resolves.toEqual({
      path: picoPath,
      source: "pico",
      exists: true,
    });
  });
});
