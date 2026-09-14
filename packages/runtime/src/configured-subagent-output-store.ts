import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { canonicalizeWorkspacePath } from "@pico/storage/workspace-path";
import { childRecord, type ChildRecord } from "./configured-subagent-record.js";

export interface ConfiguredSubagentOutputQuery {
  readonly locator: "child_session_latest" | "child_session_run";
  readonly childSessionId: string;
  readonly runId?: string;
  readonly view: "result" | "events" | "runtime_events" | "all";
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface ConfiguredSubagentOutputPort {
  read(query: ConfiguredSubagentOutputQuery): Promise<unknown>;
}

/** Safe routing signal: this parent has no matching configured-child record. */
export class ConfiguredSubagentOutputNotFoundError extends Error {
  constructor() {
    super("agent_output child is not authorized for this parent session or does not exist");
    this.name = "ConfiguredSubagentOutputNotFoundError";
  }
}

export { childRecord, type ChildRecord } from "@pico/runtime/configured-subagent-record";

export interface ConfiguredSubagentParentRecordScope {
  readonly parentSessionId: string;
  readonly workDir: string;
  readonly eventStore: SqliteRuntimeEventStore;
}

export interface ConfiguredSubagentOpenedStore {
  readonly store: SqliteRuntimeEventStore;
  close(): void;
}

/** Host resolves the child's workspace path and opens its isolated durable store. */
export interface ConfiguredSubagentChildStoreOpener {
  open(workDir: string): ConfiguredSubagentOpenedStore | undefined;
}

export interface ConfiguredSubagentOutputStoreOptions extends ConfiguredSubagentParentRecordScope {
  readonly childStoreOpener: ConfiguredSubagentChildStoreOpener;
}

interface Output {
  childSessionId: string;
  runId?: string;
  turnId?: string;
  status: string;
  summary: string;
  artifactIds: string[];
  patch?: ChildRecord["patch"];
  runtimeEvents?: Record<string, unknown>[];
  truncated: boolean;
}

/** Authority comes exclusively from hidden Host records committed in the bound parent Session. */
export function createConfiguredSubagentOutputStore(
  options: ConfiguredSubagentOutputStoreOptions,
): ConfiguredSubagentOutputPort {
  return {
    async read(query) {
      const manifest = await options.eventStore.readSessionManifest(options.parentSessionId);
      if (
        !manifest ||
        canonicalizeWorkspacePath(manifest.workDir) !== canonicalizeWorkspacePath(options.workDir)
      )
        throw new Error("agent_output parent session authority is unavailable");
      const record = await findParentRecord(options, query);
      if (!record) throw new ConfiguredSubagentOutputNotFoundError();
      const output: Output = {
        childSessionId: record.childSessionId,
        ...(record.runId ? { runId: record.runId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
        status: record.status,
        summary: record.summary ?? "",
        artifactIds: [...(record.artifactIds ?? [])],
        ...(record.patch ? { patch: record.patch } : {}),
        truncated: false,
      };
      // Completed parent facts remain readable even when an implementation worktree was removed.
      await readChild(options, record, query, output);
      return boundedOutput(output, query.maxBytes);
    },
  };
}

export async function findParentRecord(
  options: ConfiguredSubagentParentRecordScope,
  query: ConfiguredSubagentOutputQuery,
): Promise<ChildRecord | undefined> {
  let upper: number | undefined;
  // Keyset pages keep ordinary history reads small without losing old linked children.
  for (;;) {
    const entries = await options.eventStore.readSessionEventsByKind(
      options.parentSessionId,
      "message.committed",
      { order: "desc", limit: 100, ...(upper !== undefined ? { upToSequence: upper } : {}) },
    );
    for (const { event } of entries) {
      const record = childRecord(event);
      if (
        !record ||
        event.sessionId !== options.parentSessionId ||
        record.parentSessionId !== options.parentSessionId ||
        record.parentRunId !== event.runId ||
        record.childSessionId === options.parentSessionId
      )
        continue;
      if (
        record.childSessionId === query.childSessionId &&
        (!query.runId || record.runId === query.runId)
      )
        return record;
    }
    if (entries.length < 100) return undefined;
    upper = entries.at(-1)!.sequence - 1;
  }
}

async function readChild(
  options: ConfiguredSubagentOutputStoreOptions,
  parent: ChildRecord,
  query: ConfiguredSubagentOutputQuery,
  output: Output,
): Promise<void> {
  const child = options.childStoreOpener.open(parent.workDir);
  if (!child) {
    if (query.runId && parent.runId !== query.runId)
      throw new Error("agent_output requested child run does not exist");
    return;
  }
  const childStore = child.store;
  try {
    const manifest = await childStore.readSessionManifest(parent.childSessionId);
    if (
      !manifest ||
      canonicalizeWorkspacePath(manifest.workDir) !== canonicalizeWorkspacePath(parent.workDir)
    )
      throw new Error("agent_output child session authority is inconsistent");
    const requestedRun =
      query.locator === "child_session_latest" ? undefined : (query.runId ?? parent.runId);
    const starts = requestedRun
      ? await childStore.readSessionEventsForRun(parent.childSessionId, requestedRun, {
          kind: "run.started",
          limit: 1,
        })
      : await childStore.readSessionEventsByKind(parent.childSessionId, "run.started", {
          order: "desc",
          limit: 1,
        });
    const start = starts[0]?.event;
    if (!start) {
      if (requestedRun && parent.runId !== requestedRun)
        throw new Error("agent_output requested child run does not exist");
      return;
    }
    const admissions = await childStore.readSessionEventsForRun(
      parent.childSessionId,
      start.runId,
      { kind: "message.committed", limit: 100 },
    );
    const admitted = admissions.some(({ event }) => {
      const record = childRecord(event);
      return (
        record &&
        record.parentSessionId === parent.parentSessionId &&
        record.parentRunId === parent.parentRunId &&
        record.parentToolCallId === parent.parentToolCallId &&
        record.childSessionId === parent.childSessionId &&
        record.runId === start.runId &&
        record.turnId === start.turnId &&
        canonicalizeWorkspacePath(record.workDir) === canonicalizeWorkspacePath(parent.workDir)
      );
    });
    if (!admitted) throw new Error("agent_output child run has no matching parent admission");
    if (parent.runId !== start.runId) {
      output.status = "started";
      output.summary = "";
      output.artifactIds = [];
      delete output.patch;
    }
    output.runId = start.runId;
    output.turnId = start.turnId;
    const terminal = (
      await childStore.readSessionEventsForRun(parent.childSessionId, start.runId, {
        kind: "run.terminal",
        order: "desc",
        limit: 1,
      })
    )[0]?.event;
    if (terminal?.kind === "run.terminal") output.status = terminal.data.status;
    const messages = await childStore.readSessionEventsForRun(parent.childSessionId, start.runId, {
      kind: "message.committed",
      order: "desc",
      limit: 100,
    });
    const lastAssistant = messages.find(
      ({ event }) =>
        event.kind === "message.committed" &&
        event.data.message.role === "assistant" &&
        event.data.message.providerData?.["picoHiddenFromTranscript"] !== true &&
        !event.data.message.toolCalls?.length &&
        event.data.message.content.trim(),
    );
    if (!output.summary && lastAssistant?.event.kind === "message.committed")
      output.summary = lastAssistant.event.data.message.content;
    if (query.view !== "result") {
      const events = await childStore.readSessionEventsForRun(parent.childSessionId, start.runId, {
        order: "desc",
        limit: query.maxEvents,
      });
      output.runtimeEvents = events.reverse().flatMap(({ event }) => {
        if (
          event.kind === "message.committed" &&
          event.data.message.providerData?.["picoHiddenFromTranscript"] === true
        )
          return [];
        return [
          {
            eventId: event.eventId,
            kind: event.kind,
            runId: event.runId,
            turnId: event.turnId,
            ...(event.kind === "run.terminal" ? { status: event.data.status } : {}),
            ...(event.kind === "message.committed"
              ? { role: event.data.message.role, text: event.data.message.content }
              : {}),
          },
        ];
      });
      output.truncated = events.length === query.maxEvents;
    }
  } finally {
    child.close();
  }
}

function boundedOutput(output: Output, maxBytes: number): Output {
  while (Buffer.byteLength(JSON.stringify(output), "utf8") > maxBytes) {
    output.truncated = true;
    if (output.runtimeEvents?.length) output.runtimeEvents.shift();
    else if (output.patch) delete output.patch;
    else if (output.artifactIds.length) output.artifactIds.pop();
    else if (output.summary.length)
      output.summary = output.summary
        .slice(0, Math.floor(output.summary.length / 2))
        .replace(/[\uD800-\uDBFF]$/u, "");
    else throw new Error("agent_output identity exceeds output budget");
  }
  return output;
}
