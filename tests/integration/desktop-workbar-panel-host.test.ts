import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionSubscriptionFrame } from "@pico/protocol";

import type { DesktopRuntimeApi, DesktopResult } from "../../apps/desktop/src/preload/contract.js";
import {
  WorkbarReviewConflictError,
  appendArtifactStreamChunk,
  appendTerminalOutput,
  artifactContentView,
  loadConsistentReviewSnapshot,
  queryAllWorkbarTasks,
  shouldRefreshWorkbarResource,
  tracePageView,
  type WorkbarArtifact,
} from "../../apps/desktop/src/renderer/workbar-panels/index.js";

test("resource_changed only refreshes the active matching Session authority", () => {
  const frame = resourceFrame({ sessionId: "session-a", resource: "tasks", revision: 4 });
  assert.equal(
    shouldRefreshWorkbarResource(frame, {
      active: true,
      sessionId: "session-a",
      resource: "tasks",
      revision: 3,
    }),
    true,
  );
  assert.equal(
    shouldRefreshWorkbarResource(frame, {
      active: false,
      sessionId: "session-a",
      resource: "tasks",
      revision: 3,
    }),
    false,
  );
  assert.equal(
    shouldRefreshWorkbarResource(frame, {
      active: true,
      sessionId: "session-b",
      resource: "tasks",
      revision: 3,
    }),
    false,
  );
  assert.equal(
    shouldRefreshWorkbarResource(frame, {
      active: true,
      sessionId: "session-a",
      resource: "tasks",
      revision: 4,
    }),
    false,
  );
});

test("task controller holds one revision across authority pagination", async () => {
  const revisions: unknown[] = [];
  const runtime = fakeRuntime(async (method, params) => {
    assert.equal(method, "session.tasks.query");
    revisions.push(params["revision"]);
    if (!params["cursor"]) {
      return success({
        revision: 7,
        tasks: [runtimeTask("task-1", "第一项", 1)],
        nextCursor: "page-2",
      });
    }
    assert.equal(params["cursor"], "page-2");
    return success({ revision: 7, tasks: [runtimeTask("task-2", "第二项", 2)] });
  });

  const ledger = await queryAllWorkbarTasks(runtime, {
    workspacePath: "/workspace",
    sessionId: "session-a",
  });
  assert.equal(ledger.revision, 7);
  assert.deepEqual(
    ledger.tasks.map((task) => task.id),
    ["task-1", "task-2"],
  );
  assert.deepEqual(revisions, [undefined, 7]);
});

test("review controller retries mismatched staged and unstaged revisions", async () => {
  const calls = { staged: 0, unstaged: 0 };
  const runtime = fakeRuntime(async (method, params) => {
    assert.equal(method, "git.review.snapshot");
    const source = params["source"] as "staged" | "unstaged";
    calls[source] += 1;
    const revision = calls[source] === 1 ? (source === "staged" ? "rev-a" : "rev-b") : "rev-c";
    return success({
      revision,
      branch: "feature/workbar",
      source,
      files: [
        {
          path: source === "staged" ? "staged.ts" : "unstaged.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
        },
      ],
      truncated: false,
    });
  });

  const snapshot = await loadConsistentReviewSnapshot(runtime, "/workspace");
  assert.equal(snapshot.revision, "rev-c");
  assert.deepEqual(calls, { staged: 2, unstaged: 2 });
  assert.deepEqual(
    snapshot.staged.map((file) => file.path),
    ["staged.ts"],
  );
  assert.deepEqual(
    snapshot.unstaged.map((file) => file.path),
    ["unstaged.ts"],
  );

  const conflicting = fakeRuntime(async (_method, params) => {
    const source = params["source"] as "staged" | "unstaged";
    return success({
      revision: source === "staged" ? "rev-1" : "rev-2",
      branch: "feature/workbar",
      source,
      files: [],
      truncated: false,
    });
  });
  await assert.rejects(
    () => loadConsistentReviewSnapshot(conflicting, "/workspace", 1),
    WorkbarReviewConflictError,
  );
});

