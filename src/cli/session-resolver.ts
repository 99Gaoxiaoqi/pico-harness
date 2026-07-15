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
import { RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX } from "../runtime/runtime-run.js";
import { StorageOperationJournal } from "../storage/operation-journal.js";

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

export interface ListCliSessionSummariesOptions {
  picoHome?: string;
}

export interface ResolveCliSessionOptions {
  workDir: string;
  picoHome?: string;
  session?: string;
  continueSession?: boolean;
  resumeSession?: string;
  forkSession?: string;
}

interface SequencedCliSessionSummary {
  readonly summary: CliSessionSummary;
  readonly headSequence: number;
}

interface ForkTargetOperations {
  readonly hasCompleted: boolean;
}

export async function resolveCliSession(
  options: ResolveCliSessionOptions,
): Promise<CliSessionSelection> {
  assertSingleSessionMode(options);

  if (options.resumeSession) {
    const sessionId = options.resumeSession;
    await assertRuntimeSessionExists(options.workDir, sessionId, "resume", true, options.picoHome);
    return rememberSelection({ mode: "resume", sessionId }, options.workDir, options.picoHome);
  }

  if (options.session) {
    await assertRuntimeSessionExists(
      options.workDir,
      options.session,
      "resume",
      false,
      options.picoHome,
    );
    return rememberSelection(
      { mode: "resume", sessionId: options.session },
      options.workDir,
      options.picoHome,
    );
  }

  if (options.forkSession) {
    await assertRuntimeSessionExists(
      options.workDir,
      options.forkSession,
      "fork",
      true,
      options.picoHome,
    );
    return rememberSelection(
      {
        mode: "fork",
        sessionId: createCliSessionId(),
        sourceSessionId: options.forkSession,
      },
      options.workDir,
      options.picoHome,
    );
  }

  if (options.continueSession) {
    const latest = await findLatestSessionId(options.workDir, options.picoHome);
    if (latest) {
      return rememberSelection(
        { mode: "continue", sessionId: latest },
        options.workDir,
        options.picoHome,
      );
    }
  }

  return rememberSelection(
    { mode: "new", sessionId: createCliSessionId() },
    options.workDir,
    options.picoHome,
  );
}

export function createCliSessionId(): string {
  return `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function listCliSessionSummaries(
  workDir: string,
  options: ListCliSessionSummariesOptions = {},
): Promise<CliSessionSummary[]> {
  const runtimeEventStore = createRuntimeEventStore(workDir, options.picoHome);
  const forkTargets = await indexForkTargetOperations(workDir, options.picoHome);
  const sequenced = await Promise.all(
    (await runtimeEventStore.listSessionManifests()).map(async (manifest) => {
      const entries = await runtimeEventStore.readSessionEntries(manifest.sessionId);
      if (!isPublishedRuntimeSession(manifest.sessionId, entries, forkTargets)) return undefined;
      return summaryFromRuntimeSession(manifest, entries);
    }),
  );
  const published = sequenced.filter(
    (entry): entry is SequencedCliSessionSummary => entry !== undefined,
  );

  published.sort(
    (a, b) =>
      b.summary.updatedAt.getTime() - a.summary.updatedAt.getTime() ||
      b.headSequence - a.headSequence ||
      b.summary.createdAt.getTime() - a.summary.createdAt.getTime() ||
      b.summary.id.localeCompare(a.summary.id),
  );
  return published.map(({ summary }) => summary);
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

async function findLatestSessionId(
  workDir: string,
  picoHome?: string,
): Promise<string | undefined> {
  return (await listCliSessionSummaries(workDir, { picoHome }))[0]?.id;
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
  picoHome?: string,
): Promise<void> {
  const prefix = action === "fork" ? "无法 fork" : "无法恢复";
  const store = createRuntimeEventStore(workDir, picoHome);
  const manifest = await store.readSessionManifest(sessionId);
  if (!manifest) {
    if (!required) return;
    throw new Error(`${prefix} session ${sessionId}: runtime.sqlite 中不存在`);
  }
  const entries = await store.readSessionEntries(sessionId);
  const forkTargets = await indexForkTargetOperations(workDir, picoHome);
  if (isPublishedRuntimeSession(sessionId, entries, forkTargets)) return;
  throw new Error(`${prefix} session ${sessionId}: fork 尚未完成发布`);
}

async function indexForkTargetOperations(
  workDir: string,
  picoHome?: string,
): Promise<ReadonlyMap<string, ForkTargetOperations>> {
  const operations = await new StorageOperationJournal({ workDir, picoHome }).list();
  const targets = new Map<string, ForkTargetOperations>();
  for (const operation of operations) {
    if (operation.kind !== "fork" || operation.state === "aborted") continue;
    const existing = targets.get(operation.targetSessionId);
    targets.set(operation.targetSessionId, {
      hasCompleted: existing?.hasCompleted === true || operation.state === "completed",
    });
  }
  return targets;
}

function isPublishedRuntimeSession(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
  forkTargets: ReadonlyMap<string, ForkTargetOperations>,
): boolean {
  const targetOperations = forkTargets.get(sessionId);
  const hasForkFacts = entries.some(
    ({ event }) =>
      event.kind === "session.forked" || event.runId.startsWith(RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX),
  );
  if (!hasForkFacts) return targetOperations === undefined;

  const completedBootstrap = entries.some(
    ({ sequence: markerSequence, event: marker }) =>
      marker.kind === "session.forked" &&
      entries.some(
        ({ sequence: terminalSequence, event: terminal }) =>
          terminalSequence > markerSequence &&
          terminal.kind === "run.terminal" &&
          terminal.runId === marker.runId &&
          terminal.data.status === "completed",
      ),
  );
  if (!completedBootstrap) return false;
  return targetOperations?.hasCompleted ?? true;
}

/** 仅用于新 fork 构建失败时清理尚未公布的目标会话。 */
export async function removeCliSessionFile(
  workDir: string,
  sessionId: string,
  options: { readonly picoHome?: string } = {},
): Promise<void> {
  await createRuntimeEventStore(workDir, options.picoHome).deleteSession(sessionId);
}

function createRuntimeEventStore(workDir: string, picoHome?: string): RuntimeEventStore {
  return new RuntimeEventStore({
    databasePath: resolvePicoPaths(workDir, { picoHome }).workspace.runtimeDatabase,
  });
}

function rememberSelection(
  selection: CliSessionSelection,
  workDir: string,
  picoHome?: string,
): CliSessionSelection {
  rememberResolvedCliSession(selection, workDir, picoHome);
  return selection;
}
