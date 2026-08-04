/**
 * 验证 prompt 缓存安全性：turnTail 每轮重建时 systemPrompt 是否保持冻结。
 *
 * 核心断言：
 * 1. 多轮调用中，provider 收到的 system 消息字节相同（缓存命中）
 * 2. turnTail 内容在 todo 操作后发生变化（状态新鲜）
 * 3. turnTail 追加在 user 消息上，不在 system 消息上
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TodoStore } from "../../src/context/todo-store.js";
import { PromptComposer } from "../../src/context/composer.js";
import { GoalManager } from "../../src/engine/goal-manager.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { TodoTool } from "../../src/tools/todo.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

test("prompt cache safety: systemPrompt frozen while turnTail rebuilds per turn", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-cache-safety-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const todoStore = new TodoStore(workDir, { picoHome });
  const goalManager = new GoalManager();

  // 预置一条 todo
  await todoStore.add("待办任务", "high");

  // 捕获每轮 provider 收到的完整消息列表
  const capturedRequests: { systemHash: string; userTailHash: string; messages: Message[] }[] = [];

  const provider: LLMProvider = {
    modelName: "test-model",
    async generate(messages) {
      const systemMsg = messages.find((m) => m.role === "system");
      const lastUserMsg = [...messages].reverse().find(
        (m) => m.role === "user" && m.toolCallId === undefined,
      );

      const systemHash = systemMsg
        ? createHash("sha256").update(systemMsg.content).digest("hex")
        : "none";
      const userTailHash = lastUserMsg
        ? createHash("sha256").update(lastUserMsg.content).digest("hex")
        : "none";

      capturedRequests.push({ systemHash, userTailHash, messages: structuredClone(messages) });

      // 第一轮：调 todo toggle 标记完成
      if (capturedRequests.length === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "todo", arguments: JSON.stringify({ action: "toggle", id: 1 }) }],
        };
      }
      // 第二轮：正常回复
      return { role: "assistant", content: "完成" };
    },
  };

  const registry = new ToolRegistry();
  registry.register(new TodoTool(todoStore));

  // 每轮重建的 promptLayersFactory（模拟 loop.ts 的行为）
  let turnIndex = 0;
  const promptLayersFactory = async ({ currentUserPrompt }: { currentUserPrompt: string }) => {
    turnIndex++;
    const composer = new PromptComposer(workDir, false, {
      todoStore,
      goalManager,
      picoHome,
    });
    const layers = await composer.buildLayers();
    // 打印第一轮和第二轮的 turnTail 差异
    console.log(`[Turn ${turnIndex}] turnTail 长度: ${layers.turnTail.length}`);
    return layers;
  };

  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    promptLayersFactory,
    reporter: new SilentReporter(),
    maxTurns: 3,
  });

  const session = new Session("cache-test", workDir, { persistence: false, picoHome });
  context.after(() => session.close());
  await session.commitMessages({ role: "user", content: "帮我完成任务" });

  await engine.run(session);

  // 验证：至少两轮请求被捕获
  assert.ok(capturedRequests.length >= 2, `应至少有两轮请求，实际: ${capturedRequests.length}`);

  // ★ 核心断言 1：system 消息在多轮间字节相同（缓存命中）
  const systemHashes = capturedRequests.map((r) => r.systemHash);
  console.log("[systemHash 各轮]", systemHashes);
  const allSame = systemHashes.every((h) => h === systemHashes[0]);
  assert.ok(allSame, "systemPrompt 在多轮间应保持字节不变（缓存安全）");

  // ★ 核心断言 2：turnTail（user 消息末尾）在 todo 操作后发生变化
  const tailHashes = capturedRequests.map((r) => r.userTailHash);
  console.log("[userTailHash 各轮]", tailHashes);

  // 验证 turnTail 确实变化了（todo 状态从 pending 变为 in_progress）
  const turn1Tail = capturedRequests[0]!.messages.find(
    (m) => m.role === "user" && m.toolCallId === undefined,
  )!.content;
  const turn2Tail = capturedRequests[1]!.messages.filter(
    (m) => m.role === "user" && m.toolCallId === undefined,
  ).at(-1)!.content;

  console.log("[Turn 1 user 末尾]\n", turn1Tail.slice(-200));
  console.log("[Turn 2 user 末尾]\n", turn2Tail.slice(-200));

  assert.notEqual(tailHashes[0], tailHashes[1], "todo 操作后 turnTail 应发生变化");

  // ★ 核心断言 3：Turn 1 的 todo 状态是 pending，Turn 2 是 in_progress
  assert.match(turn1Tail, /\[ \].*待办任务/u, "Turn 1 todo 应为 pending 状态 [ ]");
  assert.match(turn2Tail, /\[~\].*待办任务/u, "Turn 2 todo 应为 in_progress 状态 [~]");

  console.log("\n✅ 验证通过：systemPrompt 冻结（缓存安全），turnTail 每轮重建（状态新鲜）");
});
