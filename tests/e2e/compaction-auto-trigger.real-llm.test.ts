/** Real-provider validation of declared-window/usage trigger and task continuation. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { Session } from "@pico/pico-host/session";
import { createProvider } from "@pico/pico-host/provider/factory";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";
import type { Message } from "@pico/core";

const realTest = process.env.RUN_COMPACTION_E2E === "1" ? test : test.skip;
realTest(
  "真实 usage 越过声明窗口后自动压缩并继续任务，保留精确标记",
  { timeout: 600_000 },
  async () => {
    const configured = await configuredUserDefaultRealModel();
    const provider = createProvider(configured.provider, {
      ...configured.config,
      sessionId: `compaction-e2e-${randomUUID()}`,
    });
    const marker = `PICO_MARKER_${randomUUID().replaceAll("-", "")}`;
    const history: Message[] = [
      {
        role: "user",
        content: `任务约束：最终只回复精确标记 ${marker}。先确认收到。背景资料：${"项目研究需要保留路径、错误和已验证结果。".repeat(120)}`,
      },
    ];
    // Obtain a real accepted-request anchor, rather than treating a local estimate as usage.
    const receipt = await provider.generate(history, []);
    assert.ok(receipt.usage && receipt.usage.promptTokens > 0, "provider must report real usage");
    const { promptTokens: input, completionTokens: output } = receipt.usage;
    const route = "real-compaction-route";
    receipt.providerData = {
      ...receipt.providerData,
      picoContextUsageAnchor: { route, input, output },
    };
    const session = new Session(`compaction-${randomUUID()}`, process.cwd(), {
      persistence: false,
    });
    for (const message of [
      ...history,
      receipt,
      { role: "user" as const, content: "继续完成刚才的任务，只输出要求的最终结果。" },
    ])
      await session.commitMessages(message);
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      systemPrompt: "完成用户任务；摘要是工作记忆，保留用户约束并继续尚未完成的任务。",
      contextRouteIdentity: route,
      contextBudget: {
        contextWindowTokens: 128_000,
        declaredContextWindowTokens: input + output,
        reservedOutputTokens: 8_000,
        safetyMarginTokens: 1024,
        inputBudgetTokens: 118_976,
      },
      fullCompactor: new FullCompactor({ provider, maxAttempts: 1 }),
      maxTurns: 2,
    });
    const response = await engine.run(session);
    const summary = session
      .getHistory()
      .find((message) => message.content.includes("<pico_compaction_summary>"));
    assert.ok(summary, "must actually compact");
    assert.ok(summary.content.includes(marker), "summary preserves exact identifier");
    assert.equal(
      response.at(-1)?.content.trim(),
      marker,
      "continued task must return the correct exact result",
    );
  },
);
