import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import type { LLMProvider } from "../../src/provider/interface.js";

// 空 run 防线：provider 返回空内容（模拟网关 200 + 0 字节 SSE 流）时，
// 主循环不得把零 assistantMessage 的回合记成成功——必须 fail-loud 抛错，
// 让 run 走既有失败可见性链路（2026-08-17 默认路由空流事故的回归测试）。
function emptyStreamProvider(): LLMProvider {
  return {
    async generate() {
      return { role: "assistant", content: "" };
    },
  };
}

function makeEngine(provider: LLMProvider): AgentEngine {
  return new AgentEngine({
    provider,
    registry: new ToolRegistry(),
    workDir: process.cwd(),
    systemPrompt: "测试助手",
  });
}

test("空模型输出 fail-loud：零 assistantMessage 的回合抛错不静默成功", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-empty-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = new Session("empty-run", root, { persistence: false, picoHome: root });
  t.after(() => session.close());
  await session.commitMessages({ role: "user", content: "你好" });

  await assert.rejects(
    () => makeEngine(emptyStreamProvider()).run(session),
    /零输出|空流/,
    "空流回合必须抛出可诊断错误而不是静默成功",
  );
});

test("正常回复不受影响：非空内容回合照常返回", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-normal-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider: LLMProvider = {
    async generate() {
      return { role: "assistant", content: "收到" };
    },
  };
  const session = new Session("normal-run", root, { persistence: false, picoHome: root });
  t.after(() => session.close());
  await session.commitMessages({ role: "user", content: "你好" });

  const messages = await makeEngine(provider).run(session);
  assert.ok(
    messages.some((message) => message.role === "assistant" && message.content === "收到"),
    "正常回合应照常返回 assistant 消息",
  );
});
