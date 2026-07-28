import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { createRawProvider } from "../../src/provider/factory.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

interface CacheMarked {
  cache_control?: { type: string };
}

interface AnthropicWireBody {
  system?: Array<CacheMarked & { type: string; text: string }>;
  tools?: Array<CacheMarked & { name: string; input_schema: unknown }>;
  tool_choice?: { type: string };
  messages: Array<{
    role: string;
    content: Array<CacheMarked & { type: string; text?: string }>;
  }>;
}

async function readJsonBody(request: IncomingMessage): Promise<AnthropicWireBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicWireBody;
}

function registerMarkerTool(registry: ToolRegistry, onExecute: () => void): void {
  registry.register({
    name: () => "read_marker",
    definition: () => ({
      name: "read_marker",
      description: "returns a deterministic marker",
      inputSchema: { type: "object", properties: {}, required: [] },
    }),
    readOnly: true,
    async execute() {
      onExecute();
      return "marker";
    },
  });
}

test("Claude grace keeps action tools/system cache prefix and disables tool choice", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grace-tool-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const requestBodies: AnthropicWireBody[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requestBodies.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content:
          requestBodies.length === 1
            ? [{ type: "tool_use", id: "action-call", name: "read_marker", input: {} }]
            : [
                { type: "text", text: "grace done" },
                { type: "tool_use", id: "forbidden-grace-call", name: "read_marker", input: {} },
              ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address() as AddressInfo;
  const config = {
    baseURL: `http://127.0.0.1:${address.port}`,
    apiKey: "test-key",
    model: "claude-test",
    capabilities: resolveModelRouteCapabilities(
      "claude",
      "claude-test",
      { cache: true, toolCall: true },
      { baseURL: `http://127.0.0.1:${address.port}` },
    ),
  };
  const claude = new CostTracker(createRawProvider("claude", config), "claude-test");
  assert.equal(
    claude.requestCapabilities?.toolChoiceNoneWithTools,
    true,
    "Claude request capability must survive redaction, preflight, and tracking decorators",
  );
  // 本回归只需要非流式响应夹具；能力透传已在上方针对真实装饰链断言。
  const provider: LLMProvider = {
    modelName: claude.modelName,
    requestCapabilities: claude.requestCapabilities,
    generate: claude.generate.bind(claude),
  };
  const registry = new ToolRegistry();
  let executed = 0;
  registerMarkerTool(registry, () => {
    executed++;
  });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: root,
    maxTurns: 1,
    promptLayersFactory: async () => ({
      systemPrompt: "stable-system",
      turnTail: "frozen-turn-tail",
    }),
  });
  const session = new Session("grace-tool-cache", root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "use the marker" });

  await engine.run(session);

  assert.equal(requestBodies.length, 2);
  const action = requestBodies[0]!;
  const grace = requestBodies[1]!;
  assert.equal(action.tool_choice, undefined);
  assert.deepEqual(grace.tool_choice, { type: "none" });
  assert.deepEqual(grace.tools, action.tools);
  assert.deepEqual(grace.system, action.system);
  assert.equal(action.tools?.at(-1)?.cache_control?.type, "ephemeral");
  assert.equal(grace.tools?.at(-1)?.cache_control?.type, "ephemeral");
  assert.equal(action.system?.at(-1)?.cache_control?.type, "ephemeral");
  assert.equal(grace.system?.at(-1)?.cache_control?.type, "ephemeral");
  assert.equal(executed, 1, "grace response tool calls must never reach the registry");
});

test("grace keeps the empty-tools fallback for providers without no-tool capability", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grace-tool-fallback-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const requests: Array<{
    messages: Message[];
    tools: ToolDefinition[];
    toolChoice: LLMProviderRequestOptions["toolChoice"];
  }> = [];
  const provider: LLMProvider = {
    async generate(messages, tools, options) {
      requests.push({
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        toolChoice: options?.toolChoice,
      });
      return requests.length === 1
        ? {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "action-call", name: "read_marker", arguments: "{}" }],
          }
        : {
            role: "assistant",
            content: "grace done",
            toolCalls: [{ id: "forbidden-grace-call", name: "read_marker", arguments: "{}" }],
          };
    },
  };
  const registry = new ToolRegistry();
  let executed = 0;
  registerMarkerTool(registry, () => {
    executed++;
  });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: root,
    maxTurns: 1,
  });
  const session = new Session("grace-tool-fallback", root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "use the marker" });

  await engine.run(session);

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[0]!.tools.map((tool) => tool.name),
    ["read_marker"],
  );
  assert.deepEqual(requests[1]!.tools, []);
  assert.equal(requests[1]!.toolChoice, undefined);
  assert.equal(executed, 1, "fallback grace response tool calls must never reach the registry");
});
