import {
  assertDurableTranscriptEvent,
  type DurableTranscriptEvent,
} from "@pico/core/durable-transcript-contract";

interface EntryState {
  readonly id: string;
  readonly kind: string;
  readonly streamId?: string;
  readonly toolCallId?: string;
  readonly activityId?: string;
}

interface StreamState {
  readonly entryId: string;
  status: "streaming" | "completed" | "interrupted";
}

interface ToolState {
  readonly entryId: string;
  status: "running" | "approval";
}

interface SubagentState {
  readonly entryId: string;
  lifecycle: "active" | "terminal_unconsumed" | "archived";
}

export interface DurableTranscriptStateInspection {
  readonly sequence: number;
  readonly activeToolCallIds: readonly string[];
}

/**
 * Validates the durable subset of Transcript's relational state machine without
 * importing renderer projections into Runtime.
 */
export function inspectDurableTranscriptEvents(
  events: readonly DurableTranscriptEvent[],
): DurableTranscriptStateInspection {
  let sequence = 0;
  let entries: EntryState[] = [];
  let streams = new Map<string, StreamState>();
  let tools = new Map<string, ToolState>();
  let subagents = new Map<string, SubagentState>();

  for (const event of events) {
    assertDurableTranscriptEvent(event);
    if (event.sequence !== sequence + 1) {
      throw new Error(
        `Transcript event sequence mismatch: ${event.sequence}, expected ${sequence + 1}`,
      );
    }

    switch (event.type) {
      case "entry.appended":
        assertNewEntry(entries, event.entryId);
        entries = [...entries, { id: event.entryId, kind: event.entry.kind }];
        break;

      case "assistant.stream.started":
        assertNewEntry(entries, event.entryId);
        if (streams.has(event.streamId)) {
          throw new Error(`Duplicate Transcript stream ID: ${event.streamId}`);
        }
        entries = [
          ...entries,
          { id: event.entryId, kind: event.entryKind, streamId: event.streamId },
        ];
        streams.set(event.streamId, { entryId: event.entryId, status: "streaming" });
        break;

      case "assistant.stream.completed":
      case "assistant.stream.interrupted": {
        const stream = streams.get(event.streamId);
        assertStreamTarget(stream, event.entryId);
        stream.status = event.type === "assistant.stream.completed" ? "completed" : "interrupted";
        break;
      }

      case "assistant.response.suppressed": {
        const target = entries.find((entry) => entry.id === event.entryId);
        if (!target) throw new Error(`Unknown Transcript assistant entry ID: ${event.entryId}`);
        if (target.kind !== "assistant") {
          throw new Error(`Transcript entry ${event.entryId} is not an assistant response`);
        }
        entries = entries.filter((entry) => entry.id !== event.entryId);
        ({ streams, tools } = retainEntryIndexes(entries, streams, tools));
        break;
      }

      case "tool.started":
        assertNewEntry(entries, event.entryId);
        if (tools.has(event.toolCallId)) {
          throw new Error(`Duplicate Transcript tool call ID: ${event.toolCallId}`);
        }
        entries = [
          ...entries,
          {
            id: event.entryId,
            kind: "tool",
            toolCallId: event.toolCallId,
          },
        ];
        tools.set(event.toolCallId, { entryId: event.entryId, status: "running" });
        break;

      case "tool.approval.requested": {
        const tool = tools.get(event.toolCallId);
        if (!tool) throw new Error(`Unknown Transcript tool call ID: ${event.toolCallId}`);
        tool.status = "approval";
        break;
      }

      case "subagent.activity.updated": {
        const current = subagents.get(event.activityId);
        if (current) {
          if (current.entryId !== event.entryId) {
            throw new Error(
              `Transcript subagent activity ${event.activityId} entry mismatch: ${current.entryId} != ${event.entryId}`,
            );
          }
          current.lifecycle = subagentLifecycle(event.activity.status, current.lifecycle);
        } else {
          assertNewEntry(entries, event.entryId);
          entries = [
            ...entries,
            {
              id: event.entryId,
              kind: "subagent-activity",
              activityId: event.activityId,
            },
          ];
          subagents.set(event.activityId, {
            entryId: event.entryId,
            lifecycle: subagentLifecycle(event.activity.status),
          });
        }
        break;
      }

      case "subagent.activity.archived": {
        const current = subagents.get(event.activityId);
        if (!current) {
          throw new Error(`Unknown Transcript subagent activity: ${event.activityId}`);
        }
        if (current.lifecycle === "active") {
          throw new Error(
            `Cannot archive active Transcript subagent activity: ${event.activityId}`,
          );
        }
        current.lifecycle = "archived";
        break;
      }

      case "transcript.truncated": {
        const entryCount = Math.min(Math.max(0, event.entryCount), entries.length);
        entries = entries.slice(0, entryCount);
        ({ streams, tools } = retainEntryIndexes(entries, streams, tools));
        const retainedActivities = new Set(
          entries.flatMap((entry) => (entry.activityId === undefined ? [] : [entry.activityId])),
        );
        subagents = new Map(
          [...subagents].filter(([activityId]) => retainedActivities.has(activityId)),
        );
        break;
      }
    }
    sequence = event.sequence;
  }

  return Object.freeze({
    sequence,
    activeToolCallIds: Object.freeze([...tools.keys()]),
  });
}

function assertNewEntry(entries: readonly EntryState[], entryId: string): void {
  if (entries.some((entry) => entry.id === entryId)) {
    throw new Error(`Duplicate Transcript entry ID: ${entryId}`);
  }
}

function assertStreamTarget(
  stream: StreamState | undefined,
  entryId: string,
): asserts stream is StreamState {
  if (!stream) throw new Error(`Unknown Transcript stream for entry ${entryId}`);
  if (stream.entryId !== entryId) {
    throw new Error(`Transcript stream entry mismatch: ${stream.entryId} != ${entryId}`);
  }
  if (stream.status !== "streaming") {
    throw new Error(`Transcript stream is ${stream.status}, expected streaming`);
  }
}

function retainEntryIndexes(
  entries: readonly EntryState[],
  streams: ReadonlyMap<string, StreamState>,
  tools: ReadonlyMap<string, ToolState>,
): { streams: Map<string, StreamState>; tools: Map<string, ToolState> } {
  const retained = new Set(entries.map((entry) => entry.id));
  return {
    streams: new Map([...streams].filter(([, stream]) => retained.has(stream.entryId))),
    tools: new Map([...tools].filter(([, tool]) => retained.has(tool.entryId))),
  };
}

function subagentLifecycle(
  status: string,
  previous?: SubagentState["lifecycle"],
): SubagentState["lifecycle"] {
  if (status === "queued" || status === "running") return "active";
  return previous === "archived" ? previous : "terminal_unconsumed";
}
