import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
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

function cacheMarkedMessageIndexes(body: AnthropicWireBody): number[] {
  return body.messages.flatMap((message, index) =>
    message.content.some((block) => block.cache_control?.type === "ephemeral") ? [index] : [],
  );
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
  disclosure.discloseTools(["zeta_extension", "alpha_extension"]);
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

test("multi-turn engine requests reheat the deep history prefix without persisting turn tails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-anthropic-cache-multiturn-"));
  const requestBodies: AnthropicWireBody[] = [];
  const server = createServer(async (request, response) => {
    requestBodies.push(await readJsonBody(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestBodies.length === 1) {
      response.end(
        anthropicSse(
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "r1-tool-call",
              name: "read_marker",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_stop" },
        ),
      );
      return;
    }
    response.end(
      anthropicSse(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: requestBodies.length === 2 ? "r1-done" : "r2-done",
          },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const session = new Session("anthropic-cache-multiturn", root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  try {
    const address = server.address() as AddressInfo;
    const provider = new ClaudeProvider({
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "claude-test",
    });
    const registry = registerTools(["read_marker"]);
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: root,
      promptLayersFactory: async ({ currentUserPrompt }) => ({
        systemPrompt: "stable-multiturn-system",
        turnTail: currentUserPrompt === "r1-user" ? "r1-ephemeral-tail" : "r2-ephemeral-tail",
      }),
    });

    await session.commitMessages({ role: "user", content: "r1-user" });
    await engine.run(session);
    await session.commitMessages({ role: "user", content: "r2-user" });
    await engine.run(session);

    assert.equal(requestBodies.length, 3);
    const [r1Initial, r1ToolLoop, r2Initial] = requestBodies as [
      AnthropicWireBody,
      AnthropicWireBody,
      AnthropicWireBody,
    ];

    assert.deepEqual(r1ToolLoop.system, r1Initial.system);
    assert.deepEqual(r2Initial.system, r1Initial.system);
    assert.deepEqual(r1ToolLoop.tools, r1Initial.tools);
    assert.deepEqual(r2Initial.tools, r1Initial.tools);
    assert.equal(r1Initial.system?.at(-1)?.cache_control?.type, "ephemeral");
    assert.equal(r1Initial.tools?.at(-1)?.cache_control?.type, "ephemeral");

    assert.deepEqual(cacheMarkedMessageIndexes(r1Initial), []);
    assert.deepEqual(cacheMarkedMessageIndexes(r1ToolLoop), [1]);
    assert.deepEqual(cacheMarkedMessageIndexes(r2Initial), [3]);
    assert.equal(r1ToolLoop.messages[1]?.role, "assistant");
    assert.equal(r2Initial.messages[3]?.role, "assistant");
    assert.equal(
      r2Initial.messages[1]?.content.some((block) => block.cache_control?.type === "ephemeral"),
      false,
      "R2 must rebuild one deeper history breakpoint instead of retaining the old one",
    );
    assert.equal(
      r2Initial.messages.at(-1)?.content.some((block) => block.cache_control?.type === "ephemeral"),
      false,
      "the latest external user message must stay outside the cache boundary",
    );

    const r1InitialText = r1Initial.messages[0]?.content.at(-1)?.text ?? "";
    const r1ToolLoopText = r1ToolLoop.messages[0]?.content.at(-1)?.text ?? "";
    const r2OldUserText = r2Initial.messages[0]?.content.at(-1)?.text ?? "";
    const r2CurrentUserText = r2Initial.messages.at(-1)?.content.at(-1)?.text ?? "";
    assert.match(r1InitialText, /^r1-user\n\n<current-turn-context>/u);
    assert.equal(r1ToolLoopText, r1InitialText, "one run must reuse its frozen turn tail");
    assert.equal(r2OldUserText, "r1-user", "R1 tail must not survive into R2 history");
    assert.match(r2CurrentUserText, /^r2-user\n\n<current-turn-context>/u);
    assert.match(r2CurrentUserText, /r2-ephemeral-tail/u);
    assert.doesNotMatch(JSON.stringify(r2Initial), /r1-ephemeral-tail/u);

    const persistedHistory = session.getModelContext();
    assert.doesNotMatch(
      JSON.stringify(persistedHistory),
      /current-turn-context|r1-ephemeral-tail|r2-ephemeral-tail/u,
    );
    assert.deepEqual(
      persistedHistory
        .filter((message) => message.role === "user" && message.toolCallId === undefined)
        .map((message) => message.content),
      ["r1-user", "r2-user"],
    );
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
});

function anthropicSse(...payloads: ReadonlyArray<Record<string, unknown>>): string {
  return `${payloads.map((payload) => `data: ${JSON.stringify(payload)}`).join("\n\n")}\n\n`;
}
