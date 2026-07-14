// Session 持久化端到端集成测试。
//
// 验证的不是 Session 单元逻辑(那是 session-persistence.test.ts 的职责),
// 而是"持久化在真实引擎链路里端到端生效":
//   1. engine.run 跑完 → 历史落盘到 .claw/sessions/<id>.jsonl
//   2. 模拟进程重启:新建 SessionManager(内存清空) + getOrCreate(触发 recover 重放)
//   3. 新 engine 实例基于恢复的历史继续跑 → 验证 provider 收到了恢复的历史
//
// 用 ScriptedProvider(mock)而非真实模型:集成测试验证的是持久化链路正确性,
// 不是模型推理质量。mock 能精确控制"收到什么历史、返回什么",更适合断言。
//
// 持久化开关通过构造参数显式传入(不依赖环境变量,避免 vitest 并行测试间污染)。
// 用 mkdtemp 隔离。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/engine/loop.js";
import { SessionManager } from "../src/engine/session.js";
import { listCliSessionSummaries } from "../src/cli/session-resolver.js";
import {
  getOrCreateSessionSettings,
  getStoredSessionSettings,
  migrateSessionModelRoute,
  resetSessionSettingsForTests,
  resolveRestoredSessionModelRoute,
  setSessionModelRoute,
  setSessionTitle,
} from "../src/input/session-settings.js";
import type { LLMProvider } from "../src/provider/interface.js";
import { loadModelRouter } from "../src/provider/model-router.js";

/** 跨平台安全删除:Windows 上 SQLite 句柄未释放时 rm 触发 EBUSY,退避重试兜底 */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        String(err).includes("EBUSY") ||
        String(err).includes("EPERM") ||
        String(err).includes("ENOTEMPTY")
      ) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";

/**
 * 历史记录型 Mock Provider:每次 generate 记录收到的 messages(供断言恢复的历史),
 * 并按预设响应序列依次返回。响应耗尽后返回纯文本结束消息。
 */
class RecordingScriptedProvider implements LLMProvider {
  readonly receivedHistories: Message[][] = [];
  private i = 0;
  constructor(private readonly responses: Message[]) {}
  async generate(msgs: Message[], _tools: ToolDefinition[]): Promise<Message> {
    // 拷贝一份,避免后续 mutation 影响记录
    this.receivedHistories.push(msgs.map((m) => ({ ...m })));
    const r = this.responses[this.i];
    this.i++;
    return r ?? { role: "assistant", content: "结束" };
  }
}

/** 极简 Mock Registry:有一个工具可用,execute 返回固定结果 */
class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "bash",
        description: "run a bash command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.executed.push(call);
    return { toolCallId: call.id, output: `result-of-${call.name}`, isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return false;
  }
}

/** 等待 fire-and-forget 落盘完成(appendFile 走 libuv 线程池,需让出事件循环) */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** 显式持久化开关(传给 getOrCreate,避免环境变量并行污染) */
const ON = { persistence: true } as const;
const OFF = { persistence: false } as const;

