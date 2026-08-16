import assert from "node:assert/strict";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import type { LLMProvider } from "../../src/provider/interface.js";

// D10④ 内容级熔断：子代理 loop 的"完成"是模型自报（不再调工具 + 可用总结），
// 流程状态区分不了"真做完"与"做完样子但任务失败"。总结开篇的明确失败宣言
// 必须把自报 completed 降级为 error——宿主按失败结算（graph.work.failed /
// plan step 不落 completed），失败不再被自报完成掩盖。
function fakeProvider(finalContent: string): LLMProvider {
  return {
    async generate() {
      return { role: "assistant", content: finalContent };
    },
  };
}

function makeEngine(finalContent: string): AgentEngine {
  return new AgentEngine({
    provider: fakeProvider(finalContent),
    registry: new ToolRegistry(),
    workDir: process.cwd(),
    systemPrompt: "测试助手",
  });
}

test("子代理总结开篇失败宣言：自报 completed 降级 error", async () => {
  const failureSummary = [
    "无法完成：目标模块不存在于当前仓库，且无法从上游恢复。",
    "已确认的事实：searched src/target — 目录不存在（glob 0 命中）。",
    "未验证风险：无。",
    "下一步：请确认模块路径后重新派发。",
  ].join("\n");
  const result = await makeEngine(failureSummary).runSub("实现 src/target 模块", new ToolRegistry());
  assert.equal(result.status, "error");
  assert.ok(result.error?.includes("内容级熔断"), "error 字段携带熔断原因");
  assert.ok(result.summary.includes("无法完成"), "总结原文保留，供宿主读取失败细节");
});

test("总结标签后置的失败宣言同样命中（剥『结论：』引导标签）", async () => {
  const labeled = `结论：任务失败——权限不足，无法写入目标目录。\n证据：EACCES ×3。`;
  const result = await makeEngine(labeled).runSub("写入配置", new ToolRegistry());
  assert.equal(result.status, "error");
});

test("正文中段的失败字样不误伤：正常总结保持 completed", async () => {
  const normalSummary = [
    "任务完成：定位并修复了失败的测试。",
    "关键证据：tests/foo.test.ts:42 断言修正。",
    "未验证风险：无。",
  ].join("\n");
  const result = await makeEngine(normalSummary).runSub("修复测试", new ToolRegistry());
  assert.equal(result.status, "completed");
  assert.equal(result.error, undefined);
});
