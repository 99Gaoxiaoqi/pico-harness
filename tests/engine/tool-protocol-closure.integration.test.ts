import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../../src/approval/manager.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { ToolAccesses } from "../../src/tools/tool-access.js";
import type {
  BaseTool,
  Registry,
  ToolExecutionContext,
  ToolFileSideEffects,
} from "../../src/tools/registry.js";

describe("AgentEngine durable tool protocol closure", () => {
  let workDir: string;
  const sessions = new Set<Session>();

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-tool-protocol-"));
  });

  afterEach(async () => {
    await Promise.allSettled([...sessions].map((session) => session.close()));
    sessions.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("调度前取消时为每个 callId 写入 synthetic cancelled observation", async () => {
    const controller = new AbortController();
    let boundaryCount = 0;
    const registry = new TestRegistry(async (call) => ({
      toolCallId: call.id,
      output: "must-not-run",
      isError: false,
    }));
    const session = await createSession("cancel-before-dispatch");
    const engine = new AgentEngine({
      provider: new ScriptedProvider([toolResponse("call-1", "call-2")]),
      registry,
      workDir,
      waitAtSafeBoundary: async () => {
        boundaryCount++;
        if (boundaryCount === 2) {
          controller.abort(new DOMException("cancel before dispatch", "AbortError"));
        }
      },
    });

    await expect(
      engine.run(session, undefined, undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(registry.executed).toEqual([]);
    const history = await readStrictHistory(session.id);
    expectToolObservations(history, [
      { id: "call-1", status: "cancelled" },
      { id: "call-2", status: "cancelled" },
    ]);

    await session.close();
    const reopened = await recoverSession(session.id);
    expect(reopened.getModelContext()).toEqual(history);
  });

  it("部分工具已完成且审批等待被中止时保留真实结果，不执行待审批副作用", async () => {
    const controller = new AbortController();
    const approvalManager = new ApprovalManager(60_000);
    const approvalStarted = deferred();
    let completedSideEffects = 0;
    const registry = new TestRegistry(
      async (call, context) => {
        if (call.id === "completed") {
          completedSideEffects++;
          return { toolCallId: call.id, output: "real-completed-result", isError: false };
        }

        approvalStarted.resolve();
        const approval = await approvalManager.waitForApproval(
          "approval-waiting",
          call.name,
          call.arguments,
          () => undefined,
          undefined,
          context?.signal,
        );
        if (approval.allowed) completedSideEffects++;
        return {
          toolCallId: call.id,
          output: approval.allowed ? "approved-result" : approval.reason,
          isError: !approval.allowed,
        };
      },
      { kind: "workspace" },
    );
    const session = await createSession("cancel-during-approval");
    const engine = new AgentEngine({
      provider: new ScriptedProvider([toolResponse("completed", "approval")]),
      registry,
      workDir,
    });

    const run = engine.run(session, undefined, undefined, controller.signal);
    await approvalStarted.promise;
    controller.abort(new DOMException("cancel approval", "AbortError"));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });

    expect(approvalManager.pendingCount).toBe(0);
    expect(completedSideEffects).toBe(1);
    expect(registry.executed).toEqual(["completed", "approval"]);
    const history = await readStrictHistory(session.id);
    const observations = history.filter((message) => message.toolCallId !== undefined);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      toolCallId: "completed",
      content: "real-completed-result",
      providerData: { picoToolResultIsError: false },
    });
    expect(observations[1]).toMatchObject({
      toolCallId: "approval",
      providerData: {
        picoToolResultIsError: true,
        picoKind: "synthetic_tool_result",
        picoToolResultStatus: "cancelled",
      },
    });
  });

  it("调度前普通异常也闭合为 synthetic failed observation", async () => {
    let boundaryCount = 0;
    const registry = new TestRegistry(async (call) => ({
      toolCallId: call.id,
      output: "must-not-run",
      isError: false,
    }));
    const session = await createSession("failure-before-dispatch");
    const engine = new AgentEngine({
      provider: new ScriptedProvider([toolResponse("failed-call")]),
      registry,
      workDir,
      waitAtSafeBoundary: async () => {
        boundaryCount++;
        if (boundaryCount === 2) throw new Error("pause gate failed");
      },
    });

    await expect(engine.run(session)).rejects.toThrow("pause gate failed");

    expect(registry.executed).toEqual([]);
    const history = await readStrictHistory(session.id);
    expectToolObservations(history, [{ id: "failed-call", status: "failed" }]);
  });

  async function createSession(sessionId: string): Promise<Session> {
    const session = await recoverSession(sessionId);
    await session.commitMessages({ role: "user", content: "run the tools" });
    return session;
  }

  async function recoverSession(sessionId: string): Promise<Session> {
    const session = new Session(sessionId, workDir, { persistence: true });
    sessions.add(session);
    await session.recover();
    return session;
  }

  async function readStrictHistory(sessionId: string): Promise<Message[]> {
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    return materializeRuntimeHistory(await store.readSession(sessionId));
  }
});

class ScriptedProvider implements LLMProvider {
  private index = 0;

  constructor(private readonly responses: readonly Message[]) {}

  async generate(): Promise<Message> {
    const response = this.responses[this.index++];
    if (!response) throw new Error("ScriptedProvider response exhausted");
    return response;
  }
}

class TestRegistry implements Registry {
  readonly executed: string[] = [];

  constructor(
    private readonly executor: (
      call: ToolCall,
      context?: ToolExecutionContext,
    ) => Promise<ToolResult>,
    private readonly fileSideEffects: ToolFileSideEffects = { kind: "none" },
  ) {}

  register(_tool: BaseTool): void {}
  use(): void {}

  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "probe",
        description: "test probe",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    this.executed.push(call.id);
    return this.executor(call, context);
  }

  getAccesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  getFileSideEffects(): ToolFileSideEffects {
    return this.fileSideEffects;
  }
}

function toolResponse(...ids: string[]): Message {
  return {
    role: "assistant",
    content: "running tools",
    toolCalls: ids.map((id) => ({ id, name: "probe", arguments: "{}" })),
  };
}

function expectToolObservations(
  history: readonly Message[],
  expected: readonly { id: string; status: "cancelled" | "failed" }[],
): void {
  const observations = history.filter((message) => message.toolCallId !== undefined);
  expect(observations).toHaveLength(expected.length);
  expect(
    observations.map((message) => ({
      id: message.toolCallId,
      error: message.providerData?.["picoToolResultIsError"],
      kind: message.providerData?.["picoKind"],
      status: message.providerData?.["picoToolResultStatus"],
    })),
  ).toEqual(
    expected.map(({ id, status }) => ({
      id,
      error: true,
      kind: "synthetic_tool_result",
      status,
    })),
  );
  for (const { id } of expected) {
    expect(observations.filter((message) => message.toolCallId === id)).toHaveLength(1);
  }
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
