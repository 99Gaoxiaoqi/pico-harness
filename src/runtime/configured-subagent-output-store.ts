import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalizeWorkspacePath, resolvePicoPaths } from "../paths/pico-paths.js";
import type { RuntimeEvent } from "../storage/runtime-event.js";
import { operationalDatabasePath } from "../storage/sqlite/sqlite-database.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  ConfiguredSubagentOutputPort,
  ConfiguredSubagentOutputQuery,
} from "../tools/configured-subagent-output.js";

/** Safe routing signal: this parent has no matching configured-child record. */
export class ConfiguredSubagentOutputNotFoundError extends Error {
  constructor() {
    super("agent_output child is not authorized for this parent session or does not exist");
    this.name = "ConfiguredSubagentOutputNotFoundError";
  }
}

export interface ChildRecord {
  readonly version: 1;
  readonly profile?: string;
  readonly parentWorkspacePath: string;
  readonly agentName?: string;
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly childSessionId: string;
  readonly workDir: string;
  readonly status: "started" | "completed" | "failed" | "cancelled";
  readonly runId?: string;
  readonly turnId?: string;
  readonly summary?: string;
  readonly artifactIds?: readonly string[];
  readonly patch?: { readonly path: string; readonly worktree: string; readonly branch: string };
}

export interface ConfiguredSubagentOutputStoreOptions {
  readonly parentSessionId: string;
  readonly workDir: string;
  readonly picoHome?: string;
  readonly eventStore: SqliteRuntimeEventStore;
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
  options: ConfiguredSubagentOutputStoreOptions,
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
  const storageRoot = resolvePicoPaths(parent.workDir, { picoHome: options.picoHome }).workspace
    .root;
  if (!existsSync(operationalDatabasePath(storageRoot))) {
    if (query.runId && parent.runId !== query.runId)
      throw new Error("agent_output requested child run does not exist");
    return;
  }
  const childStore = new SqliteRuntimeEventStore({ storageRoot });
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
    childStore.close();
  }
}

export function childRecord(event: RuntimeEvent): ChildRecord | undefined {
  if (
    event.kind !== "message.committed" ||
    event.partial ||
    event.data.message.role !== "assistant" ||
    event.data.message.providerData?.["picoHiddenFromTranscript"] !== true
  )
    return undefined;
  const value = event.data.message.providerData["picoConfiguredChild"];
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !["started", "completed", "failed", "cancelled"].includes(String(value["status"]))
  )
    return undefined;
  for (const key of ["parentSessionId", "parentRunId", "parentToolCallId", "childSessionId"])
    if (!validIdentity(value[key])) return undefined;
  for (const key of ["runId", "turnId"])
    if (value[key] !== undefined && !validIdentity(value[key])) return undefined;
  if (typeof value["parentWorkspacePath"] !== "string" || !isAbsolute(value["parentWorkspacePath"]))
    return undefined;
  if (typeof value["workDir"] !== "string" || !isAbsolute(value["workDir"])) return undefined;
  const patch = value["patch"];
  return {
    version: 1,
    ...(typeof value["profile"] === "string" ? { profile: value["profile"] } : {}),
    parentWorkspacePath: value["parentWorkspacePath"],
    ...(typeof value["agentName"] === "string" ? { agentName: value["agentName"] } : {}),
    parentSessionId: value["parentSessionId"] as string,
    parentRunId: value["parentRunId"] as string,
    parentToolCallId: value["parentToolCallId"] as string,
    childSessionId: value["childSessionId"] as string,
    workDir: value["workDir"],
    status: value["status"] as ChildRecord["status"],
    ...(typeof value["runId"] === "string" ? { runId: value["runId"] } : {}),
    ...(typeof value["turnId"] === "string" ? { turnId: value["turnId"] } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(Array.isArray(value["artifactIds"])
      ? {
          artifactIds: value["artifactIds"].filter(
            (item): item is string => typeof item === "string" && item.length <= 512,
          ),
        }
      : {}),
    ...(isRecord(patch) &&
    typeof patch["path"] === "string" &&
    typeof patch["worktree"] === "string" &&
    typeof patch["branch"] === "string"
      ? { patch: { path: patch["path"], worktree: patch["worktree"], branch: patch["branch"] } }
      : {}),
  };
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

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\s/\\\p{Cc}]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
