import { describe, expect, it } from "vitest";
import { secureBackgroundMcpServerConfig } from "../../src/safety/background-mcp-client.js";

describe("background MCP client integration", () => {
  it("用允许联网的 macOS sandbox 包装 stdio server", () => {
    const secured = secureBackgroundMcpServerConfig(
      {
        name: "github",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      },
      process.cwd(),
      "darwin",
    );

    expect(secured.command).toBe("/usr/bin/sandbox-exec");
    expect(secured.args?.join(" ")).toContain("(allow network*)");
    expect(secured.args?.slice(-2)).toEqual(["node", "server.js"]);
  });

  it("无等价 OS sandbox 时拒绝后台 stdio MCP", () => {
    expect(() =>
      secureBackgroundMcpServerConfig(
        { name: "local", transport: "stdio", command: "node" },
        process.cwd(),
        "linux",
      ),
    ).toThrow(/sandbox/u);
  });

  it("拒绝 stdio MCP 自定义 cwd，但保留 HTTP 配置", () => {
    expect(() =>
      secureBackgroundMcpServerConfig(
        { name: "local", transport: "stdio", command: "node", cwd: "/tmp" },
        process.cwd(),
        "darwin",
      ),
    ).toThrow(/工作目录/u);

    const remote = { name: "remote", transport: "http" as const, url: "https://mcp.example" };
    expect(secureBackgroundMcpServerConfig(remote, process.cwd(), "linux")).toBe(remote);
  });
});
