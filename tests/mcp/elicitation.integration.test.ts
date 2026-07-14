import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMcpClient } from "../../src/mcp/http-client.js";
import { McpElicitationUiHandler } from "../../src/mcp/elicitation-ui.js";
import { StdioMcpClient } from "../../src/mcp/stdio-client.js";
import { MCP_ELICITATION_PROTOCOL_VERSION } from "../../src/mcp/types.js";

const fixture = fileURLToPath(new URL("./fixtures/elicitation-stdio-server.mjs", import.meta.url));

describe("MCP elicitation integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("在 stdio 双向请求中协商 capability，且 server id 不会提前完成 tool call", async () => {
    const client = new StdioMcpClient(
      {
        name: "elicitation",
        transport: "stdio",
        command: process.execPath,
        args: [fixture],
      },
      {
        elicitationHandler: async () => ({
          action: "accept",
          content: { environment: "prod" },
        }),
      },
    );
    try {
      await client.connect();
      const result = await client.callTool("ask", {});
      const payload = JSON.parse(result.content[0]!.text!) as {
        initialized: { protocolVersion: string; capabilities: Record<string, unknown> };
        elicitationResult: unknown;
      };
      expect(payload.initialized).toMatchObject({
        protocolVersion: MCP_ELICITATION_PROTOCOL_VERSION,
        capabilities: { elicitation: {} },
      });
      expect(payload.elicitationResult).toEqual({
        action: "accept",
        content: { environment: "prod" },
      });
    } finally {
      await client.close();
    }
  });

  it("表单内容在发送前二次校验，并拒绝疑似凭证字段", async () => {
    const ui = new McpElicitationUiHandler();
    const controller = new AbortController();
    const pending = ui.request(
      "demo",
      {
        message: "Choose",
        requestedSchema: {
          type: "object",
          properties: {
            environment: { type: "string", enum: ["dev", "prod"] },
            retries: { type: "integer", minimum: 1, maximum: 3 },
          },
          required: ["environment", "retries"],
        },
      },
      controller.signal,
    );
    const request = ui.getPendingRequests()[0]!;
    expect(() => ui.submit(request.requestId, { environment: "prod", retries: 4 })).toThrow("过大");
    expect(ui.submit(request.requestId, { environment: "prod", retries: "2" })).toBe(true);
    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { environment: "prod", retries: 2 },
    });

    expect(() =>
      ui.request(
        "demo",
        {
          message: "Secret",
          requestedSchema: {
            type: "object",
            properties: { api_key: { type: "string" } },
          },
        },
        controller.signal,
      ),
    ).toThrow("疑似凭证");
  });

  it("Streamable HTTP 在同一 SSE 中分流 server request，并用 session/header POST 回传", async () => {
    const protocolPosts: Array<{ body: unknown; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: number | string;
        method?: string;
        result?: unknown;
      };
      const headers = new Headers(init?.headers);
      protocolPosts.push({ body, headers });
      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: MCP_ELICITATION_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "http", version: "1" },
            },
          },
          { headers: { "Mcp-Session-Id": "session-123" } },
        );
      }
      if (body.method === "notifications/initialized" || body.result !== undefined) {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/call") {
        const events = [
          {
            jsonrpc: "2.0",
            id: "server-request",
            method: "elicitation/create",
            params: {
              message: "Choose",
              requestedSchema: {
                type: "object",
                properties: { environment: { type: "string", enum: ["dev", "prod"] } },
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "done" }], isError: false },
          },
        ]
          .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(events, { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`unexpected request ${JSON.stringify(body)}`);
    });

    const client = new HttpMcpClient(
      { name: "http", transport: "http", url: "https://mcp.example.test/rpc" },
      {
        elicitationHandler: async () => ({ action: "decline" }),
      },
    );
    try {
      await client.connect();
      await expect(client.callTool("ask", {})).resolves.toMatchObject({ isError: false });
      await vi.waitFor(() => {
        expect(
          protocolPosts.some(
            (post) =>
              (post.body as { id?: unknown; result?: unknown }).id === "server-request" &&
              (post.body as { result?: unknown }).result !== undefined,
          ),
        ).toBe(true);
      });
      const toolPost = protocolPosts.find(
        (post) => (post.body as { method?: string }).method === "tools/call",
      )!;
      expect(toolPost.headers.get("mcp-protocol-version")).toBe(MCP_ELICITATION_PROTOCOL_VERSION);
      expect(toolPost.headers.get("mcp-session-id")).toBe("session-123");
    } finally {
      await client.close();
    }
  });
});
