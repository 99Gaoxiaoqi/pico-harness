/**
 * Human-facing presentation for a saved session.
 *
 * Keep this separate from session persistence and command registration: both the
 * full session picker and slash-command argument suggestions need the same,
 * recognizable description of a session.
 */
export interface SessionPresentationInput {
  id: string;
  updatedAt: Date;
  messageCount: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  /** The source session ID, when this session was created by fork. */
  forkFrom?: string;
  /** Resolved by the caller when the source session is available. */
  forkParentTitle?: string;
  isCurrent?: boolean;
}

export interface SessionPresentationOptions {
  now?: Date;
  maxTitleLength?: number;
}

export interface SessionPresentation {
  title: string;
  relativeUpdatedAt: string;
  messageLabel: string;
  metadata: string;
  identifier: string;
  forkLabel?: string;
  isCurrent: boolean;
}

/**
 * Produces a compact, one-line description suitable for typeahead candidates.
 * The random ID deliberately remains at the end as a debugging/disambiguation
 * aid rather than the primary way to recognize a conversation.
 */
export function formatSessionCandidateDescription(
  session: SessionPresentationInput,
  options: SessionPresentationOptions = {},
): string {
  const presentation = presentSession(session, options);
  return [
    presentation.title,
    presentation.metadata,
    ...(presentation.forkLabel ? [presentation.forkLabel] : []),
    ...(presentation.isCurrent ? ["Current"] : []),
    presentation.identifier,
  ].join(" · ");
}

export function presentSession(
  session: SessionPresentationInput,
  options: SessionPresentationOptions = {},
): SessionPresentation {
  const title = truncateInline(sessionDisplayTitle(session), options.maxTitleLength);
  const relativeUpdatedAt = formatRelativeTime(session.updatedAt, options.now);
  const messageLabel = formatMessageCount(session.messageCount);
  const forkParentTitle = cleanText(session.forkParentTitle);
  const forkLabel = session.forkFrom
    ? forkParentTitle
      ? `Fork of “${truncateInline(forkParentTitle, 36)}”`
      : "Forked conversation"
    : undefined;

  return {
    title,
    relativeUpdatedAt,
    messageLabel,
    metadata: `${messageLabel} · ${relativeUpdatedAt}`,
    identifier: session.id,
    ...(forkLabel ? { forkLabel } : {}),
    isCurrent: session.isCurrent ?? false,
  };
}

export function sessionDisplayTitle(session: SessionPresentationInput): string {
  return cleanText(session.title) ?? cleanText(session.firstMessage) ?? cleanText(session.lastMessage) ?? "(no title)";
}

export function formatMessageCount(messageCount: number): string {
  const count = Math.max(0, Math.trunc(messageCount));
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

export function formatRelativeTime(value: Date, now = new Date()): string {
  const elapsedMs = Math.max(0, now.getTime() - value.getTime());
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 45) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 45) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 22) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}

function cleanText(value: string | undefined): string | undefined {
  const inline = value?.replace(/\s+/g, " ").trim();
  return inline || undefined;
}

function truncateInline(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
