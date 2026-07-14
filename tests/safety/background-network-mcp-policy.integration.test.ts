import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import {
  fingerprintBackgroundMcpConfig,
  verifyBackgroundMcpConfig,
} from "../../src/safety/background-mcp-policy.js";
import { parseBackgroundYoloPolicySnapshot } from "../../src/safety/background-yolo-policy-schema.js";

describe("background network and MCP policy integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("规范化 unrestricted 工具网络并保留 MCP 配置指纹", () => {
    const fingerprint = "a".repeat(64);
    expect(
      parseBackgroundYoloPolicySnapshot({
        mode: "yolo",
        backgroundEnabled: true,
        trustedWorkspace: true,
        toolNetworkPolicy: "allow",
        allowedTools: ["fetch_url", "bash", "mcp__github__issues"],
        mcpConfigFingerprint: fingerprint,
        hardlineVersion: "builtin-v1",
        hookVersion: "workspace-v1",
        createdAt: 1,
      }),
    ).toMatchObject({ toolNetworkPolicy: "allow", mcpConfigFingerprint: fingerprint });
  });

  it("MCP 工具与配置指纹必须成对冻结", () => {
    const base = {
      mode: "yolo",
      backgroundEnabled: true,
      trustedWorkspace: true,
      toolNetworkPolicy: "allow",
      hardlineVersion: "builtin-v1",
      hookVersion: "workspace-v1",
      createdAt: 1,
    } as const;

    expect(() =>
      parseBackgroundYoloPolicySnapshot({
        ...base,
        allowedTools: ["mcp__github__issues"],
      }),
    ).toThrow(/必须绑定/u);
    expect(() =>
      parseBackgroundYoloPolicySnapshot({
        ...base,
        allowedTools: ["fetch_url"],
        mcpConfigFingerprint: "a".repeat(64),
      }),
    ).toThrow(/不得声明/u);
  });

  it("读取旧账本时裁剪未绑定指纹的 MCP 工具，新写入仍 fail-closed", () => {
    const legacy = {
      mode: "yolo",
      backgroundEnabled: true,
      trustedWorkspace: true,
      toolNetworkPolicy: "disabled",
      allowedTools: ["read_file", "mcp__legacy__query"],
      hardlineVersion: "builtin-v1",
      hookVersion: "workspace-v1",
      createdAt: 1,
    } as const;

    expect(() => parseBackgroundYoloPolicySnapshot(legacy)).toThrow(/必须绑定/u);
    expect(
      parseBackgroundYoloPolicySnapshot(legacy, {
        allowLegacyMcpWithoutFingerprint: true,
      }).allowedTools,
    ).toEqual(["read_file"]);
  });

  it("只接受固定工作区 MCP 配置且在内容漂移后 fail-closed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-mcp-"));
    cleanup.push(workspace);
    await mkdir(join(workspace, ".pico"));
    await writeFile(join(workspace, ".pico", "mcp.json"), '{"mcpServers":{}}');
    const fingerprint = await fingerprintBackgroundMcpConfig(workspace);

    const expectedPath = await realpath(join(workspace, ".pico", "mcp.json"));
    await expect(
      verifyBackgroundMcpConfig({ workspacePath: workspace, expectedFingerprint: fingerprint }),
    ).resolves.toBe(expectedPath);

    await writeFile(join(workspace, ".pico", "mcp.json"), '{"mcpServers":{"changed":{}}}');
    await expect(
      verifyBackgroundMcpConfig({ workspacePath: workspace, expectedFingerprint: fingerprint }),
    ).rejects.toThrow(/重新确认/u);
  });

  it("MCP manager 校验并解析同一份配置字节，消除校验与加载间漂移", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-mcp-load-"));
    cleanup.push(workspace);
    await mkdir(join(workspace, ".pico"));
    const configPath = join(workspace, ".pico", "mcp.json");
    await writeFile(configPath, '{"mcpServers":{}}');
    const fingerprint = await fingerprintBackgroundMcpConfig(workspace);
    const manager = new McpConnectionManager(undefined, {
      stdioCwd: workspace,
      expectedConfigFingerprint: fingerprint,
    });

    await expect(manager.loadConfig(configPath)).resolves.toBeUndefined();
    await writeFile(configPath, '{"mcpServers":{"changed":{"transport":"http"}}}');
    await expect(manager.loadConfig(configPath)).rejects.toThrow(/重新确认/u);
  });

  it("拒绝通过 .pico/mcp.json 符号链接逃逸工作区", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pico-background-mcp-link-"));
    const outside = await mkdtemp(join(tmpdir(), "pico-background-mcp-outside-"));
    cleanup.push(workspace, outside);
    await mkdir(join(workspace, ".pico"));
    await writeFile(join(outside, "mcp.json"), '{"mcpServers":{}}');
    await symlink(join(outside, "mcp.json"), join(workspace, ".pico", "mcp.json"));

    await expect(fingerprintBackgroundMcpConfig(workspace)).rejects.toThrow(/真实工作区/u);
  });
});
