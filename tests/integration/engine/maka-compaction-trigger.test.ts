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

test("Maka 584652137：成功工具步骤不重置一次 send 的溢出恢复机会", async () => {
  const session = await seed();
  const registry = new ToolRegistry();
  registry.register({
    name: () => "read_marker",
    readOnly: true,
    definition: () => ({
      name: "read_marker",
      description: "read marker",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "TOKEN-42",
  });
  let requests = 0;
  let summaries = 0;
  const provider: LLMProvider = {
    async generate() {
      requests++;
      if (requests === 1 || requests === 3) throw new ContextOverflowError("step overflow");
      if (requests === 2)
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "read-1", name: "read_marker", arguments: "{}" }],
        };
      return { role: "assistant", content: "TOKEN-42" };
    },
  };
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: process.cwd(),
    contextBudget: budget,
    fullCompactor: new FullCompactor({
      provider: {
        async generate() {
          summaries++;
          return { role: "assistant", content: validSummary };
        },
      },
    }),
    maxTurns: 3,
  });
  await assert.rejects(engine.run(session), ContextOverflowError);
  assert.equal(requests, 3);
  assert.equal(summaries, 1);
});

test("当前用户图片和后续工具交换保持原文，不能被纯文本摘要折叠", async () => {
  const session = new Session(randomUUID(), process.cwd(), { persistence: false });
  const image: Message["images"] = [
    { type: "image_base64", mimeType: "image/png", data: "aW1hZ2U=" },
  ];
  for (const message of [
    { role: "user", content: "Old task." },
    { role: "assistant", content: "Old answer." },
    { role: "user", content: "Inspect this image.", images: image },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "image-read", name: "read_marker", arguments: "{}" }],
    },
    { role: "user", content: "source", toolCallId: "image-read" },
    {
      role: "assistant",
      content: "Examining.",
      providerData: { picoContextUsageAnchor: { route: "route-a", input: 7000, output: 1000 } },
    },
  ] as Message[])
    await session.commitMessages(message);
  const engine = new AgentEngine({
    provider: {
      async generate(messages) {
        assert.deepEqual(
          messages.find((message) => message.content === "Inspect this image.")?.images,
          image,
        );
        assert.ok(messages.some((message) => message.toolCallId === "image-read"));
        return { role: "assistant", content: "image retained" };
      },
    },
    registry: new ToolRegistry(),
    workDir: process.cwd(),
    contextRouteIdentity: "route-a",
    contextBudget: { ...budget, declaredContextWindowTokens: 10_000 },
    fullCompactor: new FullCompactor({
      provider: {
        async generate() {
          return { role: "assistant", content: validSummary };
        },
      },
    }),
    maxTurns: 1,
  });
  await engine.run(session);
  assert.ok(
    session.getHistory().some((message) => message.content.includes("<pico_compaction_summary>")),
  );
});

// Decisions below are pinned to Maka 584652137 ai-sdk-turn / ai-sdk-compaction.
test("Maka send guard rejects recovery after observable output or a proactive attempt", async () => {
  for (const scenario of [
    "text",
    "reasoning",
    "proactive-failed",
    "proactive-succeeded",
  ] as const) {
    const session = await seed();
    const before = structuredClone(session.getHistory());
    let summaries = 0;
    let requests = 0;
    const overflow = new ContextOverflowError(`overflow:${scenario}`);
    const proactive = scenario.startsWith("proactive");
    const provider: LLMProvider = {
      async generate() {
        requests++;
        throw overflow;
      },
      ...(scenario === "text" || scenario === "reasoning"
        ? ({
            async generateStream(_messages, _tools, onDelta, options) {
              requests++;
              if (scenario === "text") onDelta("already visible");
              else options?.onReasoningDelta?.("already visible reasoning");
              throw overflow;
            },
          } satisfies Partial<LLMProvider>)
        : {}),
    };
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      contextRouteIdentity: "route-a",
      contextBudget: { ...budget, ...(proactive ? { declaredContextWindowTokens: 10_000 } : {}) },
      fullCompactor: new FullCompactor({
        maxAttempts: 1,
        provider: {
          async generate() {
            summaries++;
            return {
              role: "assistant",
              content: scenario === "proactive-failed" ? "" : validSummary,
            };
          },
        },
      }),
      maxTurns: 3,
    });
    await assert.rejects(engine.run(session), (error) => error === overflow);
    assert.equal(requests, 1, scenario);
    assert.equal(summaries, proactive ? 1 : 0, scenario);
    if (scenario !== "proactive-succeeded") assert.deepEqual(session.getHistory(), before);
  }
});

test("Maka historical image recovery preserves current user media and spends the send recovery latch", async () => {
  const session = new Session(randomUUID(), process.cwd(), { persistence: false });
  const image: NonNullable<Message["images"]> = [
    { type: "image_base64", mimeType: "image/png", data: "aW1hZ2U=" },
  ];
  await session.commitMessages(
    { role: "user", content: "old task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "old-image", name: "image_tool", arguments: "{}" }],
    },
    { role: "user", toolCallId: "old-image", content: "old image", images: image },
    { role: "assistant", content: "old complete" },
    { role: "user", content: "current image", images: image },
  );
  let requests = 0;
  let summaries = 0;
  const engine = new AgentEngine({
    registry: new ToolRegistry(),
    workDir: process.cwd(),
    maxTurns: 3,
    fullCompactor: new FullCompactor({
      provider: {
        async generate() {
          summaries++;
          return { role: "assistant", content: validSummary };
        },
      },
    }),
    provider: {
      async generate(messages) {
        requests++;
        assert.deepEqual(
          messages.find((message) => message.content === "current image")?.images,
          image,
        );
        const historical = messages.find((message) => message.toolCallId === "old-image")!;
        if (requests === 1) assert.deepEqual(historical.images, image);
        else {
          assert.equal(historical.images, undefined);
          assert.match(historical.content, /Historical tool image omitted/);
        }
        throw new ContextOverflowError("image overflow");
      },
    },
  });
  await assert.rejects(engine.run(session), ContextOverflowError);
  assert.equal(requests, 2);
  assert.equal(summaries, 0);
  assert.deepEqual(
    session.getHistory().find((message) => message.toolCallId === "old-image")?.images,
    image,
  );
});

test("Maka overflow before any completed step may retry the final available step", async () => {
  const session = await seed();
  let requests = 0;
  const engine = new AgentEngine({
    registry: new ToolRegistry(),
    workDir: process.cwd(),
    maxTurns: 1,
    fullCompactor: new FullCompactor({
      provider: {
        async generate() {
          return { role: "assistant", content: validSummary };
        },
      },
    }),
    provider: {
      async generate() {
        if (++requests === 1) throw new ContextOverflowError("unaccepted step");
        return { role: "assistant", content: "last allowed step completed" };
      },
    },
  });
  await engine.run(session);
  assert.equal(requests, 2);
});
