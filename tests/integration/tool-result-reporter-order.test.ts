import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import type { ToolResultEnvelope } from "../../src/engine/tool-result-contract.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/runtime/runtime-event.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import { ToolAccesses } from "../../src/tools/tool-access.js";
import {
  NO_FILE_SIDE_EFFECTS,
  type BaseTool,
  type Registry,
  type ToolExecutionContext,
} from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

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
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
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
          { id: "call:fast", name: "fast_fixture", arguments: "{}" },
          { id: "call:slow", name: "slow_fixture", arguments: "{}" },
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

  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run both fixtures." });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
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
        { toolCallId: "call:fast", status: "succeeded", mode: "full" },
        { toolCallId: "call:slow", status: "cancelled", mode: "synthetic" },
      ],
    );
    const history = materializeRuntimeHistory(events);
    assert.deepEqual(
      history.filter((message) => message.toolCallId).map((message) => message.toolCallId),
      ["call:fast", "call:slow"],
    );
  } finally {
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
  const reporter = new (class extends SilentReporter {
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
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
