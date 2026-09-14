import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeNotification,
} from "@pico/protocol";

const NOTIFICATION_TRIMMING_BUDGETS = [
  { maxString: 64 * 1024, maxArray: 256, maxKeys: 256 },
  { maxString: 16 * 1024, maxArray: 128, maxKeys: 128 },
  { maxString: 4 * 1024, maxArray: 64, maxKeys: 64 },
  { maxString: 512, maxArray: 16, maxKeys: 32 },
] as const;

/**
 * 保留 eventId、topic 和 scope，逐档裁剪 payload 直到指定传输层接受该通知。
 * 由本机 IPC 与 runtime-host bridge 共用，避免两个传输层的游标与去重语义漂移。
 */
export function trimRuntimeNotificationToFit(
  notification: RuntimeNotification,
  fits: (candidate: RuntimeNotification) => boolean,
  failureMessage: string,
): RuntimeNotification {
  if (fits(notification)) return notification;
  for (const budget of NOTIFICATION_TRIMMING_BUDGETS) {
    const candidate = {
      ...notification,
      payload: boundedNotificationValue(notification.payload as JsonValue, budget, 0),
    } as RuntimeNotification;
    if (fits(candidate)) return candidate;
  }
  throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FRAME_TOO_LARGE, failureMessage);
}

/** Bounds a notification for a byte-oriented transport such as runtime-host. */
export function transportSafeRuntimeNotificationWithin(
  notification: RuntimeNotification,
  maxSerializedBytes: number,
): RuntimeNotification {
  return trimRuntimeNotificationToFit(
    notification,
    (candidate) => Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxSerializedBytes,
    `Runtime notification ${notification.eventId} cannot be represented within ${maxSerializedBytes} bytes`,
  );
}

function boundedNotificationValue(
  value: JsonValue,
  budget: { readonly maxString: number; readonly maxArray: number; readonly maxKeys: number },
  depth: number,
): JsonValue {
  if (typeof value === "string") {
    if (value.length <= budget.maxString) return value;
    return `${value.slice(0, Math.max(0, budget.maxString - 32))}…[truncated ${value.length} chars]`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 32) return "[truncated nested value]";
  if (Array.isArray(value)) {
    return value
      .slice(0, budget.maxArray)
      .map((item) => boundedNotificationValue(item, budget, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, budget.maxKeys)
      .map(([key, item]) => [key, boundedNotificationValue(item, budget, depth + 1)]),
  );
}
