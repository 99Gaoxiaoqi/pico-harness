import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FullCompactor } from "../src/context/full-compactor.js";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { CostTracker, type CostTrackerOptions } from "../src/observability/tracker.js";
import { ensureSessionUsageBaseline } from "../src/observability/usage-baseline.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import { JobService } from "../src/tasks/job-service.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";

describe("provider usage ledger integration", () => {
  const directories: string[] = [];
  const sessions: Session[] = [];
  const services: JobService[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    for (const service of services.splice(0)) service.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("以 baseline + provider_calls 统一记录 main/subagent/compaction/aux 与失败取消", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-usage-ledger-"));
    directories.push(workDir);
    const jobs = new JobService({ workDir, ownerId: "usage-test" });
    services.push(jobs);
    const subagentJob = jobs.dispatch({
      jobId: "job-subagent",
      type: "local_agent",
      executionClass: "recoverable",
      completionPolicy: "required",
      description: "usage attribution",
      ownerSessionId: "usage-session",
    });
    const subagentAttempt = jobs.start(subagentJob.jobId, {
      expectedVersion: subagentJob.version,
      attemptId: "attempt-subagent",
    });
    const session = new Session("usage-session", workDir, { persistence: false });
    sessions.push(session);
    session.recordUsage(
      30,
      10,
      1,
      {
        inputTokens: 20,
        outputTokens: 8,
        cacheReadTokens: 5,
        cacheWriteTokens: 5,
        reasoningTokens: 2,
        totalPromptTokens: 30,
        totalCompletionTokens: 10,
      },
      "estimated",
    );
    expect(ensureSessionUsageBaseline(jobs, session).inserted).toBe(true);
    expect(ensureSessionUsageBaseline(jobs, session).inserted).toBe(false);

    let callSequence = 0;
    const trackerOptions: CostTrackerOptions = {
      ledger: jobs,
      context: () => ({
        purpose: "main",
        sessionId: session.id,
        conversationId: session.conversationId,
        goalId: "goal-explicit",
      }),
      callId: () => `call-${++callSequence}`,
    };
    const mainProvider = new SequenceProvider([
      response("main", 10, 4),
      response("子代理已完成：" + "证据".repeat(120), 20, 5),
    ]);
    const trackedMain = new CostTracker(
      mainProvider,
      { provider: "openai", model: "unknown-test-model", baseUrl: "local://main" },
      session,
      trackerOptions,
    );

    await trackedMain.generate([], []);
    await new CostTracker(
      new SequenceProvider([{ role: "assistant", content: "success without usage" }]),
      { provider: "openai", model: "unknown-test-model" },
      session,
      trackerOptions,
    ).generate([], []);
    await new CostTracker(
      new SequenceProvider([response("hook", 2, 1)]),
      { provider: "openai", model: "unknown-test-model" },
      session,
      trackerOptions,
    ).generate([], [], { purpose: "hook" });
    const engine = new AgentEngine({
      provider: trackedMain,
      registry: new EmptyRegistry(),
      workDir,
    });
    await engine.runSub("读取项目后给出结论", new EmptyRegistry(), undefined, {
      maxTurns: 2,
      usageAttribution: {
        jobId: subagentJob.jobId,
        attemptId: subagentAttempt.attempt.attemptId,
      },
    });

    const compactionProvider = new CostTracker(
      new SequenceProvider([response("主模型摘要", 7, 3)]),
      { provider: "openai", model: "unknown-test-model", baseUrl: "local://main" },
      session,
      trackerOptions,
    );
    seedCompactionHistory(session);
    await new FullCompactor({ provider: compactionProvider, maxAttempts: 1 }).compact(session, 1);

    const auxProvider = new CostTracker(
      new SequenceProvider([response("辅助模型摘要", 6, 2)]),
      { provider: "openai", model: "unknown-aux-model", baseUrl: "local://aux" },
      session,
      trackerOptions,
    );
    seedCompactionHistory(session);
    await new FullCompactor({
      provider: trackedMain,
      auxProvider,
      maxAttempts: 1,
    }).compact(session, 1);

    const failed = new CostTracker(
      new ThrowingProvider(new Error("provider failed")),
      { provider: "openai", model: "unknown-test-model" },
      session,
      trackerOptions,
    );
    await expect(failed.generate([], [])).rejects.toThrow("provider failed");

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const cancelled = new CostTracker(
      new ThrowingProvider(controller.signal.reason),
      { provider: "openai", model: "unknown-test-model" },
      session,
      trackerOptions,
    );
    await expect(cancelled.generate([], [], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    const calls = jobs.store.listProviderCalls({ sessionId: session.id });
    expect(calls.map(({ purpose, status }) => ({ purpose, status }))).toEqual([
      { purpose: "main", status: "succeeded" },
      { purpose: "main", status: "succeeded" },
      { purpose: "hook", status: "succeeded" },
      { purpose: "subagent", status: "succeeded" },
      { purpose: "compaction", status: "succeeded" },
      { purpose: "aux", status: "succeeded" },
      { purpose: "main", status: "failed" },
      { purpose: "main", status: "cancelled" },
    ]);
    expect(calls[1]).toMatchObject({
      status: "succeeded",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      reported: { usageMetadata: "unknown", costStatus: "unknown" },
    });
    expect(calls.slice(-2).map((call) => call.reported?.["usageMetadata"])).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(calls.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputTokens: 0, outputTokens: 0, cost: 0 }),
      ]),
    );
    expect(calls.filter((call) => call.purpose === "aux")[0]).toMatchObject({
      provider: "openai",
      model: "unknown-aux-model",
      route: "local://aux",
    });
    expect(calls.filter((call) => call.purpose === "subagent")[0]).toMatchObject({
      jobId: "job-subagent",
      attemptId: "attempt-subagent",
      sessionId: "usage-session",
      conversationId: session.conversationId,
      goalId: "goal-explicit",
    });

    const summary = jobs.getUsageSummary({ sessionId: session.id });
    expect(summary).toMatchObject({
      providerCallCount: 8,
      baselineCount: 1,
      baselines: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 5,
        cost: 1,
      },
      total: {
        inputTokens: 65,
        outputTokens: 25,
        cacheReadTokens: 5,
        cacheWriteTokens: 5,
        cost: 1,
      },
    });
    expect(jobs.getUsageSummary({ jobId: "job-subagent" })).toMatchObject({
      providerCallCount: 1,
      baselineCount: 0,
      total: { inputTokens: 20, outputTokens: 5 },
    });
  });
});

class SequenceProvider implements LLMProvider {
  private index = 0;

  constructor(private readonly responses: Message[]) {}

  async generate(): Promise<Message> {
    const response = this.responses[this.index++];
    if (!response) throw new Error("mock provider response exhausted");
    return response;
  }
}

class ThrowingProvider implements LLMProvider {
  constructor(private readonly error: unknown) {}

  async generate(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    throw this.error;
  }
}

class EmptyRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    return { toolCallId: call.id, output: "unused", isError: false };
  }
}

function response(content: string, promptTokens: number, completionTokens: number): Message {
  return {
    role: "assistant",
    content,
    usage: {
      promptTokens,
      completionTokens,
      reportedFields: ["prompt", "completion"],
    },
  };
}

function seedCompactionHistory(session: Session): void {
  session.append(
    { role: "user", content: "第一轮问题" },
    { role: "assistant", content: "第一轮回答" },
    { role: "user", content: "第二轮问题" },
    { role: "assistant", content: "第二轮回答" },
  );
}
