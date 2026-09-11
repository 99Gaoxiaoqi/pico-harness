import assert from "node:assert/strict";
import { test } from "node:test";
import { isHardDiagnostic } from "../../../src/engine/runtime-projection-diagnostics.js";
import {
  materializeRuntimeHistoryProjection,
  RuntimeEventReadModelIntegrityError,
} from "../../../src/engine/session-runtime-read-model.js";
import type { RuntimeEvent } from "../../../src/engine/session-runtime-event.js";

function makeEvent(
  overrides: Record<string, unknown> & { kind: string; eventId: string },
): RuntimeEvent {
  return {
    schemaVersion: 2,
    sessionId: "session-1",
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
    at: "2026-08-10T00:00:00.000Z",
    partial: false,
    visibility: "model",
    ...overrides,
  } as unknown as RuntimeEvent;
}

test("投影诊断：控制事实产 soft 诊断，不阻断投影", () => {
  const events: RuntimeEvent[] = [
    makeEvent({ kind: "run.started", eventId: "e1", data: { workDir: "/tmp" } }),
    makeEvent({
      kind: "message.committed",
      eventId: "e2",
      data: { message: { role: "user", content: "hello" } },
    }),
    makeEvent({ kind: "run.terminal", eventId: "e3", data: { status: "completed" } }),
  ];

  const { entries, diagnostics } = materializeRuntimeHistoryProjection(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.eventId, "e2");
  assert.ok(diagnostics.filter((item) => !isHardDiagnostic(item)).length >= 2);
  assert.equal(diagnostics.filter((item) => item.code === "unclaimed_control_fact").length, 2);
});

test("投影诊断：partial 消息事件产 soft partial_event_skipped", () => {
  const events: RuntimeEvent[] = [
    makeEvent({
      kind: "message.committed",
      eventId: "e1",
      partial: true,
      data: { message: { role: "user", content: "partial" } },
    }),
  ];

  const { entries, diagnostics } = materializeRuntimeHistoryProjection(events);
  assert.equal(entries.length, 0);
  assert.equal(diagnostics.filter((item) => item.code === "partial_event_skipped").length, 1);
});

test("投影诊断：所有 plan 生命周期 kind 都 claim 为 control，不 throw", () => {
  const planKinds = [
    "plan.proposed",
    "plan.revised",
    "plan.revision.requested",
    "plan.approved",
    "plan.rejected",
    "plan.execution.started",
    "plan.step.updated",
    "plan.execution.completed",
    "plan.execution.cancelled",
    "plan.execution.interrupted",
    "plan.execution.resumed",
    "plan.execution.replanned",
  ];
  const events = planKinds.map((kind, index) =>
    makeEvent({ kind, eventId: `plan-${index}`, data: {} }),
  ) as unknown as RuntimeEvent[];

  const { diagnostics } = materializeRuntimeHistoryProjection(events);
  assert.equal(
    diagnostics.filter((item) => item.code === "unclaimed_control_fact").length,
    planKinds.length,
  );
});

test("投影诊断：未知 kind（含 discovery.*）纵深防御 hard throw", () => {
  const events = [
    makeEvent({ kind: "discovery.started", eventId: "d1", data: {} }),
  ] as unknown as RuntimeEvent[];
  assert.throws(
    () => materializeRuntimeHistoryProjection(events),
    RuntimeEventReadModelIntegrityError,
  );
});

test("投影诊断：重复 eventId 仍 throw（hard fail-closed 不变）", () => {
  const events: RuntimeEvent[] = [
    makeEvent({
      kind: "message.committed",
      eventId: "dup",
      data: { message: { role: "user", content: "a" } },
    }),
    makeEvent({
      kind: "message.committed",
      eventId: "dup",
      data: { message: { role: "user", content: "b" } },
    }),
  ];
  assert.throws(
    () => materializeRuntimeHistoryProjection(events),
    RuntimeEventReadModelIntegrityError,
  );
});

test("adversarial: 无 throughEventId 的 rewound 产 soft 诊断，不与空输入混淆", () => {
  const events = [
    makeEvent({
      kind: "message.committed",
      eventId: "e1",
      data: { message: { role: "user", content: "hello" } },
    }),
    makeEvent({ kind: "history.rewound" as string, eventId: "e2", data: {} }),
  ] as unknown as RuntimeEvent[];

  const { entries, diagnostics } = materializeRuntimeHistoryProjection(events);
  assert.equal(entries.length, 1);
  assert.ok(diagnostics.some((item) => item.code === "unclaimed_control_fact"));
});
