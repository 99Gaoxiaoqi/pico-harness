import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { PICO_TOOL_RESULT_ERROR_KEY, type Message } from "../../src/schema/message.js";
import type {
  RuntimeEvent,
  RuntimeMessageCommittedEvent,
} from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX, RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Registry } from "../../src/tools/registry.js";

describe("RuntimeRun projection recovery", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-run-"));
  });

  afterEach(async () => {
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("repairs a stale Session projection from canonical RuntimeEvents and stays idempotent", async () => {
    const session = new Session("session-a", workDir, { persistence: false });
    await session.recover();
    await session.commitProjectionMessageOnce("stale-message", {
      role: "user",
      content: "stale projection",
    });

    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted(workDir));
    await store.append(message("message-user", { role: "user", content: "canonical prompt" }));
    await store.append(
      message("message-assistant", { role: "assistant", content: "canonical answer" }),
    );

    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      true,
    );
    expect(session.getModelContext()).toEqual([
      { role: "user", content: "canonical prompt" },
      { role: "assistant", content: "canonical answer" },
    ]);
    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      false,
    );

    await session.close();
    const reopened = new Session("session-a", workDir, { persistence: true });
    await reopened.recover();
    expect(reopened.getModelContext()).toEqual([
      { role: "user", content: "canonical prompt" },
      { role: "assistant", content: "canonical answer" },
    ]);
    await reopened.close();
  });

  it("rebuilds usage and records a Session rewind as a canonical history branch", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted(workDir));
    await store.append(message("message-user", { role: "user", content: "canonical prompt" }));
    await store.append(
      message("message-assistant", { role: "assistant", content: "canonical answer" }),
    );
    await store.append({
      ...eventBase("model-settled"),
      kind: "model.call.settled",
      visibility: "internal",
      data: {
        providerCallId: "call-a",
        status: "succeeded",
        latencyMs: 12,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          inputTokens: 8,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          reasoningTokens: 2,
          reportedFields: ["prompt", "completion", "input", "cacheRead", "cacheWrite", "reasoning"],
        },
        costCNY: 0.25,
        costStatus: "estimated",
      },
    });

    await RuntimeRun.repairSessionProjection(session, { workDir, store });
    expect(session.getRuntimeStateSnapshot().usage).toMatchObject({
      totalPromptTokens: 10,
      totalCompletionTokens: 5,
      totalInputTokens: 8,
      totalCacheReadTokens: 1,
      totalCacheWriteTokens: 1,
      totalReasoningTokens: 2,
      totalCostCNY: 0.25,
      totalProviderCalls: 1,
      totalUsageReports: 1,
      totalEstimatedCostReports: 1,
    });

    await session.rewindTo(1);
    const events = await store.readSession(session.id);
    expect(events.some((event) => event.kind === "history.rewound")).toBe(true);
    expect(materializeRuntimeHistory(events)).toEqual([
      { role: "user", content: "canonical prompt" },
    ]);
    expect(session.getModelContext()).toEqual([{ role: "user", content: "canonical prompt" }]);
    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      false,
    );
    await session.close();
  });

  it("writes an exactly-once rewind branch before retrying its Session projection", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted(workDir));
    await store.append(message("message-user", { role: "user", content: "canonical prompt" }));
    await store.append(
      message("message-assistant", { role: "assistant", content: "canonical answer" }),
    );
    await RuntimeRun.repairSessionProjection(session, { workDir, store });

    await session.rewindOnce("stable-operation", 1);
    await session.commitMessages({ role: "user", content: "later message" });
    await session.rewindOnce("stable-operation", 1);

    const events = await store.readSession(session.id);
    const rewinds = events.filter((event) => event.kind === "history.rewound");
    expect(rewinds).toHaveLength(1);
    expect(rewinds[0]?.data).toMatchObject({ branchId: "rewind:stable-operation" });
    expect(materializeRuntimeHistory(events)).toEqual([
      { role: "user", content: "canonical prompt" },
      { role: "user", content: "later message" },
    ]);
    expect(session.getModelContext()).toEqual([
      { role: "user", content: "canonical prompt" },
      { role: "user", content: "later message" },
    ]);
    await session.close();
  });

  it("records Session writes delivered outside a foreground run in canonical history", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const seedRun = await RuntimeRun.start({ sessionId: session.id, workDir, store });
    await seedRun.run(() => session.commitMessages({ role: "user", content: "initial prompt" }));

    await session.commitMessages({
      role: "user",
      content: "background subagent completion",
      providerData: { picoKind: "subagent_completion" },
    });
    const first = await session.commitMessageOnce("completion:stable", {
      role: "user",
      content: "exactly-once completion",
    });
    const retry = await session.commitMessageOnce("completion:stable", {
      role: "user",
      content: "exactly-once completion",
    });

    const events = await store.readSession(session.id);
    expect(events.filter((event) => event.eventId === "completion:stable")).toHaveLength(1);
    expect(events.some((event) => event.kind === "run.started")).toBe(true);
    expect(materializeRuntimeHistory(events)).toEqual(session.getModelContext());
    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      false,
    );
    await session.close();
  });

  it("isolates nested ambient runs for the same sessionId across workspaces", async () => {
    const workDirA = join(workDir, "workspace-a");
    const workDirB = join(workDir, "workspace-b");
    await Promise.all([mkdir(workDirA), mkdir(workDirB)]);
    const sessionId = "same-session";
    const sessionA = new Session(sessionId, workDirA, { persistence: true });
    const sessionB = new Session(sessionId, workDirB, { persistence: true });
    const storeA = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDirA).workspace.runtimeDatabase,
    });
    const storeB = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDirB).workspace.runtimeDatabase,
    });

    try {
      await Promise.all([sessionA.recover(), sessionB.recover()]);
      await Promise.all([
        sessionA.commitMessages({ role: "user", content: "workspace A seed" }),
        sessionB.commitMessages({ role: "user", content: "workspace B seed" }),
      ]);

      const registry = { getAvailableTools: () => [] } as unknown as Registry;
      const nestedInputs: Message[][] = [];
      const nestedProvider: LLMProvider = {
        async generate(messages) {
          nestedInputs.push(structuredClone(messages));
          return {
            role: "assistant",
            content: "workspace B answer",
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      };
      const nestedEngine = new AgentEngine({
        provider: new CostTracker(nestedProvider, "unknown-model", sessionB),
        registry,
        workDir: workDirB,
        systemPrompt: "nested test",
        reporter: new SilentReporter(),
      });
      const outerProvider: LLMProvider = {
        async generate() {
          await sessionB.commitMessages({ role: "user", content: "workspace B nested prompt" });
          await nestedEngine.run(sessionB);
          return {
            role: "assistant",
            content: "workspace A answer",
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      };
      const outerEngine = new AgentEngine({
        provider: new CostTracker(outerProvider, "unknown-model", sessionA),
        registry,
        workDir: workDirA,
        systemPrompt: "outer test",
        reporter: new SilentReporter(),
      });

      await sessionA.commitMessages({ role: "user", content: "workspace A outer prompt" });
      await outerEngine.run(sessionA);

      expect(nestedInputs).toHaveLength(1);
      expect(nestedInputs[0]?.map((message) => message.content)).toEqual(
        expect.arrayContaining(["workspace B seed", "workspace B nested prompt"]),
      );
      expect(nestedInputs[0]?.some((message) => message.content.includes("workspace A"))).toBe(
        false,
      );
      expect(sessionA.getModelContext().map((message) => message.content)).toEqual([
        "workspace A seed",
        "workspace A outer prompt",
        "workspace A answer",
      ]);
      expect(sessionB.getModelContext().map((message) => message.content)).toEqual([
        "workspace B seed",
        "workspace B nested prompt",
        "workspace B answer",
      ]);
      const eventsA = await storeA.readSession(sessionId);
      const eventsB = await storeB.readSession(sessionId);
      expect(materializeRuntimeHistory(eventsA).map((message) => message.content)).toEqual([
        "workspace A seed",
        "workspace A outer prompt",
        "workspace A answer",
      ]);
      expect(materializeRuntimeHistory(eventsB).map((message) => message.content)).toEqual([
        "workspace B seed",
        "workspace B nested prompt",
        "workspace B answer",
      ]);
      expect(
        new Set(
          eventsA
            .filter((event) => event.kind === "run.started")
            .map((event) => event.data.workDir),
        ),
      ).toEqual(new Set([workDirA]));
      expect(
        new Set(
          eventsB
            .filter((event) => event.kind === "run.started")
            .map((event) => event.data.workDir),
        ),
      ).toEqual(new Set([workDirB]));
      expect(eventsA.filter((event) => event.kind === "model.call.started")).toHaveLength(1);
      expect(eventsB.filter((event) => event.kind === "model.call.started")).toHaveLength(1);
    } finally {
      await Promise.allSettled([sessionA.close(), sessionB.close()]);
      await Promise.all([
        rm(resolvePicoPaths(workDirA).workspace.root, { recursive: true, force: true }),
        rm(resolvePicoPaths(workDirB).workspace.root, { recursive: true, force: true }),
      ]);
    }
  });

  it("never lets an in-memory Session inherit a matching ambient run", async () => {
    const sessionId = "same-session";
    const session = new Session(sessionId, workDir, { persistence: false });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const run = await RuntimeRun.start({ sessionId, workDir, store });
    let providerCalls = 0;
    const provider: LLMProvider = {
      async generate() {
        providerCalls++;
        return { role: "assistant", content: "must not run" };
      },
    };
    const registry = { getAvailableTools: () => [] } as unknown as Registry;
    const engine = new AgentEngine({ provider, registry, workDir });

    try {
      await run.run(async () => {
        await expect(engine.run(session)).rejects.toThrow(
          "cannot run inside another RuntimeRun capability",
        );
      });

      expect(providerCalls).toBe(0);
      expect((await store.readSession(sessionId)).map((event) => event.kind)).toEqual([
        "run.started",
        "run.terminal",
      ]);
    } finally {
      await session.close();
    }
  });

  it("routes a matching Session away from an ambient run backed by another store", async () => {
    const sessionId = "same-session";
    const session = new Session(sessionId, workDir, { persistence: true });
    await session.recover();
    const alternateStore = new RuntimeEventStore({
      databasePath: join(workDir, "alternate-runtime.sqlite"),
    });
    const ambientRun = await RuntimeRun.start({
      sessionId,
      workDir,
      store: alternateStore,
    });

    try {
      expect(ambientRun.claimsSession(session)).toBe(false);
      await ambientRun.run(() =>
        session.commitMessages({ role: "user", content: "canonical store only" }),
      );

      expect(materializeRuntimeHistory(await alternateStore.readSession(sessionId))).toEqual([]);
      const canonicalStore = new RuntimeEventStore({
        databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
      });
      expect(materializeRuntimeHistory(await canonicalStore.readSession(sessionId))).toEqual([
        { role: "user", content: "canonical store only" },
      ]);
    } finally {
      await session.close();
    }
  });

  it("canonicalizes undefined provider fields before exactly-once comparison", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const run = await RuntimeRun.start({ sessionId: session.id, workDir, store });
    await run.run(async () => undefined);
    const messageWithUndefined = {
      role: "assistant" as const,
      content: "canonical answer",
      providerData: { model: "test-model", omitted: undefined },
    };

    const first = await session.commitMessageOnce("message:stable", messageWithUndefined);
    const retry = await session.commitMessageOnce("message:stable", messageWithUndefined);

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(session.getModelContext()).toEqual([
      {
        role: "assistant",
        content: "canonical answer",
        providerData: { model: "test-model" },
      },
    ]);
    await session.close();

    const reopened = new Session("session-a", workDir, { persistence: true });
    await reopened.recover();
    expect(reopened.getModelContext()).toEqual([
      {
        role: "assistant",
        content: "canonical answer",
        providerData: { model: "test-model" },
      },
    ]);
    await reopened.close();
  });

  it("does not expose part of a message batch when a later insert fails", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const run = await RuntimeRun.start({ sessionId: session.id, workDir, store });
    const database = new Database(store.databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_second_runtime_message
        BEFORE INSERT ON agent_runtime_events
        WHEN NEW.kind = 'message.committed'
          AND json_extract(NEW.event_json, '$.data.message.content') = 'second message'
        BEGIN
          SELECT RAISE(ABORT, 'injected message batch failure');
        END;`);
    } finally {
      database.close();
    }

    await expect(
      run.commitMessages(session, [
        { role: "user", content: "first message" },
        { role: "assistant", content: "second message" },
      ]),
    ).rejects.toThrow("injected message batch failure");

    const events = await store.readRun(session.id, run.runId);
    expect(events.filter((event) => event.kind === "message.committed")).toEqual([]);
    expect(materializeRuntimeHistory(events)).toEqual([]);
    expect(session.getModelContext()).toEqual([]);
    await session.close();
  });

  it("closes an unterminated canonical run as interrupted during recovery", async () => {
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: "session-a", workDir });
    await store.append(runStarted(workDir));

    await expect(
      RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
    ).resolves.toEqual(["run-a"]);
    const terminal = (await store.readRun("session-a", "run-a")).at(-1);
    expect(terminal).toMatchObject({
      kind: "run.terminal",
      data: {
        status: "interrupted",
        reason: "recovered_without_terminal_fact",
        recovered: true,
      },
    });
  });

  it("closes only dangling tool calls before interrupting a durable run", async () => {
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: "session-a", workDir });
    await store.appendBatch([
      runStarted(workDir),
      message("message-user", { role: "user", content: "run both tools" }),
      {
        ...eventBase("message-assistant"),
        turnId: "turn-tools",
        refs: {
          stepId: "step-tools",
          parentRunId: "parent-run",
          parentToolCallId: "parent-call",
        },
        kind: "message.committed",
        data: {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call-complete", name: "read", arguments: "{}" },
              { id: "call-dangling", name: "write", arguments: "{}" },
            ],
          },
        },
      },
      {
        ...eventBase("message-result"),
        turnId: "turn-tools",
        refs: { stepId: "step-tools", toolCallId: "call-complete" },
        kind: "message.committed",
        data: {
          message: {
            role: "user",
            content: "real result",
            toolCallId: "call-complete",
            providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: false },
          },
        },
      },
    ]);

    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const incompleteEvents = await store.readSession("session-a");
    expect(() => materializeRuntimeHistory(incompleteEvents)).toThrow();

    await expect(
      RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
    ).resolves.toEqual(["run-a"]);

    const recovered = await store.readRun("session-a", "run-a");
    const synthetic = recovered.filter(
      (event): event is RuntimeMessageCommittedEvent =>
        event.kind === "message.committed" &&
        event.data.message.providerData?.["picoKind"] === "synthetic_tool_result",
    );
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({
      eventId: expect.stringMatching(/^runtime-recovery:tool-result:/u),
      turnId: "turn-tools",
      at: "2026-07-15T00:00:00.000Z",
      refs: {
        stepId: "step-tools",
        parentRunId: "parent-run",
        parentToolCallId: "parent-call",
        toolCallId: "call-dangling",
      },
      data: {
        message: {
          role: "user",
          toolCallId: "call-dangling",
          providerData: {
            [PICO_TOOL_RESULT_ERROR_KEY]: true,
            picoKind: "synthetic_tool_result",
            picoToolResultStatus: "interrupted",
          },
        },
      },
    });
    expect(
      recovered.filter(
        (event) =>
          event.kind === "message.committed" && event.data.message.toolCallId === "call-complete",
      ),
    ).toHaveLength(1);
    expect(recovered.at(-1)).toMatchObject({
      eventId: expect.stringMatching(/^runtime-recovery:terminal:/u),
      kind: "run.terminal",
      data: { status: "interrupted", recovered: true },
    });

    const strictHistory = materializeRuntimeHistory(await store.readSession("session-a"));
    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      true,
    );
    expect(session.getModelContext()).toEqual(strictHistory);

    await expect(
      RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
    ).resolves.toEqual([]);
    expect(await store.readRun("session-a", "run-a")).toEqual(recovered);
    await session.close();
  });

  it.each(["failed", "cancelled"] as const)(
    "repairs a dangling tool result behind an existing %s terminal without replacing it",
    async (status) => {
      const store = new RuntimeEventStore({
        databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
      });
      await store.initializeSession({ sessionId: "session-a", workDir });
      const existingTerminal: RuntimeEvent = {
        ...eventBase(`terminal-${status}`),
        at: "2026-07-15T00:00:01.000Z",
        visibility: "internal",
        kind: "run.terminal",
        data: { status, reason: "injected observation batch failure" },
      };
      await store.appendBatch([
        runStarted(workDir),
        {
          ...eventBase("message-assistant"),
          turnId: "turn-tools",
          refs: { stepId: "step-tools" },
          kind: "message.committed",
          data: {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "call-persisted", name: "read", arguments: "{}" },
                { id: "call-missing", name: "write", arguments: "{}" },
              ],
            },
          },
        },
        {
          ...eventBase("message-result"),
          turnId: "turn-tools",
          refs: { stepId: "step-tools", toolCallId: "call-persisted" },
          kind: "message.committed",
          data: {
            message: {
              role: "user",
              content: "real result",
              toolCallId: "call-persisted",
              providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: false },
            },
          },
        },
      ]);
      const database = new Database(store.databasePath);
      try {
        database.exec(`CREATE TRIGGER fail_missing_tool_result
          BEFORE INSERT ON agent_runtime_events
          WHEN NEW.event_id = 'message-result-missing'
          BEGIN
            SELECT RAISE(ABORT, 'injected observation batch failure');
          END;`);
      } finally {
        database.close();
      }
      await expect(
        store.append({
          ...eventBase("message-result-missing"),
          turnId: "turn-tools",
          refs: { stepId: "step-tools", toolCallId: "call-missing" },
          kind: "message.committed",
          data: {
            message: {
              role: "user",
              content: "missing result",
              toolCallId: "call-missing",
              providerData: { [PICO_TOOL_RESULT_ERROR_KEY]: false },
            },
          },
        }),
      ).rejects.toThrow("injected observation batch failure");
      await store.append(existingTerminal);
      const incomplete = await store.readSession("session-a");
      expect(() => materializeRuntimeHistory(incomplete)).toThrow();

      await expect(
        RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
      ).resolves.toEqual(["run-a"]);

      const recovered = await store.readRun("session-a", "run-a");
      const synthetic = recovered.filter(
        (event): event is RuntimeMessageCommittedEvent =>
          event.kind === "message.committed" &&
          event.data.message.providerData?.["picoKind"] === "synthetic_tool_result",
      );
      expect(synthetic).toHaveLength(1);
      expect(synthetic[0]).toMatchObject({
        at: existingTerminal.at,
        turnId: "turn-tools",
        refs: { stepId: "step-tools", toolCallId: "call-missing" },
        data: { message: { toolCallId: "call-missing" } },
      });
      expect(recovered.filter((event) => event.kind === "run.terminal")).toEqual([
        existingTerminal,
      ]);
      expect(() => materializeRuntimeHistory(recovered)).not.toThrow();

      await expect(
        RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
      ).resolves.toEqual([]);
      expect(await store.readRun("session-a", "run-a")).toEqual(recovered);
    },
  );

  it("continues to skip unterminated fork bootstrap runs", async () => {
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    await store.initializeSession({ sessionId: "session-a", workDir });
    const runId = `${RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX}seed`;
    const started = { ...runStarted(workDir), runId };
    await store.append(started);

    await expect(
      RuntimeRun.reconcileIncompleteRuns({ sessionId: "session-a", workDir, store }),
    ).resolves.toEqual([]);
    expect(await store.readRun("session-a", runId)).toEqual([started]);
  });
});

function runStarted(workDir: string): RuntimeEvent {
  return {
    ...eventBase("run-started"),
    kind: "run.started",
    data: { workDir },
  };
}

function message(eventId: string, value: Message): RuntimeMessageCommittedEvent {
  return {
    ...eventBase(eventId),
    kind: "message.committed",
    data: { message: value },
  };
}

function eventBase(eventId: string) {
  return {
    schemaVersion: 1 as const,
    eventId,
    sessionId: "session-a",
    invocationId: "invocation-a",
    runId: "run-a",
    turnId: "turn-a",
    at: "2026-07-15T00:00:00.000Z",
    partial: false,
    visibility: "model" as const,
  };
}
