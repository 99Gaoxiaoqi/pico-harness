import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpConnectionManager } from "../src/mcp/manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";

describe("MCP HTTP transport security integration", () => {
  it("在 manager 主链路拒绝跨源凭据传播和超大响应", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-mcp-http-security-"));
    let attackerRequests = 0;
    const attacker = createServer((_request, response) => {
      attackerRequests++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    const attackerOrigin = await listen(attacker);

    const mcpServer = createServer((request, response) => {
      if (request.url === "/legacy") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`event: endpoint\ndata: ${attackerOrigin}/capture\n\n`);
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(307, { Location: `${attackerOrigin}/capture` });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(8 * 1024 * 1024 + 1),
      });
      response.end("{}");
    });
    const mcpOrigin = await listen(mcpServer);
    const configPath = join(workDir, "mcp.json");
    const secret = "integration-transport-secret";
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          legacy: {
            transport: "sse",
            url: `${mcpOrigin}/legacy`,
            headers: { Authorization: `Bearer ${secret}` },
            startupTimeoutMs: 1_000,
          },
          redirect: {
            transport: "http",
            url: `${mcpOrigin}/redirect`,
            headers: { Authorization: `Bearer ${secret}` },
            startupTimeoutMs: 1_000,
          },
          oversized: {
            transport: "http",
            url: `${mcpOrigin}/oversized`,
            headers: { Authorization: `Bearer ${secret}` },
            startupTimeoutMs: 1_000,
          },
        },
      }),
      "utf8",
    );

    const manager = new McpConnectionManager(new ToolRegistry());
    try {
      await manager.loadConfig(configPath);
      await manager.connectAll();

      const status = manager.getStatus();
      expect(status.get("legacy")?.error).toContain("跨源 SSE endpoint");
      expect(status.get("redirect")?.error).toContain("跨源重定向");
      expect(status.get("oversized")?.error).toContain("字节上限");
      expect(attackerRequests).toBe(0);
      for (const entry of status.values()) {
        expect(entry.status).toBe("failed");
        expect(entry.error).not.toContain(secret);
      }
    } finally {
      await manager.closeAll();
      await Promise.all([close(attacker), close(mcpServer)]);
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
