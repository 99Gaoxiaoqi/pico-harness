/** Severity of a RuntimeEvent projection diagnostic. */
export type DiagnosticSeverity = "hard" | "soft";

export type RuntimeProjectionDiagnosticCode =
  | "duplicate_event_id"
  | "rewind_unknown_target"
  | "tool_call_pairing_violation"
  | "checkpoint_digest_mismatch"
  | "incomplete_message_event"
  | "partial_event_skipped"
  | "unclaimed_control_fact"
  | "unsupported_event_kind";

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

export function isHardDiagnostic(diagnostic: RuntimeProjectionDiagnostic): boolean {
  return diagnostic.severity === "hard";
}

export function makeDiagnostic(
  code: RuntimeProjectionDiagnosticCode,
  eventId: string,
  detail?: string,
): RuntimeProjectionDiagnostic {
  return {
    code,
    severity: severityFor(code),
    eventId,
    ...(detail !== undefined ? { detail } : {}),
  };
}
