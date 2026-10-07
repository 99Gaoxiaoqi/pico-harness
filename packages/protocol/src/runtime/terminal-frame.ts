import { isJsonObject } from "./base.js";

/** Live attachment events. Recovery uses terminal.attach, not durable notifications. */
export const TERMINAL_STREAM_RUNTIME_CAPABILITY = "terminal-stream-v1";

export type RuntimeTerminalFrame = {
  readonly type: "terminal.event";
  readonly terminalId: string;
  readonly sessionId: string;
  readonly resourceEpoch: string;
  readonly sequence: number;
  readonly at: number;
} & (
  | { readonly kind: "output"; readonly data: string }
  | {
      readonly kind: "status";
      readonly status: "exited" | "stopped" | "interrupted";
      readonly exitCode?: number | undefined;
      readonly signal?: string | undefined;
    }
);

export function isRuntimeTerminalFrame(value: unknown): value is RuntimeTerminalFrame {
  if (!isJsonObject(value)) return false;
  const keys = ["type", "terminalId", "sessionId", "resourceEpoch", "sequence", "at", "kind"];
  if (
    value.type !== "terminal.event" ||
    ![value.terminalId, value.sessionId, value.resourceEpoch].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 512,
    ) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !Number.isSafeInteger(value.at) ||
    Number(value.at) < 0
  )
    return false;
  if (value.kind === "output") {
    return (
      typeof value.data === "string" &&
      value.data.length <= 65536 &&
      Object.keys(value).every((key) => [...keys, "data"].includes(key))
    );
  }
  return (
    value.kind === "status" &&
    ["exited", "stopped", "interrupted"].includes(String(value.status)) &&
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode)) &&
    (value.signal === undefined ||
      (typeof value.signal === "string" && value.signal.length <= 128)) &&
    Object.keys(value).every((key) => [...keys, "status", "exitCode", "signal"].includes(key))
  );
}
