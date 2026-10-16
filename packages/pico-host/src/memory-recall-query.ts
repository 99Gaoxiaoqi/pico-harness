import { isUserTaskMessage } from "@pico/core";
import { countTokens, primeTokenizer } from "@pico/runtime";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { validateCanonicalTaskExperienceSource } from "./task-experience-runtime.js";

const CONTINUATIONS = new Set([
  "ok",
  "okay",
  "yes",
  "go ahead",
  "continue",
  "好",
  "好的",
  "继续",
  "收到",
  "明白",
  "可以",
  "行",
  "对",
  "是的",
  "嗯",
  "继续上个任务",
  "继续刚才的任务",
  "按刚才的方案继续",
]);
const requestText = (text: string): string =>
  text
    .split(/\n\n附件文件：|\n<uploaded-attachments>/u)[0]!
    .replace(/```[\s\S]*?```/gu, "")
    .split("\n")
    .filter((line) => !/^\s*>/u.test(line))
    .join("\n")
    .trim();
const continuation = (text: string): boolean =>
  CONTINUATIONS.has(
    requestText(text)
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[。.!！?？]+$/u, "")
      .trim(),
  );

/** Query hints only. Never a task instruction, permission or memory extraction source. */
export async function resolveMemoryRecallQuery(options: {
  readonly query: string;
  readonly currentEventId?: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly events?: SqliteRuntimeEventStore;
  readonly inheritedConversation?: boolean;
}): Promise<{ readonly query: string; readonly anchorEventId?: string }> {
  const unchanged = { query: options.query };
  if (
    !continuation(options.query) ||
    !options.events ||
    !options.currentEventId ||
    options.inheritedConversation
  )
    return unchanged;
  const events = options.events;
  const current = await events.readSessionEvent(options.sessionId, options.currentEventId);
  if (
    !current ||
    current.event.kind !== "message.committed" ||
    current.event.partial ||
    current.event.visibility !== "model" ||
    !isUserTaskMessage(current.event.data.message) ||
    requestText(current.event.data.message.content) !== requestText(options.query)
  )
    return unchanged;
  if (
    !(await validateCanonicalTaskExperienceSource(
      events,
      {
        sessionId: options.sessionId,
        runId: current.event.runId,
        turnId: current.event.turnId,
        eventId: current.event.eventId,
      },
      { workDir: options.workDir },
    ))
  )
    return unchanged;
  const candidates = await events.readSessionEventsByKind(options.sessionId, "message.committed", {
    upToSequence: current.sequence,
    order: "desc",
    limit: 16,
    modelOnly: true,
  });
  for (const entry of candidates) {
    const event = entry.event;
    if (
      entry.sequence >= current.sequence ||
      event.kind !== "message.committed" ||
      !isUserTaskMessage(event.data.message)
    )
      continue;
    const text = requestText(event.data.message.content);
    if (!text || continuation(text)) continue;
    // A cancellation/reset is a boundary, never a new task anchor.
    if (
      /^(?:停止|停下|取消|算了|不要继续|重新开始|清空|stop|cancel|reset)(?:[\s。.!！?？]|$)/iu.test(
        text,
      ) ||
      text.startsWith("/")
    )
      return unchanged;
    const valid = await validateCanonicalTaskExperienceSource(
      events,
      {
        sessionId: options.sessionId,
        runId: event.runId,
        turnId: event.turnId,
        eventId: event.eventId,
      },
      { workDir: options.workDir },
    );
    if (!valid) return unchanged;
    const terminals = await events.readSessionEventsByKind(options.sessionId, "run.terminal", {
      afterSequence: entry.sequence,
      upToSequence: current.sequence,
      order: "desc",
      limit: 16,
    });
    if (terminals.length >= 16) return unchanged;
    if (
      terminals.some(
        ({ event: terminal }) =>
          terminal.kind === "run.terminal" && terminal.data.status !== "completed",
      )
    )
      return unchanged;
    await primeTokenizer();
    const points = Array.from(text).slice(0, 1024);
    while (points.length && countTokens(points.join("")) > 256) points.pop();
    if (!points.length) return unchanged;
    return { query: points.join(""), anchorEventId: event.eventId };
  }
  return unchanged;
}
