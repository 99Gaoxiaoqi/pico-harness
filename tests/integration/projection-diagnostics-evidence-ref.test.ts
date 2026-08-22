import assert from "node:assert/strict";
import { test } from "node:test";
import {
  materializeRuntimeHistoryProjection,
  RuntimeEventReadModelIntegrityError,
} from "../../src/engine/session-runtime-read-model.js";
import { isHardDiagnostic } from "../../src/engine/runtime-projection-diagnostics.js";
import {
  EVIDENCE_REF_SCHEMA_VERSION,
  validateEvidenceRef,
  compareCursors,
  type EvidenceRef,
} from "../../src/engine/evidence-ref.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";

/** 构造最小合法 RuntimeEvent 的 helper。用 unknown 中间类型绕过 kind/data 联合约束。 */
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
  ] as RuntimeEvent[];

  const { entries, diagnostics } = materializeRuntimeHistoryProjection(events);

  // 只有一条 message.committed 产出行
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.eventId, "e2");

  // run.started 和 run.terminal 是控制事实 → soft 诊断
  const softCodes = diagnostics.filter((d) => !isHardDiagnostic(d)).map((d) => d.code);
  assert.ok(softCodes.includes("unclaimed_control_fact"));
  // 每个控制事件一条诊断
  const controlDiags = diagnostics.filter((d) => d.code === "unclaimed_control_fact");
  assert.equal(controlDiags.length, 2);
});

test("投影诊断：partial 消息事件产 soft partial_event_skipped", () => {
  const events: RuntimeEvent[] = [
    makeEvent({
      kind: "message.committed",
      eventId: "e1",
      partial: true,
      data: { message: { role: "user", content: "partial" } },
    }),
  ] as RuntimeEvent[];

  const { entries, diagnostics } = materializeRuntimeHistoryProjection(events);

  assert.equal(entries.length, 0);
  const partialDiags = diagnostics.filter((d) => d.code === "partial_event_skipped");
  assert.equal(partialDiags.length, 1);
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
  const events = planKinds.map((kind, i) =>
    makeEvent({ kind, eventId: `plan-${i}`, data: {} }),
  ) as unknown as RuntimeEvent[];

  // 不应 throw——所有 plan kind 都应被 claim 为 control
  const { diagnostics } = materializeRuntimeHistoryProjection(events);
  const controlDiags = diagnostics.filter((d) => d.code === "unclaimed_control_fact");
  assert.equal(controlDiags.length, planKinds.length);
});

test("投影诊断：未知 kind（含 discovery.*）纵深防御 hard throw", () => {
  const events = [
    makeEvent({ kind: "discovery.started", eventId: "d1", data: {} }),
  ] as unknown as RuntimeEvent[];

  // discovery.* 已不兼容，投影层应 hard throw（纵深防御）
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
  ] as RuntimeEvent[];

  assert.throws(
    () => materializeRuntimeHistoryProjection(events),
    RuntimeEventReadModelIntegrityError,
  );
});

test("EvidenceRef validator：合法 ref 通过", () => {
  const ref: EvidenceRef = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "session-1",
    runId: "run-1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "run-1",
      lowSequence: 0,
      highSequence: 5,
      eventIds: ["evt-1"],
      eventCount: 1,
    },
    digest: "sha256:abc123",
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, true);
});

test("EvidenceRef validator：coverage.streamId 不匹配 runId 时拒绝", () => {
  const ref: EvidenceRef = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "session-1",
    runId: "run-1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "wrong-run",
      highSequence: 5,
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "coverage_stream_id_mismatch");
  }
});

test("EvidenceRef validator：coverage.streamId 可绑定到 sessionId", () => {
  const ref: EvidenceRef = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "session-1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "session-1",
      highSequence: 3,
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, true);
});

test("EvidenceRef validator：lowSequence > highSequence 拒绝", () => {
  const ref: EvidenceRef = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "session-1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "session-1",
      lowSequence: 10,
      highSequence: 5,
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "coverage_sequence_inverted");
  }
});

test("EvidenceRef validator：缺失 sessionId 拒绝", () => {
  const ref = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    coverage: {
      ledger: "session_runtime_event" as const,
      streamId: "run-1",
      highSequence: 1,
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "missing_session_lane");
  }
});

test("compareCursors：同流按 highSequence 排序", () => {
  const left = { ledger: "session_runtime_event" as const, streamId: "run-1", highSequence: 3 };
  const right = { ledger: "session_runtime_event" as const, streamId: "run-1", highSequence: 5 };
  assert.equal(compareCursors(left, right), "before");
  assert.equal(compareCursors(right, left), "after");
  assert.equal(compareCursors(left, left), "equal");
});

test("compareCursors：不同流返回 incomparable", () => {
  const left = { ledger: "session_runtime_event" as const, streamId: "run-1", highSequence: 3 };
  const right = { ledger: "session_runtime_event" as const, streamId: "run-2", highSequence: 3 };
  assert.equal(compareCursors(left, right), "incomparable");
});

test("compareCursors：同序号不同 eventId 返回 conflict", () => {
  const left = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["evt-a"],
  };
  const right = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["evt-b"],
  };
  assert.equal(compareCursors(left, right), "conflict");
});

// ============ adversarial 边界 case ============

test("adversarial: validator 拒绝数字类型的 runId（类型混淆）", () => {
  const ref = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "s1",
    runId: 123,
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_optional_field_type");
});

test("adversarial: validator 拒绝 coverage 空对象，用正确诊断码", () => {
  const ref = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "s1",
    coverage: {},
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_coverage_shape");
});

test("adversarial: validator 拒绝 eventIds 空数组", () => {
  const ref = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "s1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "s1",
      highSequence: 0,
      eventIds: [],
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "empty_event_ids");
});

test("adversarial: validator 拒绝 eventCount=0", () => {
  const ref = {
    schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
    sessionId: "s1",
    coverage: {
      ledger: "session_runtime_event",
      streamId: "s1",
      highSequence: 0,
      eventCount: 0,
    },
  };
  const result = validateEvidenceRef(ref);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "zero_event_count");
});

test("adversarial: validator 拒绝 null 输入", () => {
  const result = validateEvidenceRef(null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "missing_schema_version");
});

test("adversarial: compareCursors 长度不同但首元素相同 → conflict", () => {
  const left = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["evt-a"],
  };
  const right = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["evt-a", "evt-b"],
  };
  assert.equal(compareCursors(left, right), "conflict");
});

test("adversarial: compareCursors 长度相同首元素相同但后续不同 → conflict", () => {
  const left = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["a", "b"],
  };
  const right = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["a", "c"],
  };
  assert.equal(compareCursors(left, right), "conflict");
});

test("adversarial: compareCursors 两个元素完全相同 → equal", () => {
  const left = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["a", "b"],
  };
  const right = {
    ledger: "session_runtime_event" as const,
    streamId: "run-1",
    highSequence: 3,
    eventIds: ["a", "b"],
  };
  assert.equal(compareCursors(left, right), "equal");
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
  // rewound 截断语义已随破坏性 rewind 一并删除（d4f15ebe，rewind 现为非破坏性 fork）：
  // rewound 前的 message.committed 正常投影，不再被清空。
  assert.equal(entries.length, 1);
  // rewound 产 soft 诊断——与空输入（diagnostics=[]）可区分
  const rewoundDiags = diagnostics.filter((d) => d.code === "unclaimed_control_fact");
  assert.ok(rewoundDiags.length > 0);
});
