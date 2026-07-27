import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ClaudeProvider } from "../../src/provider/claude.js";
import type { BaseTool } from "../../src/tools/registry.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

interface CacheMarked {
  cache_control?: { type: string };
}

interface AnthropicWireBody {
  system?: Array<CacheMarked & { type: string; text: string }>;
  tools?: Array<CacheMarked & { name: string }>;
  messages: Array<{
    role: string;
    content: Array<CacheMarked & { type: string; text?: string }>;
  }>;
}

function fixtureTool(name: string): BaseTool {
  return {
    name: () => name,
    definition: () => ({
      name,
      description: `${name} fixture`,
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async (args) => `${name}:${args}`,
  };
}

function registerTools(names: readonly string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) registry.register(fixtureTool(name));
  return registry;
}

async function readJsonBody(request: IncomingMessage): Promise<AnthropicWireBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicWireBody;
}

function countCacheBreakpoints(body: AnthropicWireBody): number {
  return [
    ...(body.system ?? []),
    ...(body.tools ?? []),
    ...body.messages.flatMap((message) => message.content),
  ].filter((item) => item.cache_control?.type === "ephemeral").length;
}

test("provider-visible tools stay name-sorted after registration and disclosure", async () => {
  const first = registerTools(["zeta_extension", "read_file", "alpha_extension", "bash"]);
  const second = registerTools(["bash", "alpha_extension", "read_file", "zeta_extension"]);

  const firstDefinitions = first.getAvailableTools();
  assert.deepEqual(
    firstDefinitions.map((tool) => tool.name),
    ["alpha_extension", "bash", "read_file", "zeta_extension"],
  );
  assert.deepEqual(firstDefinitions, second.getAvailableTools());

  const disclosure = new ToolDisclosure();
  assert.deepEqual(
    disclosure.pickForLLM(firstDefinitions).map((tool) => tool.name),
    ["bash", "read_file"],
  );
  disclosure.disclose(["zeta_extension", "alpha_extension"]);
  assert.deepEqual(
    disclosure.pickForLLM(firstDefinitions).map((tool) => tool.name),
    ["alpha_extension", "bash", "read_file", "zeta_extension"],
  );

  assert.deepEqual(
    await first.execute({
      id: "route-check",
      name: "zeta_extension",
      arguments: '{"value":1}',
    }),
    {
      toolCallId: "route-check",
      output: 'zeta_extension:{"value":1}',
      isError: false,
    },
  );
});

test("Claude wire request keeps three cache breakpoints and degrades safely", async () => {
  const requestBodies: AnthropicWireBody[] = [];
  const server = createServer(async (request, response) => {
    requestBodies.push(await readJsonBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const provider = new ClaudeProvider({
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "claude-test",
    });
    const registry = registerTools(["zeta_tool", "alpha_tool"]);

    await provider.generate(
      [
        { role: "system", content: "stable system" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
        { role: "user", content: "latest question" },
      ],
      registry.getAvailableTools(),
    );
    await provider.generate([{ role: "user", content: "minimal request" }], []);

    assert.equal(requestBodies.length, 2);
    const full = requestBodies[0]!;
    assert.deepEqual(
      full.tools?.map((tool) => tool.name),
      ["alpha_tool", "zeta_tool"],
    );
    assert.equal(full.system?.at(-1)?.cache_control?.type, "ephemeral");
    assert.equal(full.tools?.[0]?.cache_control, undefined);
    assert.equal(full.tools?.at(-1)?.cache_control?.type, "ephemeral");
    assert.equal(full.messages.at(-2)?.content.at(-1)?.cache_control?.type, "ephemeral");
    assert.equal(full.messages.at(-1)?.content.at(-1)?.cache_control, undefined);
    assert.equal(countCacheBreakpoints(full), 3);
    assert.ok(countCacheBreakpoints(full) <= 4);

    const minimal = requestBodies[1]!;
    assert.equal(minimal.system, undefined);
    assert.equal(minimal.tools, undefined);
    assert.equal(countCacheBreakpoints(minimal), 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
