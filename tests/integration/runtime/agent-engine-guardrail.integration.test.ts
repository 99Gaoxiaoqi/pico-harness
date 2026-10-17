import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@pico/core";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { Session } from "@pico/pico-host/session";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";

test("AgentEngine 的护栏自身拒绝不重复记账且不派发", async (t) => {
  const session = new Session("guardrail-self-rejection", process.cwd(), {
    persistence: false,
  });
  t.after(() => session.close());
  await session.commitMessages({ role: "user", content: "exercise the repeated-failure guard" });

  const attempts = [
    ...Array.from({ length: 5 }, () => ({ value: "same" })),
    ...Array.from({ length: 3 }, () => ({ value: "same" })),
    { value: "different" },
  ];
  let providerTurn = 0;
  let dispatched = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: () => "fixture_tool",
    definition: () => ({
      name: "fixture_tool",
      description: "Fails to exercise the guardrail ledger.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    }),
    readOnly: true,
    async execute() {
      dispatched++;
      throw new Error("fixture failure");
    },
  });

  const provider = {
    modelName: "test/guardrail-self-rejection",
    async generate(): Promise<Message> {
      const attempt = attempts[providerTurn];
      if (!attempt) return { role: "assistant", content: "done" };
      const id = `guardrail-call-${providerTurn++}`;
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "fixture_tool", arguments: JSON.stringify(attempt) }],
      };
    },
  };

  const engine = new AgentEngine({
    registry,
    provider,
    workDir: process.cwd(),
    guardrailOptions: {
      exactFailureWarnAt: 3,
      exactFailureBlockAt: 5,
      sameToolFailureWarnAt: 100,
      sameToolFailureBlockAt: 8,
    },
  });

  await engine.run(session);

  assert.equal(providerTurn, 9);
  assert.equal(dispatched, 6, "five initial failures and the new-argument call dispatch only");
});
