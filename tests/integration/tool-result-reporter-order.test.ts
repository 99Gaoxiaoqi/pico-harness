import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import type { ToolResultEnvelope } from "../../src/engine/tool-result-contract.js";
import type { CanonicalTranscriptToolStart } from "../../src/engine/transcript-tool-start.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { Session } from "../../src/engine/session.js";
import { hydrateCanonicalTranscriptEvents } from "../../src/presentation/transcript-tool-result-hydration.js";
import { HookService, type HookExecutor } from "../../src/hooks/service.js";
import {
  HOOK_EVENTS,
  type HookInput,
  type HookSnapshot,
  type ResolvedHookHandler,
} from "../../src/hooks/types.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/storage/runtime-event.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import { ToolAccesses } from "../../src/tools/tool-access.js";
import {
  NO_FILE_SIDE_EFFECTS,
  type BaseTool,
  type Registry,
  type ToolExecutionContext,
} from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

type PostToolHookEvent = "PostToolUse" | "PostToolUseFailure" | "PostToolBatch";

test("Reporter failure happens after canonical ToolResult commit and keeps Session writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-reporter-order-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-reporter-order", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    const registry = new ToolRegistry();
    registry.register(outputTool("reporter_fixture", "actual output"));
    const provider: LLMProvider = {
      async generate() {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:reporter-fixture",
              name: "reporter_fixture",
              arguments: "{}",
            },
          ],
        };
      },
    };
    const reporterFailure = new Error("fixture Reporter failed");
    const reporter = new (class extends SilentReporter {
      override onToolResult(): void {
        throw reporterFailure;
      }
    })();
    const hookInputs: HookInput[] = [];
    const hookService = recordingHookService(
      workDir,
      session.id,
      ["PostToolUse", "PostToolBatch"],
      hookInputs,
    );
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      hookService,
      maxTurns: 2,
    });

    await assert.rejects(engine.run(session), reporterFailure);

    const events = await session.runtimeEventStore!.readSession(session.id);
    const recorded = events.find(
      (event): event is RuntimeToolResultRecordedEvent =>
        event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:reporter-fixture",
    );
    assert.ok(recorded);
    assert.equal(recorded.data.status, "succeeded");
    assert.equal(recorded.data.body.storage, "inline");
    if (recorded.data.body.storage !== "inline") {
      assert.fail("fixture ToolResult must remain inline");
    }
    assert.equal(recorded.data.body.content, "actual output");
    assert.equal(recorded.data.projection.text, "actual output");
    assert.equal(events.filter((event) => event.kind === "tool.result.recorded").length, 1);
    const terminal = events.find(
      (event) => event.kind === "run.terminal" && event.runId === recorded.runId,
    );
    assert.ok(terminal?.kind === "run.terminal");
    assert.equal(terminal.data.status, "failed");
    assert.deepEqual(
      hookInputs.map((input) => input.hook_event_name),
      ["PostToolUse", "PostToolBatch"],
    );

    const history = materializeRuntimeHistory(events);
    assert.deepEqual(
      history.slice(-2).map((message) => ({
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        content: message.content,
      })),
      [
        {
          toolCalls: [
            {
              id: "call:reporter-fixture",
              name: "reporter_fixture",
              arguments: "{}",
            },
          ],
          toolCallId: undefined,
          content: "",
        },
        {
          toolCalls: undefined,
          toolCallId: "call:reporter-fixture",
          content: "actual output",
        },
      ],
    );

    await session.commitMessages({ role: "user", content: "Session remains writable." });
    assert.equal(session.getHistory().at(-1)?.content, "Session remains writable.");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("onTurn failure closes a committed tool batch only after its durable start", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-start-on-turn-failure-"));
  const workDir = join(root, "workspace");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-start-on-turn-failure", workDir, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort,
  });
  const failure = new Error("fixture onTurn failure");
  const registry = new ToolRegistry();
  registry.register(outputTool("on_turn_fixture", "must not execute"));
  const provider: LLMProvider = {
    async generate() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:on-turn", name: "on_turn_fixture", arguments: "{}" }],
      };
    },
  };

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      maxTurns: 2,
      onTurn: () => {
        throw failure;
      },
    });

    await assert.rejects(engine.run(session), failure);

    const hydration = await session.readHydrationSnapshot();
    assert.equal(
      hydration.transcriptEvents.filter((event) => event.type === "tool.started").length,
      1,
    );
    assert.equal(hydration.toolResults.length, 1);
    assert.doesNotThrow(() =>
      hydrateCanonicalTranscriptEvents({
        sessionId: hydration.sessionId,
        updatedAt: hydration.updatedAt,
        transcriptEvents: hydration.transcriptEvents,
        transcriptEventSequences: hydration.transcriptEventSequences,
        toolResults: hydration.toolResults,
        rejectUnmatchedResults: true,
      }),
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tool start persistence failure never commits an unmatched synthetic result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-start-persistence-failure-"));
  const workDir = join(root, "workspace");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-start-persistence-failure", workDir, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort,
  });
  const failure = new Error("fixture tool start persistence failure");
  const registry = new ToolRegistry();
  registry.register(outputTool("start_failure_fixture", "must not execute"));
  const provider: LLMProvider = {
    async generate() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:start-failure", name: "start_failure_fixture", arguments: "{}" }],
      };
    },
  };

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    session.recordRuntimeTranscriptToolStarts = async () => {
      throw failure;
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      maxTurns: 2,
    });

    await assert.rejects(engine.run(session), failure);

    const hydration = await session.readHydrationSnapshot();
    assert.equal(
      hydration.transcriptEvents.filter((event) => event.type === "tool.started").length,
      0,
    );
    assert.deepEqual(hydration.toolResults, []);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("abnormal parallel batch reports settled and synthetic ToolResults once after commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-reporter-batch-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-reporter-batch", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const controller = new AbortController();
  const cancellation = new DOMException("fixture cancellation", "AbortError");
  const bothStarted = deferred<void>();
  let startedCount = 0;
  const markStarted = (): void => {
    startedCount++;
    if (startedCount === 2) bothStarted.resolve();
  };
  const definitions: ToolDefinition[] = [
    fixtureDefinition("fast_fixture"),
    fixtureDefinition("slow_fixture"),
  ];
  const registry: Registry = {
    register() {},
    use() {},
    getAvailableTools: () => definitions,
    isReadOnlyTool: () => false,
    getFileSideEffects: (call) => ({ kind: "exact", paths: [`${call.name}.fixture`] }),
    getAccesses: () => ToolAccesses.none(),
    async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      markStarted();
      await bothStarted.promise;
      if (call.name === "fast_fixture") {
        return {
          toolCallId: call.id,
          output: "fast actual output",
          isError: false,
        };
      }
      await waitForAbort(context?.signal);
      assert.fail("slow fixture must be cancelled");
    },
  };
  const provider: LLMProvider = {
    async generate() {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call:slow", name: "slow_fixture", arguments: "{}" },
          { id: "call:fast", name: "fast_fixture", arguments: "{}" },
        ],
      };
    },
  };
  const reported: Array<{
    toolName: string;
    result: string;
    isError: boolean;
    providerCallId?: string;
  }> = [];
  const reporter = new (class extends SilentReporter {
    override onToolResult(result: ToolResultEnvelope): void {
      reported.push({
        toolName: result.toolName,
        result: result.projection.text,
        isError: result.status !== "succeeded",
        providerCallId: result.toolCallId,
      });
      if (result.toolName === "fast_fixture") {
        throw new Error("fixture Reporter failure after recording");
      }
    }
  })();
  const hookInputs: HookInput[] = [];
  const hookService = recordingHookService(
    workDir,
    session.id,
    ["PostToolUse", "PostToolUseFailure", "PostToolBatch"],
    hookInputs,
  );

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run both fixtures." });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      hookService,
      maxTurns: 2,
    });

    const runPromise = engine.run(session, undefined, undefined, controller.signal);
    await bothStarted.promise;
    controller.abort(cancellation);
    await assert.rejects(runPromise, (error: unknown) => error === cancellation);

    assert.equal(reported.length, 2);
    assert.deepEqual(
      reported.map(({ toolName, isError, providerCallId }) => ({
        toolName,
        isError,
        providerCallId,
      })),
      [
        {
          toolName: "fast_fixture",
          isError: false,
          providerCallId: "call:fast",
        },
        {
          toolName: "slow_fixture",
          isError: true,
          providerCallId: "call:slow",
        },
      ],
    );
    assert.equal(reported[0]?.result, "fast actual output");
    assert.match(reported[1]?.result ?? "", /^工具执行已取消:/u);
    assert.deepEqual(
      hookInputs.map((input) => input.hook_event_name),
      ["PostToolUse", "PostToolUseFailure", "PostToolBatch"],
    );
    const batch = hookInputs[2] as HookInput<"PostToolBatch"> | undefined;
    assert.equal(batch?.hook_event_name, "PostToolBatch");
    assert.deepEqual(
      batch.payload.tools.map((tool) => tool.tool_call_id),
      ["call:slow", "call:fast"],
    );

    const events = await session.runtimeEventStore!.readSession(session.id);
    const recorded = events.filter(
      (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
    );
    assert.equal(recorded.length, 2);
    assert.deepEqual(
      recorded.map((event) => ({
        toolCallId: event.refs.toolCallId,
        status: event.data.status,
        mode: event.data.projection.mode,
      })),
      [
        { toolCallId: "call:slow", status: "cancelled", mode: "synthetic" },
        { toolCallId: "call:fast", status: "succeeded", mode: "full" },
      ],
    );
    const history = materializeRuntimeHistory(events);
    assert.deepEqual(
      history.filter((message) => message.toolCallId).map((message) => message.toolCallId),
      ["call:slow", "call:fast"],
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagent parallel ToolResults commit in Provider order and publish the complete Hook batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-subagent-tool-result-batch-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("subagent-tool-result-batch", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const bothStarted = deferred<void>();
  const releaseSlow = deferred<void>();
  let startedCount = 0;
  const providerRequests: Message[][] = [];
  const registry: Registry = {
    register() {},
    use() {},
    getAvailableTools: () => [fixtureDefinition("slow_fixture"), fixtureDefinition("fast_fixture")],
    isReadOnlyTool: () => true,
    getFileSideEffects: () => NO_FILE_SIDE_EFFECTS,
    getAccesses: () => ToolAccesses.none(),
    async execute(call: ToolCall): Promise<ToolResult> {
      startedCount++;
      if (startedCount === 2) bothStarted.resolve();
      await bothStarted.promise;
      if (call.name === "slow_fixture") {
        await releaseSlow.promise;
        return { toolCallId: call.id, output: "slow output", isError: false };
      }
      setTimeout(() => releaseSlow.resolve(), 25);
      return { toolCallId: call.id, output: "fast output", isError: false };
    },
  };
  const provider: LLMProvider = {
    async generate(messages) {
      providerRequests.push(structuredClone(messages));
      if (providerRequests.length === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call:slow", name: "slow_fixture", arguments: "{}" },
            { id: "call:fast", name: "fast_fixture", arguments: "{}" },
          ],
        };
      }
      assert.deepEqual(
        messages.filter((message) => message.toolCallId).map((message) => message.toolCallId),
        ["call:slow", "call:fast"],
      );
      return {
        role: "assistant",
        content: "子代理已完成并行工具核验。".repeat(20),
      };
    },
  };
  const reported: string[] = [];
  const reporter = new (class extends SilentReporter {
    override onToolResult(result: ToolResultEnvelope): void {
      reported.push(result.toolCallId);
    }
  })();
  const hookInputs: HookInput[] = [];
  const hookService = recordingHookService(
    workDir,
    session.id,
    ["PostToolUse", "PostToolBatch"],
    hookInputs,
  );

  try {
    await session.recover();
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir,
      runtimePort,
      reporter,
      hookService,
    });
    const parentRun = await runtimePort.startRun({
      capability: session.runtimeEventCapability!,
    });
    const result = await parentRun.run(() =>
      engine.runSub("并行检查两个只读工具。", registry, reporter, {
        maxTurns: 3,
        workDir,
      }),
    );

    assert.equal(result.status, "completed");
    assert.deepEqual(reported, ["call:fast", "call:slow"]);
    assert.deepEqual(
      hookInputs.map((input) => input.hook_event_name),
      ["PostToolUse", "PostToolUse", "PostToolBatch"],
    );

    const events = await session.runtimeEventStore!.readSession(session.id);
    const transcriptResults = events.filter(
      (event): event is RuntimeToolResultRecordedEvent =>
        event.kind === "tool.result.recorded" && event.visibility === "transcript",
    );
    assert.deepEqual(
      transcriptResults.map((event) => event.refs.toolCallId),
      ["call:slow", "call:fast"],
    );
    assert.deepEqual(materializeRuntimeHistory(events), []);
  } finally {
    releaseSlow.resolve();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("required delegation batch reports its synthetic rejection and actual result once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-reporter-delegation-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-reporter-delegation", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const registry = new ToolRegistry();
  registry.register(outputTool("rejected_fixture", "this output must not be used"));
  registry.register(
    outputTool(
      "delegate_task",
      JSON.stringify({
        status: "completed",
        results: [{ status: "completed", summary: "delegation fixture completed" }],
      }),
    ),
  );
  let providerCallCount = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCallCount++;
      if (providerCallCount > 1) {
        return { role: "assistant", content: "Done." };
      }
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call:rejected", name: "rejected_fixture", arguments: "{}" },
          {
            id: "call:delegate",
            name: "delegate_task",
            arguments: JSON.stringify({
              goal: "Run the delegation fixture.",
              mode: "worker",
              completion_policy: "required",
            }),
          },
        ],
      };
    },
  };
  const reported: Array<{
    toolName: string;
    result: string;
    isError: boolean;
    providerCallId?: string;
  }> = [];
  const started: CanonicalTranscriptToolStart[] = [];
  const reporter = new (class extends SilentReporter {
    override onToolCall(
      toolName: string,
      args: string,
      providerCallId: string,
      durableStart?: CanonicalTranscriptToolStart,
    ): void {
      assert.ok(durableStart);
      assert.equal(durableStart.name, toolName);
      assert.equal(durableStart.args, args);
      assert.equal(durableStart.providerCallId, providerCallId);
      started.push(structuredClone(durableStart));
    }

    override onToolResult(result: ToolResultEnvelope): void {
      reported.push({
        toolName: result.toolName,
        result: result.projection.text,
        isError: result.status !== "succeeded",
        providerCallId: result.toolCallId,
      });
    }
  })();

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the two fixtures." });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      maxTurns: 3,
    });

    await engine.run(session);

    assert.deepEqual(
      started.map((start) => start.providerCallId),
      ["call:rejected", "call:delegate"],
    );
    assert.equal(new Set(started.map((start) => start.eventId)).size, 2);
    assert.equal(reported.length, 2);
    assert.deepEqual(
      reported.map(({ toolName, isError, providerCallId }) => ({
        toolName,
        isError,
        providerCallId,
      })),
      [
        {
          toolName: "rejected_fixture",
          isError: true,
          providerCallId: "call:rejected",
        },
        {
          toolName: "delegate_task",
          isError: false,
          providerCallId: "call:delegate",
        },
      ],
    );
    assert.match(reported[0]?.result ?? "", /^工具执行已拒绝[：:]/u);

    const events = await session.runtimeEventStore!.readSession(session.id);
    const recorded = events.filter(
      (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
    );
    assert.deepEqual(
      recorded.map((event) => ({
        toolCallId: event.refs.toolCallId,
        status: event.data.status,
      })),
      [
        { toolCallId: "call:rejected", status: "rejected" },
        { toolCallId: "call:delegate", status: "succeeded" },
      ],
    );
    const hydration = await session.readHydrationSnapshot();
    const hydrated = hydrateCanonicalTranscriptEvents({
      sessionId: hydration.sessionId,
      updatedAt: hydration.updatedAt,
      transcriptEvents: hydration.transcriptEvents,
      transcriptEventSequences: hydration.transcriptEventSequences,
      toolResults: hydration.toolResults,
      rejectUnmatchedResults: true,
    });
    assert.deepEqual(
      hydrated
        .filter((event) => event.type === "tool.completed")
        .map((event) => (event.type === "tool.completed" ? event.result.toolCallId : undefined)),
      ["call:rejected", "call:delegate"],
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-execution budget closure keeps one durable start recoverable with its synthetic result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-pre-execution-budget-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "tool-result-pre-execution-budget";
  const runtimePort = createEngineRuntimePort();
  let session = new Session(sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => "budget_fixture",
    definition: () => fixtureDefinition("budget_fixture"),
    async execute() {
      executions++;
      return "must not execute";
    },
  });
  let providerCallCount = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCallCount++;
      if (providerCallCount === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call:budget", name: "budget_fixture", arguments: "{}" }],
          usage: { promptTokens: 2, completionTokens: 1 },
        };
      }
      return { role: "assistant", content: "Budget closure complete." };
    },
  };
  const starts: CanonicalTranscriptToolStart[] = [];
  const results: ToolResultEnvelope[] = [];
  const reporter = new (class extends SilentReporter {
    override onToolCall(
      _toolName: string,
      _args: string,
      _providerCallId: string,
      durableStart?: CanonicalTranscriptToolStart,
    ): void {
      assert.ok(durableStart);
      starts.push(structuredClone(durableStart));
    }

    override onToolResult(result: ToolResultEnvelope): void {
      results.push(structuredClone(result));
    }
  })();

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the budget fixture." });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      maxTurns: 3,
      budgetConfig: { maxTokens: 1 },
    });

    await engine.run(session);

    assert.equal(executions, 0);
    assert.deepEqual(
      starts.map((start) => start.providerCallId),
      ["call:budget"],
    );
    assert.deepEqual(
      results.map((result) => ({
        toolCallId: result.toolCallId,
        status: result.status,
        mode: result.projection.mode,
      })),
      [{ toolCallId: "call:budget", status: "cancelled", mode: "synthetic" }],
    );

    await session.close();
    session = new Session(sessionId, workDir, {
      persistence: true,
      picoHome,
      runtimePort,
    });
    await session.recover();
    const hydration = await session.readHydrationSnapshot();
    const hydrated = hydrateCanonicalTranscriptEvents({
      sessionId: hydration.sessionId,
      updatedAt: hydration.updatedAt,
      transcriptEvents: hydration.transcriptEvents,
      transcriptEventSequences: hydration.transcriptEventSequences,
      toolResults: hydration.toolResults,
      rejectUnmatchedResults: true,
    });
    assert.equal(hydrated.filter((event) => event.type === "tool.started").length, 1);
    assert.deepEqual(
      hydrated
        .filter((event) => event.type === "tool.completed")
        .map((event) => (event.type === "tool.completed" ? event.result.toolCallId : undefined)),
      ["call:budget"],
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("required-first rejection publishes its durable ToolResult to every observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-required-first-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-required-first", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const registry = new ToolRegistry();
  registry.register(outputTool("rejected_fixture", "must not execute"));
  registry.register(
    outputTool(
      "delegate_task",
      JSON.stringify({
        status: "completed",
        results: [{ status: "completed", summary: "delegation completed" }],
      }),
    ),
  );
  let turn = 0;
  const provider: LLMProvider = {
    async generate() {
      turn++;
      if (turn === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call:required-first-rejected", name: "rejected_fixture", arguments: "{}" },
          ],
        };
      }
      if (turn === 2) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:required-first-delegate",
              name: "delegate_task",
              arguments: JSON.stringify({
                goal: "Run the delegated fixture.",
                mode: "worker",
                completion_policy: "required",
              }),
            },
          ],
        };
      }
      return { role: "assistant", content: "Done." };
    },
  };
  const reported: ToolResultEnvelope[] = [];
  const reporter = new (class extends SilentReporter {
    override onToolResult(result: ToolResultEnvelope): void {
      reported.push(structuredClone(result));
    }
  })();
  const hookInputs: HookInput[] = [];
  const hookService = recordingHookService(
    workDir,
    session.id,
    ["PostToolUse", "PostToolUseFailure", "PostToolBatch"],
    hookInputs,
  );

  try {
    await session.recover();
    await session.commitMessages({
      role: "user",
      content: "请先启动一个子代理排查，再继续回答。",
    });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      hookService,
      maxTurns: 4,
    });

    await engine.run(session);

    const rejectedReports = reported.filter(
      (result) => result.toolCallId === "call:required-first-rejected",
    );
    assert.equal(rejectedReports.length, 1);
    assert.equal(rejectedReports[0]?.status, "rejected");
    const failureHooks = hookInputs.filter((input) => {
      if (input.hook_event_name !== "PostToolUseFailure") return false;
      const failure = input as HookInput<"PostToolUseFailure">;
      return failure.payload.tool_call_id === "call:required-first-rejected";
    });
    assert.equal(failureHooks.length, 1);
    const rejectedBatches = hookInputs.filter((input) => {
      if (input.hook_event_name !== "PostToolBatch") return false;
      const batch = input as HookInput<"PostToolBatch">;
      return batch.payload.tools.some(
        (tool) => tool.tool_call_id === "call:required-first-rejected",
      );
    });
    assert.equal(rejectedBatches.length, 1);

    const events = await session.runtimeEventStore!.readSession(session.id);
    const rejectedFacts = events.filter(
      (event) =>
        event.kind === "tool.result.recorded" &&
        event.refs.toolCallId === "call:required-first-rejected",
    );
    assert.equal(rejectedFacts.length, 1);
    assert.equal(rejectedFacts[0]?.kind, "tool.result.recorded");
    if (rejectedFacts[0]?.kind === "tool.result.recorded") {
      assert.equal(rejectedFacts[0].data.status, "rejected");
    }
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("post-commit abort still publishes the durable ToolResult hooks once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-post-commit-abort-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-post-commit-abort", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const controller = new AbortController();
  const cancellation = new DOMException("post-commit fixture cancellation", "AbortError");
  const registry = new ToolRegistry();
  registry.register(outputTool("post_commit_fixture", "durable output"));
  let providerTurn = 0;
  const provider: LLMProvider = {
    async generate() {
      providerTurn++;
      if (providerTurn === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:post-commit-abort",
              name: "post_commit_fixture",
              arguments: "{}",
            },
          ],
        };
      }
      return { role: "assistant", content: "unreachable" };
    },
  };
  const reported: ToolResultEnvelope[] = [];
  const reporter = new (class extends SilentReporter {
    override onToolResult(result: ToolResultEnvelope): void {
      reported.push(structuredClone(result));
    }
  })();
  const hookInputs: HookInput[] = [];
  const hookService = recordingHookService(
    workDir,
    session.id,
    ["PostToolUse", "PostToolBatch"],
    hookInputs,
  );

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    const commitMessages = session.commitMessages.bind(session);
    session.commitMessages = async (...messages) => {
      await commitMessages(...messages);
      if (messages.some((message) => message.toolCallId === "call:post-commit-abort")) {
        controller.abort(cancellation);
      }
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      hookService,
      maxTurns: 3,
    });

    await assert.rejects(
      engine.run(session, undefined, undefined, controller.signal),
      (error: unknown) => error === cancellation,
    );

    assert.deepEqual(
      reported.map((result) => result.toolCallId),
      ["call:post-commit-abort"],
    );
    assert.deepEqual(
      hookInputs.map((input) => input.hook_event_name),
      ["PostToolUse", "PostToolBatch"],
    );
    const events = await session.runtimeEventStore!.readSession(session.id);
    assert.equal(
      events.filter(
        (event) =>
          event.kind === "tool.result.recorded" &&
          event.refs.toolCallId === "call:post-commit-abort",
      ).length,
      1,
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

function recordingHookService(
  workDir: string,
  sessionId: string,
  events: readonly PostToolHookEvent[],
  inputs: HookInput[],
): HookService {
  const executor: HookExecutor = {
    async execute(_resolved, input) {
      inputs.push(structuredClone(input));
      return { decision: "allow" };
    },
  };
  return new HookService({
    workDir,
    sessionId,
    executor,
    snapshot: postToolHookSnapshot(events),
  });
}

function postToolHookSnapshot(events: readonly PostToolHookEvent[]): HookSnapshot {
  const selected = new Set<PostToolHookEvent>(events);
  const handlers = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      selected.has(event as PostToolHookEvent) ? [postToolHookHandler(event)] : [],
    ]),
  ) as unknown as HookSnapshot["handlers"];
  return {
    id: "tool-result-reporter-order",
    version: 1,
    createdAt: new Date(0).toISOString(),
    handlers,
    diagnostics: [],
  };
}

function postToolHookHandler(event: (typeof HOOK_EVENTS)[number]): ResolvedHookHandler {
  return {
    id: `fixture:${event}`,
    event,
    source: { kind: "project", path: "/fixture/hooks.json", version: 1 },
    order: 0,
    handler: { type: "command", command: "fixture" },
    trusted: true,
  };
}

function outputTool(name: string, output: string): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => name,
    definition: () => ({
      name,
      description: "Returns one deterministic fixture.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }),
    async execute() {
      return output;
    },
  };
}

function fixtureDefinition(name: string): ToolDefinition {
  return {
    name,
    description: "Deterministic parallel fixture.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  return {
    promise: new Promise<T>((res) => {
      resolve = res;
    }),
    resolve: (value) => resolve(value),
  };
}

async function waitForAbort(signal?: AbortSignal): Promise<never> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  throw new Error("unreachable");
}
