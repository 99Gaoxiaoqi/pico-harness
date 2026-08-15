/** UI-neutral display helpers shared by slash-command completion and future clients. */
export interface SessionPresentationInput {
  id: string;
  updatedAt: Date;
  /** daemon 会话列表无消息计数来源时可缺省（渲染为 —，与 tui 侧孪生一致）。 */
  messageCount?: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  forkFrom?: string;
  forkParentTitle?: string;
  isCurrent?: boolean;
}

export function sessionDisplayTitle(session: SessionPresentationInput): string {
  return (
    cleanText(session.title) ??
    cleanText(session.firstMessage) ??
    cleanText(session.lastMessage) ??
    "(no title)"
  );
}

export function formatSessionCandidateDetails(session: SessionPresentationInput): string {
  const elapsed = Math.max(0, Date.now() - session.updatedAt.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const updated =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h ago`;
  const title = session.forkFrom
    ? session.forkParentTitle
      ? `Fork of “${truncate(cleanText(session.forkParentTitle) ?? "(no title)", 36)}”`
      : "Forked conversation"
    : undefined;
  return [
    session.messageCount === undefined
      ? "—"
      : `${Math.max(0, Math.trunc(session.messageCount))} ${session.messageCount === 1 ? "message" : "messages"}`,
    updated,
    title,
    session.isCurrent ? "Current" : undefined,
    `id=${session.id}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function cleanText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
