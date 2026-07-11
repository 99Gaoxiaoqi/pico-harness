import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CodeIntelligenceManager } from "../src/code-intelligence/code-intelligence-manager.js";
import { McpConnectionManager } from "../src/mcp/manager.js";

const mcpFixture = fileURLToPath(new URL("./mcp/fixtures/mock-stdio-server.mjs", import.meta.url));
const lspFixture = fileURLToPath(new URL("./e2e/fixtures/mock-lsp-server.mjs", import.meta.url));

it("MCP 与 LSP 子进程只获得最小环境及显式授权变量", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pico-child-env-"));
  const mcpSnapshotPath = path.join(root, "mcp-env.json");
  const lspSnapshotPath = path.join(root, "lsp-env.json");
  const mcpConfigPath = path.join(root, "mcp.json");
  const hostSecretName = "PICO_TEST_UNDECLARED_HOST_SECRET";
  const previousHostSecret = process.env[hostSecretName];
  process.env[hostSecretName] = "must-not-leak";

  const mcpManager = new McpConnectionManager(undefined, {
    stdioCwd: root,
    oauthHandler: async () => ({ env: { PICO_TEST_MCP_OAUTH_TOKEN: "oauth-visible" } }),
  });
  const lspManager = new CodeIntelligenceManager({
    rootDir: root,
    pathEnv: "",
    lspServers: [
      {
        id: "env-probe-lsp",
        command: process.execPath,
        args: [lspFixture, "--env-snapshot", lspSnapshotPath],
        env: { PICO_TEST_LSP_CONFIG: "lsp-visible" },
      },
    ],
  });

  try {
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          envProbe: {
            transport: "stdio",
            command: process.execPath,
            args: [mcpFixture, "--env-snapshot", mcpSnapshotPath],
            env: { PICO_TEST_MCP_CONFIG: "config-visible" },
          },
        },
      }),
      "utf8",
    );
    await mcpManager.loadConfig(mcpConfigPath);
    await mcpManager.connectAll();
    expect(mcpManager.getStatusSnapshot().summary.connected).toBe(1);
    await mcpManager.authenticate("envProbe");

    const mcpEnv = await readEnvironmentSnapshot(mcpSnapshotPath);
    expect(mcpEnv[hostSecretName]).toBeUndefined();
    expect(mcpEnv.PICO_TEST_MCP_CONFIG).toBe("config-visible");
    expect(mcpEnv.PICO_TEST_MCP_OAUTH_TOKEN).toBe("oauth-visible");
    expect(environmentValue(mcpEnv, "PATH")).toBe(environmentValue(process.env, "PATH"));

    await expect(lspManager.start()).resolves.toMatchObject({
      backend: "lsp",
      serverId: "env-probe-lsp",
    });
    const lspEnv = await readEnvironmentSnapshot(lspSnapshotPath);
    expect(lspEnv[hostSecretName]).toBeUndefined();
    expect(lspEnv.PICO_TEST_LSP_CONFIG).toBe("lsp-visible");
    expect(environmentValue(lspEnv, "PATH")).toBe(environmentValue(process.env, "PATH"));
  } finally {
    await Promise.allSettled([mcpManager.closeAll(), lspManager.close()]);
    if (previousHostSecret === undefined) delete process.env[hostSecretName];
    else process.env[hostSecretName] = previousHostSecret;
    await rm(root, { recursive: true, force: true });
  }
});

async function readEnvironmentSnapshot(filePath: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  if (process.platform !== "win32") return env[name];
  const normalized = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1];
}