test("artifact controller preserves split UTF-8 code points and canonical binary base64", () => {
  const textArtifact: WorkbarArtifact = {
    id: "artifact-text",
    name: "result.txt",
    mimeType: "text/plain; charset=utf-8",
    size: 5,
    createdAt: "2026-08-23T00:00:00.000Z",
  };
  const bytes = Buffer.from("A你B", "utf8");
  const first = appendArtifactStreamChunk(undefined, textArtifact, {
    contentBase64: bytes.subarray(0, 2).toString("base64"),
    offsetBytes: 0,
    endOffsetBytes: 2,
    totalBytes: bytes.byteLength,
    truncated: true,
    nextOffsetBytes: 2,
  });
  assert.equal(artifactContentView(first).content, "A");

  const complete = appendArtifactStreamChunk(first, textArtifact, {
    contentBase64: bytes.subarray(2).toString("base64"),
    offsetBytes: 2,
    endOffsetBytes: bytes.byteLength,
    totalBytes: bytes.byteLength,
    truncated: false,
  });
  assert.deepEqual(artifactContentView(complete), {
    artifactId: "artifact-text",
    encoding: "utf8",
    content: "A你B",
    offset: 0,
    nextOffset: 5,
    totalSize: 5,
    complete: true,
    truncated: false,
  });

  const binary = Buffer.from([0, 255, 1, 2]);
  const binaryArtifact: WorkbarArtifact = {
    ...textArtifact,
    id: "artifact-binary",
    name: "image.bin",
    mimeType: "application/octet-stream",
    size: binary.byteLength,
  };
  const binaryView = artifactContentView(
    appendArtifactStreamChunk(undefined, binaryArtifact, {
      contentBase64: binary.toString("base64"),
      offsetBytes: 0,
      endOffsetBytes: binary.byteLength,
      totalBytes: binary.byteLength,
      truncated: false,
    }),
  );
  assert.equal(binaryView.encoding, "base64");
  assert.equal(binaryView.content, binary.toString("base64"));
});

test("trace and terminal helpers project authority records without corrupting UTF-8", () => {
  const trace = tracePageView([
    {
      sequence: 9,
      eventId: "event-9",
      kind: "tool.completed",
      at: "2026-08-23T00:00:00.000Z",
      event: {
        data: {
          title: "读取文件",
          summary: "完成",
          toolCallId: "call-1",
          status: "completed",
        },
      },
    },
  ]);
  assert.deepEqual(trace.items[0], {
    id: "event-9",
    sequence: 9,
    createdAt: "2026-08-23T00:00:00.000Z",
    kind: "tool.completed",
    category: "tool",
    title: "读取文件",
    summary: "完成",
    status: "completed",
    toolCallId: "call-1",
  });

  const bounded = appendTerminalOutput("prefix", "你你你你", 8);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 8);
  assert.doesNotMatch(bounded, /�/u);
});

function resourceFrame(input: {
  readonly sessionId: string;
  readonly resource: "tasks" | "artifacts" | "trace" | "context";
  readonly revision?: number;
  readonly watermark?: number;
}): RuntimeSessionSubscriptionFrame {
  return {
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    sessionId: input.sessionId,
    type: "subscription.resource_changed",
    resource: input.resource,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
  };
}

function runtimeTask(taskId: string, title: string, version: number) {
  return {
    taskId,
    title,
    status: "pending" as const,
    ordinal: version,
    version,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function success<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fakeRuntime(
  handler: (method: string, params: Record<string, unknown>) => Promise<DesktopResult<unknown>>,
): DesktopRuntimeApi {
  return new Proxy(
    {},
    {
      get: (_target, property) => (params: Record<string, unknown>) =>
        handler(String(property), params),
    },
  ) as DesktopRuntimeApi;
}