describe("Session 持久化端到端集成", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-integ-"));
  });

  afterEach(async () => {
    resetSessionSettingsForTests();
    await safeRm(workDir);
  });

  it("引擎跑完后历史落盘;重启后新引擎基于恢复历史继续对话", async () => {
    // ── 第一段:初始会话跑一轮工具调用 ──
    const mgr1 = new SessionManager();
    const sess1 = await mgr1.getOrCreate("integ-chat", workDir, ON);
    sess1.append({ role: "user", content: "第一次对话" });

    const provider1 = new RecordingScriptedProvider([
      {
        role: "assistant",
        content: "我调个工具",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "第一次完成" },
    ]);
    const engine1 = new AgentEngine({
      provider: provider1,
      registry: new MockRegistry(),
      workDir,
    });
    await engine1.run(sess1);
    await flush();

    // 落盘后历史应有:user / assistant(带 toolCall) / observation / assistant(最终)
    expect(sess1.length).toBeGreaterThanOrEqual(4);

    // ── 模拟进程重启:全新的 SessionManager(内存清空) ──
    const mgr2 = new SessionManager();
    const sess2 = await mgr2.getOrCreate("integ-chat", workDir, ON);
    // recover 后历史应与重启前一致
    expect(sess2.length).toBe(sess1.length);
    expect(sess2.getHistory()[0]!.content).toBe("第一次对话");

    // ── 第二段:新引擎实例,基于恢复的历史继续跑 ──
    const provider2 = new RecordingScriptedProvider([
      { role: "assistant", content: "我知道你之前说过了,这是续接" },
    ]);
    const engine2 = new AgentEngine({
      provider: provider2,
      registry: new MockRegistry(),
      workDir,
    });
    sess2.append({ role: "user", content: "继续聊" });
    await engine2.run(sess2);

    // 关键断言:第二段引擎的 provider 必须收到恢复的历史(含"第一次对话"),
    // 证明 recover 重建的历史被主循环正确消费(getWorkingMemory 读到了它)
    expect(provider2.receivedHistories.length).toBeGreaterThan(0);
    const lastReceived = provider2.receivedHistories[provider2.receivedHistories.length - 1]!;
    const allContents = lastReceived.map((m) => m.content);
    expect(allContents).toContain("第一次对话"); // ← 恢复的历史被喂给了 provider
    expect(allContents).toContain("继续聊"); // 本轮新输入也在
  });

  it("v3 规范事件与 legacy 记录混合时，Session 和会话列表使用同一重放结果", async () => {
    const sessionId = "mixed-journal";
    const sessionsDir = join(workDir, ".claw", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const summaryMessage: Message = {
      role: "assistant",
      content: "历史摘要",
      providerData: { picoKind: "compaction_summary" },
    };
    const records = [
      { type: "message", seq: 0, message: { role: "user", content: "legacy-old" } },
      {
        type: "event",
        recordVersion: 1,
        eventId: "seed-1",
        seq: 1,
        epoch: 0,
        at: "2026-07-13T00:00:00.000Z",
        kind: "session.seeded",
        data: {
          messages: [
            { role: "user", content: "seed" },
            { role: "assistant", content: "seed reply" },
          ],
        },
      },
      {
        type: "event",
        recordVersion: 1,
        eventId: "compact-1",
        seq: 2,
        epoch: 1,
        at: "2026-07-13T00:00:01.000Z",
        kind: "history.compacted",
        data: {
          summaryMessage,
          retainedMessages: [{ role: "user", content: "retained prompt" }],
        },
      },
      { type: "message", seq: 3, message: { role: "user", content: "remove me" } },
      { type: "undo", seq: 4, count: 1, at: "2026-07-13T00:00:02.000Z" },
    ];
    await writeFile(
      join(sessionsDir, `${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const manager = new SessionManager();
    const session = await manager.getOrCreate(sessionId, workDir, ON);
    const summaries = await listCliSessionSummaries(workDir);

    expect(session.getHistory()).toEqual([
      summaryMessage,
      { role: "user", content: "retained prompt" },
    ]);
    expect(summaries).toMatchObject([
      {
        id: sessionId,
        messageCount: 2,
        title: "retained prompt",
        firstMessage: "retained prompt",
        lastMessage: "retained prompt",
      },
    ]);
    await session.close();
  });

  it("多会话隔离:两个会话各自落盘各自恢复,引擎不会串台", async () => {
    const mgr1 = new SessionManager();
    const sA = await mgr1.getOrCreate("chat-A", workDir, ON);
    const sB = await mgr1.getOrCreate("chat-B", workDir, ON);
    sA.append({ role: "user", content: "A 的首轮" });
    sB.append({ role: "user", content: "B 的首轮" });
    await flush();

    // 重启恢复
    const mgr2 = new SessionManager();
    const rA = await mgr2.getOrCreate("chat-A", workDir, ON);
    const rB = await mgr2.getOrCreate("chat-B", workDir, ON);

    // 各自跑引擎,A 的 provider 不该收到 B 的内容
    const pA = new RecordingScriptedProvider([{ role: "assistant", content: "A 回复" }]);
    const pB = new RecordingScriptedProvider([{ role: "assistant", content: "B 回复" }]);
    await new AgentEngine({ provider: pA, registry: new MockRegistry(), workDir }).run(rA);
    await new AgentEngine({ provider: pB, registry: new MockRegistry(), workDir }).run(rB);

    const aContents = pA.receivedHistories[0]!.map((m) => m.content);
    const bContents = pB.receivedHistories[0]!.map((m) => m.content);
    expect(aContents).toContain("A 的首轮");
    expect(aContents).not.toContain("B 的首轮");
    expect(bContents).toContain("B 的首轮");
    expect(bContents).not.toContain("A 的首轮");
  });

  it("会话标题经 runtime_state 落盘，重启和会话列表均读取显式标题", async () => {
    const sessionId = "named-session";
    const manager1 = new SessionManager();
    const session1 = await manager1.getOrCreate(sessionId, workDir, ON);
    const settings1 = getOrCreateSessionSettings(
      {
        sessionId,
        sessionMode: "fork",
        forkFrom: "source-session",
        cwd: workDir,
        provider: "openai",
        model: "test-model",
      },
      { persistence: session1 },
    );

    expect(setSessionTitle(settings1, "认证重构：Session 方案")).toMatchObject({ ok: true });
    await session1.flushPersistence();

    await expect(listCliSessionSummaries(workDir)).resolves.toMatchObject([
      { id: sessionId, title: "认证重构：Session 方案", forkFrom: "source-session" },
    ]);

    await session1.close();
    resetSessionSettingsForTests(); // 模拟进程重启后 input 层内存状态丢失。

    const manager2 = new SessionManager();
    const session2 = await manager2.getOrCreate(sessionId, workDir, ON);
    const settings2 = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: "openai",
        model: "fallback-model",
      },
      { persistence: session2 },
    );

    expect(settings2.title).toBe("认证重构：Session 方案");
    expect(settings2.forkFrom).toBe("source-session");
    await session2.close();
  });

  it("相同 sessionId 在不同 cwd 中保持独立设置和持久化绑定", async () => {
    const sessionId = "same-id-across-workspaces";
    const workDirA = join(workDir, "workspace-a");
    const workDirB = join(workDir, "workspace-b");
    await Promise.all([mkdir(workDirA), mkdir(workDirB)]);
    const manager = new SessionManager();
    const [sessionA, sessionB] = await Promise.all([
      manager.getOrCreate(sessionId, workDirA, ON),
      manager.getOrCreate(sessionId, workDirB, ON),
    ]);

    const settingsA = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDirA,
        provider: "openai",
        mode: "default",
        model: "model-a",
        modelRouteId: "provider-a/model-a",
        thinkingEffort: "high",
        additionalDirectories: [join(workDirA, "shared")],
      },
      { persistence: sessionA },
    );
    const settingsB = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDirB,
        provider: "claude",
        mode: "plan",
        model: "model-b",
        modelRouteId: "provider-b/model-b",
        thinkingEffort: "low",
        additionalDirectories: [join(workDirB, "shared")],
      },
      { persistence: sessionB },
    );

    expect(settingsB).not.toBe(settingsA);
    expect(getStoredSessionSettings(sessionId, workDirA)).toMatchObject({
      cwd: workDirA,
      mode: "default",
      modelRouteId: "provider-a/model-a",
      thinkingEffort: "high",
      additionalDirectories: [join(workDirA, "shared")],
    });
    expect(getStoredSessionSettings(sessionId, workDirB)).toMatchObject({
      cwd: workDirB,
      mode: "plan",
      modelRouteId: "provider-b/model-b",
      thinkingEffort: "low",
      additionalDirectories: [join(workDirB, "shared")],
    });
    expect(sessionA.getRuntimeStateSnapshot().settings).toMatchObject({
      mode: "default",
      modelRouteId: "provider-a/model-a",
      thinkingEffort: "high",
      additionalDirectories: [join(workDirA, "shared")],
    });
    expect(sessionB.getRuntimeStateSnapshot().settings).toMatchObject({
      mode: "plan",
      modelRouteId: "provider-b/model-b",
      thinkingEffort: "low",
      additionalDirectories: [join(workDirB, "shared")],
    });

    await Promise.all([sessionA.close(), sessionB.close()]);
  });

  it("旧模型路由失效时迁移到项目默认路由并持久化", async () => {
    const sessionId = "stale-model-route";
    const manager1 = new SessionManager();
    const session1 = await manager1.getOrCreate(sessionId, workDir, ON);
    getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: "openai",
        model: "retired-model",
        modelRouteId: "retired/retired-model",
        thinkingEffort: "high",
      },
      { persistence: session1 },
    );
    await session1.flushPersistence();
    await session1.close();
    resetSessionSettingsForTests();

    const router = await loadModelRouter({
      config: {
        model: "current/current-model",
        providers: {
          current: {
            protocol: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "CURRENT_API_KEY",
            models: ["current-model"],
            discoverModels: false,
          },
        },
      },
      env: {},
      legacyProvider: "openai",
      legacyModel: "unused",
    });
    const manager2 = new SessionManager();
    const session2 = await manager2.getOrCreate(sessionId, workDir, ON);
    const restored = (await session2.readHydrationSnapshot()).runtime.settings;
    const route = resolveRestoredSessionModelRoute(router, restored, router.defaultRouteId);
    const settings2 = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: route.provider,
        model: route.model,
        modelRouteId: route.id,
      },
      { persistence: session2 },
    );

    expect(settings2.modelRouteId).toBe("retired/retired-model");
    migrateSessionModelRoute(settings2, route);
    expect(settings2).toMatchObject({
      provider: "openai",
      model: "current-model",
      modelRouteId: "current/current-model",
    });
    expect(session2.getRuntimeStateSnapshot().settings).toMatchObject({
      provider: "openai",
      model: "current-model",
      modelRouteId: "current/current-model",
    });
    await session2.close();
  });

  it("切到固定、未知或禁用思考的模型时清理旧档位，并在重启后保持一致", async () => {
    const sessionId = "reasoning-reset-session";
    const router = await loadModelRouter({
      config: {
        model: "test/deepseek-v4-pro-260425",
        providers: {
          test: {
            protocol: "openai",
            baseURL: "https://example.invalid/v1",
            apiKeyEnv: "TEST_API_KEY",
            discoverModels: false,
            models: ["deepseek-v4-pro-260425", "fixed-model", "unknown-model", "disabled-model"],
            modelCapabilities: {
              "fixed-model": { reasoning: true },
              "disabled-model": { reasoning: false },
            },
          },
        },
      },
      env: { TEST_API_KEY: "test-key" },
      legacyProvider: "openai",
      legacyModel: "unused",
    });
    const manager1 = new SessionManager();
    const session1 = await manager1.getOrCreate(sessionId, workDir, ON);
    const settings1 = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: "openai",
        model: "deepseek-v4-pro-260425",
        modelRouteId: "test/deepseek-v4-pro-260425",
        thinkingEffort: "max",
      },
      { persistence: session1 },
    );

    for (const routeId of ["test/fixed-model", "test/unknown-model", "test/disabled-model"]) {
      settings1.thinkingEffort = "max";
      settings1.thinkingEffortExplicit = true;
      expect(setSessionModelRoute(settings1, router, routeId)).toMatchObject({ ok: true });
      expect(settings1.thinkingEffort).toBe("off");
      expect(settings1.thinkingEffortExplicit).toBe(false);
    }
    expect(session1.getRuntimeStateSnapshot().settings).toMatchObject({
      modelRouteId: "test/disabled-model",
      thinkingEffort: "off",
      thinkingEffortExplicit: false,
    });
    await session1.flushPersistence();
    await session1.close();

    resetSessionSettingsForTests();
    const manager2 = new SessionManager();
    const session2 = await manager2.getOrCreate(sessionId, workDir, ON);
    const settings2 = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: "openai",
        model: "fallback-model",
      },
      { persistence: session2 },
    );

    expect(settings2.modelRouteId).toBe("test/disabled-model");
    expect(settings2.thinkingEffort).toBe("off");
    expect(settings2.thinkingEffortExplicit).toBe(false);
    await session2.close();
  });

  it("重启后恢复的历史触发 truncate,新引擎能基于折叠后的历史继续", async () => {
    // 第一段:构造一段会被 truncate 的历史
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("trunc-chat", workDir, ON);
    s1.append(
      { role: "user", content: "m0" },
      { role: "assistant", content: "m1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "m3" },
    );
    await flush();
    s1.truncateTo(2); // 只保留 m2, m3
    await flush();
    expect(s1.length).toBe(2);

    // 重启恢复
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("trunc-chat", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("m2");

    // 新引擎基于折叠后的历史继续跑
    const provider = new RecordingScriptedProvider([{ role: "assistant", content: "折叠后续接" }]);
    await new AgentEngine({
      provider,
      registry: new MockRegistry(),
      workDir,
    }).run(s2);

    // provider 收到的历史只含折叠后的部分(m2/m3),不含被丢弃的 m0/m1
    const received = provider.receivedHistories[0]!;
    const contents = received.map((m) => m.content);
    expect(contents).toContain("m2");
    expect(contents).toContain("m3");
    expect(contents).not.toContain("m0");
    expect(contents).not.toContain("m1");
  });

  it("持久化关闭时:重启不恢复,引擎当作全新会话", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("no-persist", workDir, OFF);
    s1.append({ role: "user", content: "不会落盘的内容" });
    await flush();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("no-persist", workDir, OFF);
    expect(s2.length).toBe(0); // 持久化关闭 → 历史为空

    // 引擎当作全新会话:provider 收到的只有本轮新输入(不含"不会落盘的内容")
    const provider = new RecordingScriptedProvider([{ role: "assistant", content: "全新开始" }]);
    s2.append({ role: "user", content: "新输入" });
    await new AgentEngine({
      provider,
      registry: new MockRegistry(),
      workDir,
    }).run(s2);

    const contents = provider.receivedHistories[0]!.map((m) => m.content);
    expect(contents).toContain("新输入");
    expect(contents).not.toContain("不会落盘的内容");
  });
});
