import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResult } from "../src/schema/message.js";
import { createToolResultObservationProcessor } from "../src/tools/tool-result-observation.js";

interface FakeWriteInput {
  sessionId?: string;
  toolName: string;
  args: unknown;
  output: string;
  summary?: string;
  ttlHours?: number;
  pinned?: boolean;
}

interface FakeArtifactMeta {
  id: string;
  sessionId?: string;
  path: string;
}

class FakeArtifactStore {
  readonly writes: FakeWriteInput[] = [];
  cleanupCalls = 0;

  constructor(
    private readonly meta: FakeArtifactMeta = { id: "artifact-123", path: "/tmp/a.txt" },
  ) {}

  async write(input: FakeWriteInput): Promise<FakeArtifactMeta> {
    this.writes.push(input);
    return this.meta;
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls++;
  }
}

const toolCall: ToolCall = {
  id: "call-1",
  name: "bash",
  arguments: '{"command":"npm test"}',
};

function result(output: string, isError = false): ToolResult {
  return {
    toolCallId: toolCall.id,
    output,
    isError,
  };
}

describe("createToolResultObservationProcessor", () => {
  it("returns small outputs unchanged without writing artifacts", async () => {
    const store = new FakeArtifactStore();
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 10,
    });

    const observation = await processor({
      toolCall,
      result: result("tiny"),
      output: "tiny",
      sessionId: "session-1",
    });

    expect(observation).toBe("tiny");
    expect(store.writes).toHaveLength(0);
    expect(store.cleanupCalls).toBe(0);
  });

  it("does not externalize output equal to the threshold", async () => {
    const store = new FakeArtifactStore();
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 4,
    });

    const observation = await processor({
      toolCall,
      result: result("tiny"),
      output: "tiny",
      sessionId: "session-1",
    });

    expect(observation).toBe("tiny");
    expect(store.writes).toHaveLength(0);
  });

  it("externalizes large outputs with session-scoped artifact URI and write metadata", async () => {
    const store = new FakeArtifactStore({
      id: "artifact-abc",
      sessionId: "session/with space",
      path: "/tmp/artifact-abc.txt",
    });
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 5,
      summaryMaxChars: 240,
      cleanupAfterWrite: true,
    });

    const output = `first line\nFAIL expected one thing\n${"x".repeat(40)}`;
    const observation = await processor({
      toolCall,
      result: result(output, true),
      output,
      sessionId: "session/with space",
    });

    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({
      sessionId: "session/with space",
      toolName: "bash",
      args: { command: "npm test" },
      output,
      pinned: true,
    });
    expect(store.writes[0]?.summary).toContain("FAIL expected one thing");
    expect(store.cleanupCalls).toBe(1);

    expect(observation).toContain("artifactId: artifact-abc");
    expect(observation).toContain("artifactUri: artifact://session%2Fwith%20space/artifact-abc");
    expect(observation).toContain("artifactPath: /tmp/artifact-abc.txt");
    expect(observation).toContain("summaryStrategy: bash-test");
    expect(observation).toContain("summary:");
    expect(observation.indexOf("artifactUri:")).toBeLessThan(observation.indexOf("artifactPath:"));
  });

  it("uses a stable fallback session id in artifact URI when sessionId is missing", async () => {
    const store = new FakeArtifactStore({
      id: "artifact-default",
      sessionId: "default",
      path: "/tmp/default.txt",
    });
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 1,
      cleanupAfterWrite: false,
    });

    const observation = await processor({
      toolCall,
      result: result("large output"),
      output: "large output",
    });

    expect(store.writes[0]?.sessionId).toBeUndefined();
    expect(observation).toContain("artifactUri: artifact://default/artifact-default");
  });

  it("does not clean up when cleanupAfterWrite is disabled", async () => {
    const store = new FakeArtifactStore();
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 1,
      cleanupAfterWrite: false,
    });

    await processor({
      toolCall,
      result: result("large output"),
      output: "large output",
      sessionId: "session-1",
    });

    expect(store.cleanupCalls).toBe(0);
  });

  it.each([
    {
      label: "cleanupAfterWrite=true overrides cleanup=false",
      cleanupAfterWrite: true,
      cleanup: false,
      expectedCleanupCalls: 1,
    },
    {
      label: "cleanupAfterWrite=false overrides cleanup=true",
      cleanupAfterWrite: false,
      cleanup: true,
      expectedCleanupCalls: 0,
    },
  ])("$label", async ({ cleanupAfterWrite, cleanup, expectedCleanupCalls }) => {
    const store = new FakeArtifactStore();
    const processor = createToolResultObservationProcessor({
      store,
      externalizeThresholdChars: 1,
      cleanup,
      cleanupAfterWrite,
    });

    await processor({
      toolCall,
      result: result("large output"),
      output: "large output",
      sessionId: "session-1",
    });

    expect(store.cleanupCalls).toBe(expectedCleanupCalls);
  });
});
