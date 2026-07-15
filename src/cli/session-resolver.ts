import { randomUUID } from "node:crypto";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import { rememberResolvedCliSession } from "../input/session-settings.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  RuntimeEventStore,
  type RuntimeEventStoreEntry,
  type RuntimeSessionManifest,
} from "../runtime/runtime-event-store.js";
import {
  projectRuntimeSessionMessages,
  projectRuntimeSessionState,
} from "../runtime/runtime-session-projection.js";

export type CliSessionMode = "new" | "continue" | "resume" | "fork";
export type CliSessionHistorySource = RuntimeSessionManifest["historySource"];

export interface CliSessionSelection {
  mode: CliSessionMode;
  sessionId: string;
  sourceSessionId?: string;
}

export interface CliSessionSummary {
  id: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  historySource?: CliSessionHistorySource;
  /** Source session ID persisted with a forked conversation. */
  forkFrom?: string;
  /** Durable journal identity; sessionId remains the human-facing compatibility key. */
  logId?: string;
  parentLogId?: string;
  forkEventId?: string;
}

export interface ResolveCliSessionOptions {
  workDir: string;
  session?: string;
  continueSession?: boolean;
  resumeSession?: string;
  forkSession?: string;
}

interface SequencedCliSessionSummary {
  readonly summary: CliSessionSummary;
  readonly headSequence: number;
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  assertSingleSessionMode(options);

  if (options.resumeSession) {
    const sessionId = options.resumeSession;
    await assertRuntimeSessionExists(options.workDir, sessionId, "resume", true);
    return rememberSelection({ mode: "resume", sessionId }, options.workDir);
  }

  if (options.session) {
    await assertRuntimeSessionExists(options.workDir, options.session, "resume", false);
    return rememberSelection({ mode: "resume", sessionId: options.session }, options.workDir);
  }

  if (options.forkSession) {
    await assertRuntimeSessionExists(options.workDir, options.forkSession, "fork", true);
    return rememberSelection(
      {
        mode: "fork",
        sessionId: createCliSessionId(),
        sourceSessionId: options.forkSession,
      },
      options.workDir,
    );
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir);
    if (latest) {
      return rememberSelection({ mode: "continue", sessionId: latest }, options.workDir);
    }
  }

  return rememberSelection({ mode: "new", sessionId: createCliSessionId() }, options.workDir);
}

export function createCliSessionId(): string {
  return `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function listCliSessionSummaries(workDir: string): Promise<CliSessionSummary[]> {
  const runtimeEventStore = createRuntimeEventStore(workDir);
  const sequenced = await Promise.all(
    (await runtimeEventStore.listSessionManifests()).map(async (manifest) =>
      summaryFromRuntimeSession(
        manifest,
        await runtimeEventStore.readSessionEntries(manifest.sessionId),
      ),
    ),
  );

  sequenced.sort(
    (a, b) =>
      b.summary.updatedAt.getTime() - a.summary.updatedAt.getTime() ||
      b.headSequence - a.headSequence ||
      b.summary.createdAt.getTime() - a.summary.createdAt.getTime() ||
      b.summary.id.localeCompare(a.summary.id),
  );
  return sequenced.map(({ summary }) => summary);
}

function summaryFromRuntimeSession(
  manifest: RuntimeSessionManifest,
  entries: readonly RuntimeEventStoreEntry[],
): SequencedCliSessionSummary {
  const events = entries.map(({ event }) => event);
  const messages = projectRuntimeSessionMessages(events);
  const runtimeState = projectRuntimeSessionState(events);
  const visibleUserMessages = messages.filter(
    (message) =>
      message.role === "user" &&
      message.toolCallId === undefined &&
      !isMessageHiddenFromTranscript(message) &&
      message.content.trim().length > 0,
  );
  const firstMessage = compactSessionText(visibleUserMessages[0]?.content);
  const lastMessage = compactSessionText(visibleUserMessages.at(-1)?.content);
  const title = runtimeState.settings?.title ?? firstMessage;
  const forkEvent = events.findLast((event) => event.kind === "session.forked");
  const forkFrom = forkEvent?.data.parentSessionId ?? runtimeState.settings?.forkFrom;
  const head = entries.at(-1);

  return {
    summary: {
      id: manifest.sessionId,
      cwd: manifest.workDir,
      createdAt: new Date(manifest.createdAt),
      updatedAt: new Date(head?.event.at ?? manifest.createdAt),
      messageCount: messages.length,
      ...(title ? { title } : {}),
      ...(firstMessage ? { firstMessage } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      ...(forkFrom ? { forkFrom } : {}),
      historySource: manifest.historySource,
      logId: manifest.sessionId,
      ...(forkEvent ? { parentLogId: forkEvent.data.parentSessionId } : {}),
      ...(forkEvent ? { forkEventId: forkEvent.eventId } : {}),
    },
    headSequence: head?.sequence ?? 0,
  };
}

function assertSingleSessionMode(options: ResolveCliSessionOptions): void {
  const modes = [
    options.session !== undefined,
    options.continueSession === true,
    options.resumeSession !== undefined,
    options.forkSession !== undefined,
  ].filter(Boolean);

  if (modes.length > 1) {
    throw new Error("session 启动参数只能选择一种");
  }
}

async function findLatestSessionId(workDir: string): Promise<string | undefined> {
  return (await listCliSessionSummaries(workDir))[0]?.id;
}

function compactSessionText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239)}…`;
}

async function assertRuntimeSessionExists(
  workDir: string,
  sessionId: string,
  action: "resume" | "fork",
  required: boolean,
): Promise<void> {
  if (await createRuntimeEventStore(workDir).readSessionManifest(sessionId)) return;
  if (!required) return;

  const prefix = action === "fork" ? "无法 fork" : "无法恢复";
  throw new Error(`${prefix} session ${sessionId}: runtime.sqlite 中不存在`);
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(workDir: string, sessionId: string): Promise<void> {
  await createRuntimeEventStore(workDir).deleteSession(sessionId);
}

function createRuntimeEventStore(workDir: string): RuntimeEventStore {
  return new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
  });
}

function rememberSelection(selection: CliSessionSelection, workDir: string): CliSessionSelection {
  rememberResolvedCliSession(selection, workDir);
  return selection;
}
