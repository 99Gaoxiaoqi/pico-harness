import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { createProvider } from "../../src/provider/factory.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Message } from "../../src/schema/message.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { SearchToolsTool } from "../../src/tools/search-tools.js";
import { ToolAccesses } from "../../src/tools/tool-access.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
const FIXTURE_TOOL = "maka_fixture_read";

realModelTest(
  "真实默认模型先发现 deferred 工具，再用 exec 并行读取并仅回传聚合结果",
  { timeout: 180_000 },
  async (context) => {
    const { createCodeModeTool } = await import("../../src/tools/code-mode-tool.js");
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-maka-tools-real-llm-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workDir, { recursive: true });
    const runtimePort = createEngineRuntimePort();
    const session = new Session(`maka-tools-${randomUUID()}`, workDir, {
      persistence: true,
      picoHome,
      runtimePort,
    });
    context.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();

    // Raw detail must survive in the internal ledger, but never reach model messages.
    const rawCanary = `NESTED_RAW_${randomUUID()}`;
    let inFlight = 0;
    let peakInFlight = 0;
    const physicalCalls: string[] = [];
    const fixture: BaseTool & { nesting: "nestable" } = {
      nesting: "nestable",
      readOnly: true,
      fileSideEffects: NO_FILE_SIDE_EFFECTS,
      name: () => FIXTURE_TOOL,
      definition: () => ({
        name: FIXTURE_TOOL,
        description:
          "Read one immutable fixture record, key alpha or beta. Returns JSON string {value:number,raw:string}. This tool is nestable through exec; raw is internal detail and should be omitted from aggregates.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string", enum: ["alpha", "beta"] } },
          required: ["key"],
          additionalProperties: false,
        },
      }),
      accesses: () => ToolAccesses.none(),
      async execute(args, executionContext) {
        const { key } = JSON.parse(args) as { key: string };
        assert.ok(key === "alpha" || key === "beta");
        physicalCalls.push(key);
        peakInFlight = Math.max(peakInFlight, ++inFlight);
        try {
          await delay(40, undefined, { signal: executionContext?.signal });
          return JSON.stringify({ value: key === "alpha" ? 17 : 25, raw: rawCanary });
        } finally {
          inFlight--;
        }
      },
    };
    const registry = new ToolRegistry();
    const disclosure = new ToolDisclosure();
    disclosure.setBaselineTools(["exec"]);
    registry.register(fixture);
    registry.register(new SearchToolsTool(() => registry.getAvailableTools(), disclosure));
    registry.register(createCodeModeTool({ registry, getRuntimeRun: currentRuntimeRun }));

    const actualProvider = createProvider(model.provider, model.config);
    const requests: Array<{ messages: Message[]; tools: string[] }> = [];
    const responses: Message[] = [];
    // Transparent recorder: every response and tool decision comes from the configured real model.
    const provider: LLMProvider = {
      modelName: actualProvider.modelName,
      requestCapabilities: actualProvider.requestCapabilities,
      async generate(messages, tools, options) {
        requests.push({
          messages: structuredClone(messages),
          tools: tools.map((tool) => tool.name),
        });
        const response = await actualProvider.generate(messages, tools, {
          ...options,
          timeoutMs: 60_000,
        });
        responses.push(structuredClone(response));
        return response;
      },
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      toolDisclosure: disclosure,
      reporter: new SilentReporter(),
      maxTurns: 5,
      systemPrompt:
        "Follow the user's tool workflow exactly. Deferred tools become callable only on the provider step after discovery. Use exec for the requested parallel reads; only return the selected aggregate, never the raw field. After a successful exec, give the numerical result and stop.",
    });
    const code = `const rows = await Promise.all([tools.${FIXTURE_TOOL}({key:"alpha"}), tools.${FIXTURE_TOOL}({key:"beta"})]); return {sum: rows.map(JSON.parse).reduce((total, row) => total + row.value, 0)};`;
    await session.commitMessages({
      role: "user",
      content: [
        `First call search_tools with {"query":"select:${FIXTURE_TOOL}"}. Do not call exec in that same response.`,
        "When discovery succeeds, call exec exactly once with this code:",
        code,
        "Do not invoke the fixture directly. Read alpha and beta concurrently as above, then answer with the returned sum. Do not repeat successful calls.",
      ].join("\n"),
    });
    await engine.run(session, undefined, undefined, context.signal);

    assert.ok(requests.length >= 3, "discovery、exec、final answer 必须跨 Step");
    assert.equal(requests[0]!.tools.includes(FIXTURE_TOOL), false);
    assert.ok(requests[0]!.tools.includes("search_tools"));
    assert.ok(requests[0]!.tools.includes("exec"));
    const discoveryIndex = responses.findIndex((response) =>
      response.toolCalls?.some((call) => call.name === "search_tools"),
    );
    const execIndex = responses.findIndex((response) =>
      response.toolCalls?.some((call) => call.name === "exec"),
    );
    assert.equal(discoveryIndex, 0, "真实模型必须先执行发现");
    assert.ok(execIndex > discoveryIndex, "exec 只能在发现后的 Step 执行");
    assert.ok(requests[execIndex]!.tools.includes(FIXTURE_TOOL));
    assert.deepEqual(physicalCalls.slice().sort(), ["alpha", "beta"]);
    assert.equal(peakInFlight, 2, "两次读取必须真实重叠执行");
    const execCall = responses[execIndex]!.toolCalls!.find((call) => call.name === "exec")!;
    const execObservation = requests
      .flatMap((request) => request.messages)
      .find((message) => message.toolCallId === execCall.id);
    assert.ok(execObservation, "聚合结果必须进入后续真实模型请求");
    const aggregate = JSON.parse(execObservation.content) as {
      ok: boolean;
      value: { sum: number };
    };
    assert.equal(aggregate.ok, true);
    assert.deepEqual(aggregate.value, { sum: 42 });
    assert.equal(JSON.stringify(requests).includes(rawCanary), false);
    assert.ok(responses.at(-1)?.content.includes("42"), "真实模型答案应来自聚合结果");

    const events = await session.runtimeEventStore!.readSession(session.id);
    const nestedResults = events.filter(
      (event) =>
        event.kind === "tool.result.recorded" &&
        "origin" in event.data &&
        event.data.origin === "code_mode",
    );
    assert.equal(nestedResults.length, 2, "两个 nested 完成事实必须持久化");
    for (const event of nestedResults) {
      assert.equal(event.visibility, "internal");
      assert.equal(event.refs?.parentToolCallId, execCall.id);
      assert.ok(JSON.stringify(event).includes(rawCanary), "原始结果保留在内部事实");
    }
    assert.equal(JSON.stringify(session.getModelContext()).includes(rawCanary), false);

    const nextTurnStart = requests.length;
    await session.commitMessages({
      role: "user",
      content: "New task: answer READY only. Do not call any tools.",
    });
    await engine.run(session, undefined, undefined, context.signal);
    assert.ok(requests.length > nextTurnStart);
    assert.equal(
      requests[nextTurnStart]!.tools.includes(FIXTURE_TOOL),
      false,
      "新 Turn 首 Step 不继承搜索激活",
    );
    assert.deepEqual(physicalCalls.slice().sort(), ["alpha", "beta"]);
  },
);
