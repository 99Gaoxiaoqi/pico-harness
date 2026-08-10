/**
 * RuntimeEvent 投影诊断分级。
 *
 * 当前投影层（session-runtime-read-model.ts）是二分世界：全 throw（配对错位/digest 不符）
 * 或 select() 静默过滤（非消息 kind 天然掉入过滤集）。二分太粗：真正"可能丢用户可见内容"
 * 的情况（hard）和"控制事实无 chat 行是正常的"（soft）无法区分。
 *
 * 参考 maka 投影的 claim coverage 契约：每个可见 kind 都必须显式 claim，落空时分
 * unsupported_event（hard）/ unclaimed_control_fact（soft）。关键不变量：覆盖契约与
 * severity 解耦——软化 severity 不会软化覆盖契约。
 *
 * hard = 可能丢用户可见内容，投影不忠实，禁止对外服务（仍 throw，fail-closed 不变）。
 * soft = 安全降级，投影忠实，但发生了值得记录的事件。
 */

export type DiagnosticSeverity = "hard" | "soft";

export type RuntimeProjectionDiagnosticCode =
  | "duplicate_event_id" // hard
  | "rewind_unknown_target" // hard
  | "tool_call_pairing_violation" // hard
  | "checkpoint_digest_mismatch" // hard
  | "incomplete_message_event" // hard（message.committed/tool.result.recorded 无 projection）
  | "partial_event_skipped" // soft（partial RuntimeEvent 跳过）
  | "unclaimed_control_fact" // soft（控制事件无 chat 行，正常）
  | "unsupported_event_kind"; // hard（未知 kind，防静默丢失——纵深防御）

export interface RuntimeProjectionDiagnostic {
  readonly code: RuntimeProjectionDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly eventId: string;
  readonly detail?: string;
}

const SEVERITY_BY_CODE: Record<RuntimeProjectionDiagnosticCode, DiagnosticSeverity> = {
  duplicate_event_id: "hard",
  rewind_unknown_target: "hard",
  tool_call_pairing_violation: "hard",
  checkpoint_digest_mismatch: "hard",
  incomplete_message_event: "hard",
  partial_event_skipped: "soft",
  unclaimed_control_fact: "soft",
  unsupported_event_kind: "hard",
};

export function severityFor(code: RuntimeProjectionDiagnosticCode): DiagnosticSeverity {
  return SEVERITY_BY_CODE[code];
}

export function isHardDiagnostic(d: RuntimeProjectionDiagnostic): boolean {
  return d.severity === "hard";
}

export function makeDiagnostic(
  code: RuntimeProjectionDiagnosticCode,
  eventId: string,
  detail?: string,
): RuntimeProjectionDiagnostic {
  return { code, severity: severityFor(code), eventId, detail };
}
