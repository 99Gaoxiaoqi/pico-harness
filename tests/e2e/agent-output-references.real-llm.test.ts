import type { Message, ToolDefinition } from "../../src/schema/message.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createProvider } from "../../src/provider/factory.js";
import {
  createAgentOutputTool,
  type CommitAgentOutputInput,
} from "../../src/tools/agent-output-tool.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "Graph operator submits a file-read result without inventing evidence URIs",
  { timeout: 90_000 },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const provider = createProvider(model.provider, model.config);
    const commits: CommitAgentOutputInput[] = [];
    const tool = createAgentOutputTool({
      getActivationContext: () => ({
        kind: "graph_operator_activation",
        graphId: "graph-test",
        operatorId: "reader",
        operatorGeneration: 1,
        activationId: "claim-test",
        sessionId: "child-test",
        turnId: "turn-test",
        runId: "run-test",
      }),
      port: {
        commitAgentOutput: async (input) => {
          commits.push(input);
          return { eventId: "output-test", replayed: false };
        },
      },
    });
    const messages: Message[] = [
      { role: "system", content: "你是 Graph 子任务。完成后调用 agent_output 提交正式结果。" },
      {
        role: "user",
        content: "先调用 read_file 读取 branch-a.txt，然后提交文件内容及来源作为子任务结果。",
      },
    ];
    const definitions: ToolDefinition[] = [
      tool.definition(),
      {
        name: "read_file",
        description: "读取指定文件的内容。",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ];
    const signal = AbortSignal.timeout(75_000);
    // Retain the actual provider's replay metadata, including any required reasoning fields.
    const read = await provider.generate(messages, definitions, { signal });
    assert.equal(read.toolCalls?.length, 1);
    const readCall = read.toolCalls![0]!;
    assert.equal(readCall.name, "read_file");
    assert.equal(JSON.parse(readCall.arguments).path, "branch-a.txt");
    messages.push(read, {
      role: "user",
      toolCallId: readCall.id,
      content: "1\tCUA_BRANCH_A_17\n共 1 行,行尾: LF",
    });
    const response = await provider.generate(messages, definitions, { signal });
    assert.equal(
      response.toolCalls?.length,
      1,
      "the operator should submit directly after the successful read",
    );
    const call = response.toolCalls![0]!;
    assert.equal(call.name, "agent_output");
    await tool.execute(call.arguments, { toolCallId: call.id });
    assert.equal(commits[0]?.eventPayload.status, "success");
    assert.match(commits[0]!.eventPayload.output, /CUA_BRANCH_A_17/u);
    assert.deepEqual(
      commits[0]!.eventPayload.evidenceRefs,
      [],
      "a file path must not be invented as a durable evidence URI",
    );
    assert.deepEqual(commits[0]!.eventPayload.artifactRefs, []);
  },
);
