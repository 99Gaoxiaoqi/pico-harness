import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { Session } from "@pico/pico-host/session";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import { ContextOverflowError, type LLMProvider, type Message } from "@pico/core";

const validSummary =
  "## Goal\nFinish the task.\n## Progress\n### Done\nRead the source.\n### In Progress\nChecking constraints.\n## Key Decisions\nPreserve exact paths.\n## Next Steps\nRun the test.\n## Critical Context\nsrc/keep.ts and TOKEN-42.";
const budget = {
  contextWindowTokens: 10_000,
  reservedOutputTokens: 1000,
  safetyMarginTokens: 100,
  inputBudgetTokens: 8900,
};
async function seed(route = "route-a") {
  const session = new Session(randomUUID(), process.cwd(), { persistence: false });
  await session.commitMessages({
    role: "user",
    content: "Finish TOKEN-42 without changing src/keep.ts.",
  });
  await session.commitMessages({
    role: "assistant",
    content: "Investigated source.",
    usage: { promptTokens: 7000, completionTokens: 1000 },
    providerData: { picoContextUsageAnchor: { route, input: 7000, output: 1000 } },
  });
  await session.commitMessages({ role: "user", content: "Continue." });
  return session;
}

test("声明窗口只接纳同route真实usage，压缩保留当前任务，缺少声明/锚定时不主动压缩", async () => {
  for (const scenario of ["declared", "no-window", "other-route", "no-anchor"] as const) {
    const session = await seed(scenario === "other-route" ? "route-b" : "route-a");
    if (scenario === "no-anchor") {
      await session.commitMessages({
        role: "assistant",
        content: "new route reply",
        providerData: { picoContextUsageAnchor: { route: "unknown", input: 1, output: 1 } },
      });
      await session.commitMessages({ role: "user", content: "Continue." });
    }
    let summaries = 0;
    const summarizer: LLMProvider = {
      async generate() {
        summaries++;
        return { role: "assistant", content: validSummary };
      },
    };
    const provider: LLMProvider = {
      async generate(messages) {
        assert.ok(messages.some((message) => message.content.includes("Continue.")));
        return {
          role: "assistant",
          content: "done",
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      contextRouteIdentity: "route-a",
      contextBudget: {
        ...budget,
        ...(scenario !== "no-window" ? { declaredContextWindowTokens: 10_000 } : {}),
      },
      fullCompactor: new FullCompactor({ provider: summarizer, maxAttempts: 1 }),
      maxTurns: 1,
    });
    await engine.run(session);
    assert.equal(summaries, scenario === "declared" ? 1 : 0, scenario);
    const last = session.getHistory().at(-1)!;
    assert.deepEqual(last.providerData?.picoContextUsageAnchor, {
      route: "route-a",
      input: 100,
      output: 10,
    });
  }
});

test("Provider溢出后仅重试一次；摘要失败保留完整历史且不硬重置", async () => {
  for (const failSummary of [false, true]) {
    const session = await seed();
    const before = structuredClone(session.getHistory());
    let summaries = 0;
    let requests = 0;
    const summarizer: LLMProvider = {
      async generate() {
        summaries++;
        return { role: "assistant", content: failSummary ? "" : validSummary };
      },
    };
    const overflow = new ContextOverflowError("test provider context limit");
    const provider: LLMProvider = {
      async generate() {
        requests++;
        throw overflow;
      },
    };
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      contextBudget: budget,
      fullCompactor: new FullCompactor({ provider: summarizer, maxAttempts: 1 }),
      maxTurns: 3,
    });
    await assert.rejects(engine.run(session), (error) => error === overflow);
    assert.equal(requests, failSummary ? 1 : 2);
    assert.equal(summaries, 1);
    if (failSummary) assert.deepEqual(session.getHistory(), before);
    assert.ok(
      !session.getHistory().some((message: Message) => message.content.includes("CONTEXT RESET")),
    );
  }
});
