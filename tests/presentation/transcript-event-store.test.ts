import { describe, expect, it } from "vitest";
import {
  TranscriptEventStore,
  projectTranscriptEntriesForRendering,
} from "../../src/presentation/transcript-event-store.js";
import { TuiEventStore, projectTuiEntriesForRendering } from "../../src/tui/tui-event-store.js";

function deterministicIds(): (scope: string) => string {
  const counters = new Map<string, number>();
  return (scope) => {
    const next = (counters.get(scope) ?? 0) + 1;
    counters.set(scope, next);
    return `${scope}:${next}`;
  };
}

describe("TranscriptEventStore", () => {
  it("在 presentation 层稳定投影 stream、tool、subagent 与 truncate", () => {
    const store = new TranscriptEventStore({ idFactory: deterministicIds(), now: () => 42 });

    store.append({
      type: "entry.appended",
      entryId: store.createId("entry"),
      entry: { kind: "user", content: "检查工作区" },
    });
    const assistantEntryId = store.createId("entry");
    const streamId = store.createId("stream");
    store.append({
      type: "assistant.stream.started",
      entryId: assistantEntryId,
      streamId,
      delta: "先",
    });
    store.append({
      type: "assistant.stream.delta",
      entryId: assistantEntryId,
      streamId,
      delta: "读取",
    });
    store.append({
      type: "assistant.stream.completed",
      entryId: assistantEntryId,
      streamId,
    });

    const toolStarted = store.append({
      type: "tool.started",
      entryId: store.createId("entry"),
      providerCallId: "provider-call",
      name: "read_file",
      args: '{"path":"README.md"}',
    });
    expect(toolStarted.type).toBe("tool.started");
    if (toolStarted.type !== "tool.started") throw new Error("expected tool.started");
    store.append({
      type: "tool.output",
      toolCallId: toolStarted.toolCallId,
      segment: {
        content: "Pico",
        runs: [{ stream: "stdout", length: 4 }],
      },
    });
    store.append({
      type: "tool.completed",
      toolCallId: toolStarted.toolCallId,
      status: "success",
      summary: "已读取",
      size: 4,
      truncated: false,
    });

    const subagentEntryId = store.createId("entry");
    store.append({
      type: "subagent.activity.updated",
      entryId: subagentEntryId,
      activityId: "agent:review",
      activity: { task: "评审", status: "running" },
    });
    store.append({
      type: "subagent.trace.recorded",
      trace: {
        activityId: "agent:review",
        traceId: "trace:1",
        type: "message",
        content: "发现问题",
      },
    });

    const beforeTruncate = store.getProjection();
    expect(beforeTruncate.entries.map((entry) => entry.id)).toEqual([
      "entry:1",
      assistantEntryId,
      "entry:3",
      subagentEntryId,
    ]);
    expect(beforeTruncate.entries[1]?.entry).toEqual({
      kind: "assistant",
      content: "先读取",
    });
    expect(beforeTruncate.toolCalls[toolStarted.toolCallId]).toMatchObject({
      providerCallId: "provider-call",
      result: "Pico",
      resultAvailability: "inline",
    });
    expect(beforeTruncate.subagents["agent:review"]?.timeline).toMatchObject([
      { id: "trace:1", kind: "message", content: "发现问题" },
    ]);

    store.append({ type: "transcript.truncated", entryCount: 2 });
    const afterTruncate = store.getProjection();
    expect(afterTruncate.entries).toHaveLength(2);
    expect(afterTruncate.toolCalls).toEqual({});
    expect(afterTruncate.subagents).toEqual({});
    expect(store.replay()).toEqual(afterTruncate);
  });

  it("旧 TUI 路径保持构造器和渲染投影兼容", () => {
    expect(TuiEventStore).toBe(TranscriptEventStore);
    expect(projectTuiEntriesForRendering).toBe(projectTranscriptEntriesForRendering);

    const store = new TuiEventStore({ idFactory: deterministicIds() });
    store.append({
      type: "entry.appended",
      entryId: "entry:legacy",
      entry: { kind: "assistant", content: "兼容" },
    });
    expect(projectTuiEntriesForRendering(store.getProjection())).toEqual([
      {
        kind: "assistant",
        content: "兼容",
        uiEntryId: "entry:legacy",
      },
    ]);
  });
});
