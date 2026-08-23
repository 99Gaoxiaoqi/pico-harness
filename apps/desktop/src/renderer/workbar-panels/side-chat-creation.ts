import type { RuntimeResult } from "@pico/protocol";

export function resolveSideChatCreationTarget(result: RuntimeResult<"sideChat.create">) {
  const targetSessionId = result.session.sessionId;
  const throughEventId = result.throughEventId;
  if (typeof targetSessionId !== "string" || typeof throughEventId !== "string") return undefined;
  return { targetSessionId, throughEventId };
}
