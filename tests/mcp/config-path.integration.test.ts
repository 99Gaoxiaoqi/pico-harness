import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it.each([".pico", ".claw"])("拒绝 %s/mcp.json 符号链接", async (configDir) => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-mcp-path-link-"));
    cleanups.push(workspace);
    await mkdir(join(workspace, configDir));
    const target = join(workspace, "safe-mcp.json");
    await writeFile(target, '{"mcpServers":{}}');
    await symlink(target, join(workspace, configDir, "mcp.json"));

    await expect(resolveProjectMcpConfigPath(workspace)).rejects.toThrow(/符号链接/u);
  });

  it.each([".pico", ".claw"])(
    "拒绝 %s 目录符号链接导致配置 realpath 越出工作区",
    async (configDir) => {
      const workspace = await mkdtemp(join(tmpdir(), "pico-mcp-path-workspace-"));
      const outside = await mkdtemp(join(tmpdir(), "pico-mcp-path-outside-"));
      cleanups.push(workspace, outside);
      await writeFile(join(outside, "mcp.json"), '{"mcpServers":{}}');
      await symlink(outside, join(workspace, configDir));

      await expect(resolveProjectMcpConfigPath(workspace)).rejects.toThrow(/真实工作区/u);
    },
  );

  it.each([".pico", ".claw"])("拒绝非普通文件 %s/mcp.json", async (configDir) => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-mcp-path-not-file-"));
    cleanups.push(workspace);
    await mkdir(join(workspace, configDir, "mcp.json"), { recursive: true });

    await expect(resolveProjectMcpConfigPath(workspace)).rejects.toThrow(/普通文件/u);
  });
});
