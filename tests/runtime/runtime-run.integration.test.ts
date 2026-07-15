import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";

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
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    await session.commitProjectionMessageOnce("stale-message", {
      role: "user",
      content: "stale projection",
    });

    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted());
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
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted());
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
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    await store.initializeSession({ sessionId: session.id, workDir });
    await store.append(runStarted());
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
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
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

  it("closes an unterminated canonical run as interrupted during recovery", async () => {
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    await store.initializeSession({ sessionId: "session-a", workDir });
    await store.append(runStarted());

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
});

function runStarted(): RuntimeEvent {
  return {
    ...eventBase("run-started"),
    kind: "run.started",
    data: { workDir: "/workspace" },
  };
}

function message(
  eventId: string,
  value: { role: "user" | "assistant"; content: string },
): RuntimeEvent {
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
