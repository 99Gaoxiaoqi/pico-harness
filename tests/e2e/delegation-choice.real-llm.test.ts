import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { createProvider } from "../../src/provider/factory.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";
import { NO_FILE_SIDE_EFFECTS } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { DelegateTaskTool } from "../../src/tools/subagent.js";
import { ToolAccesses } from "../../src/tools/tool-access.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "真实模型遵守否定子代理请求并可直接调用普通工具",
  { timeout: 180_000 },
  async (context) => {
    const userInput =
      "只用 calculate_sum 工具计算 19 + 23。不得调用 shell、网络、子代理。根据工具结果回答最终数值。";
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-delegation-choice-real-llm-"));
    const session = new Session("delegation-choice", root, { persistence: false });
    context.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    const actualProvider = createProvider(model.provider, model.config);
    const requests: Array<{ messages: Message[]; tools: string[] }> = [];
    const provider: LLMProvider = {
      modelName: actualProvider.modelName,
      requestCapabilities: actualProvider.requestCapabilities,
      async generate(messages, tools, options) {
        requests.push({
          messages: structuredClone(messages),
          tools: tools.map((tool) => tool.name),
        });
        return actualProvider.generate(messages, tools, { ...options, timeoutMs: 60_000 });
      },
    };
    const registry = new ToolRegistry();
    const calculations: Array<{ a: number; b: number }> = [];
    registry.register({
      name: () => "calculate_sum",
      readOnly: true,
      fileSideEffects: NO_FILE_SIDE_EFFECTS,
      accesses: () => ToolAccesses.none(),
      definition: () => ({
        name: "calculate_sum",
        description: "Calculate the sum of two numbers.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      }),
      async execute(args) {
        const { a, b } = JSON.parse(args) as { a: number; b: number };
        calculations.push({ a, b });
        return String(a + b);
      },
    });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: root,
      systemPrompt:
        "Follow the user's request and return the arithmetic result. Stop after obtaining the answer.",
      maxTurns: 4,
    });
    registry.register(
      new DelegateTaskTool(engine, () => new ToolRegistry(), undefined, {
        allowAsyncCompletion: false,
        maxTurns: 2,
      }),
    );
    await session.commitMessages({ role: "user", content: userInput });
    const output = await engine.run(session, undefined, undefined, context.signal);

    assert.deepEqual(requests[0]!.tools.slice().sort(), ["calculate_sum", "delegate_task"]);
    assert.ok(
      requests[0]!.messages.some(
        (message) => message.role === "user" && message.content === userInput,
      ),
    );
    assert.equal(
      requests.some(({ messages }) =>
        messages.some(
          (message) =>
            message.providerData?.["picoKind"] === "required_first_delegation" ||
            message.content.includes("HIDDEN FIRST-TURN DELEGATION POLICY"),
        ),
      ),
      false,
    );
    assert.deepEqual(calculations, [{ a: 19, b: 23 }]);
    assert.equal(
      output.some((message) => message.toolCalls?.some((call) => call.name === "delegate_task")),
      false,
    );
    assert.match(
      output.filter((message) => message.role === "assistant").at(-1)?.content ?? "",
      /42/,
    );
  },
);
