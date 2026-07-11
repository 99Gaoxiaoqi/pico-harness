import { describe, expect, it } from "vitest";
import {
  createFirstTurnDelegationPolicy,
  detectExplicitDelegationIntent,
} from "../src/input/delegation-intent-policy.js";
import { processUserInput } from "../src/input/process-user-input.js";

describe("explicit delegation intent input boundary", () => {
  it.each([
    ["启动多个子代理阅读项目", "multiple"],
    ["调用两个子 Agent 并行分析项目", "multiple"],
    ["请让一个子代理检查鉴权实现", "single"],
    ["用多个子代理阅读项目并总结", "multiple"],
    ["请先解释子代理如何工作，然后启动多个子代理阅读项目", "multiple"],
    ["Launch several subagents to inspect the project", "multiple"],
    ["Delegate this review to sub-agents", "unspecified"],
  ] as const)("把真实 prompt 输入 %s 转成 required 首动作策略", async (raw, count) => {
    const processed = await processUserInput(raw);
    expect(processed.type).toBe("prompt");
    if (processed.type !== "prompt") throw new Error("预期真实用户输入被解析为 prompt");

    const policy = createFirstTurnDelegationPolicy(processed.prompt);

    expect(policy).toMatchObject({
      kind: "required-first-delegation",
      intent: { kind: "explicit-delegation", requestedCount: count },
      toolName: "delegate_task",
      completionPolicy: "required",
      exclusive: true,
    });
    if (policy.kind !== "required-first-delegation") {
      throw new Error("预期显式委派输入生成首轮约束");
    }
    expect(policy.hiddenConstraint).toContain("first and only action");
    expect(policy.hiddenConstraint).toContain("Do not emit assistant prose");
    expect(policy.hiddenConstraint).toContain("discover the project structure themselves");
  });

  it.each([
    "子代理是什么？请解释它的工作原理",
    "是否应该使用子代理？",
    "Claude Code 的子代理是怎么设计的？",
    "为什么主 Agent 启动子代理后还会阅读项目？",
    "使用子代理有什么好处？",
    "请在后台启动多个子代理，不用等它们完成。",
    "How do subagents work?",
    "Launch several subagents in the background without waiting.",
    "Why does the main agent spawn subagents before reading the project?",
    "启动主 Agent 阅读项目并进行总结。",
    "Launch an agent to inspect the project.",
    "不要启动子代理，请你自己阅读项目。",
    "如果有必要，可以启动多个子代理阅读项目。",
    "Do not launch subagents; inspect the project yourself.",
    "If needed, you can launch several subagents.",
    "如果测试失败，请启动多个子代理修复。",
    "If tests fail, launch several subagents to fix them.",
    "若 CI 报错，就让多个子代理并行排查。",
    "请启动多个子代理，放到后台运行。",
    "Launch several subagents, run them in the background.",
    "启动多个子代理；不用等它们完成。",
    "Should we use subagents for this project?",
    "请你自己阅读项目并说明问题",
  ])("不把讨论或无委派要求的输入误判为执行意图: %s", (input) => {
    expect(detectExplicitDelegationIntent(input)).toBeNull();
    expect(createFirstTurnDelegationPolicy(input)).toEqual({ kind: "none" });
  });
});
