import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentGraphReadOnlyQueryService } from "../../src/agent-graph/query-service.js";
import { agentOutputRecordIdFor, graphIdFor } from "../../src/agent-graph/core/ids.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../src/agent-graph/operator-profile-catalog.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

test("read-only Graph query lists epochs and returns a stable paged timeline without side effects", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-query-"));
  let now = 10;
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: () => now++ });
  const rootSessionId = "query-root";
  const query = new AgentGraphReadOnlyQueryService(store);
  const control = new SqliteAgentGraphControlStoreAdapter(store);

  try {
    assert.deepEqual(query.query({ rootSessionId, action: "list" }), { graphs: [] });
    assert.deepEqual(store.listGraphs(rootSessionId), []);

    const epochOne = store.openRootEpoch(rootSessionId).record;
    control.commitScheduleRevision({
      graphId: epochOne.graphId,
      expectedPreviousRevision: 0,
      operationId: "add-one",
      source: operationSource(rootSessionId, "add-one"),
      commands: [addCommand(epochOne.graphId, rootSessionId)],
    });
    const firstPage = query.query({
      rootSessionId,
      action: "timeline",
      graphId: epochOne.graphId,
      limit: 1,
    }) as {
      readonly watermark: string;
      readonly items: readonly { readonly kind: string }[];
      readonly nextCursor: string;
    };
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);

    control.commitScheduleRevision({
      graphId: epochOne.graphId,
      expectedPreviousRevision: 1,
      operationId: "stop-one",
      source: operationSource(rootSessionId, "stop-one"),
      commands: [
        {
          kind: "stop",
          target: { kind: "intent", intentId: "query-intent" },
          reason: "query fixture complete",
        },
      ],
    });
    assert.throws(
      () =>
        query.query({
          rootSessionId,
          action: "timeline",
          graphId: epochOne.graphId,
          cursor: firstPage.nextCursor,
          limit: 1,
        }),
      /invalid or stale/u,
    );
    control.commitScheduleRevision({
      graphId: epochOne.graphId,
      expectedPreviousRevision: 2,
      operationId: "finish",
      source: operationSource(rootSessionId, "finish"),
      commands: [{ kind: "finish" }],
    });
    const epochTwo = store.openRootEpoch(rootSessionId).record;
    assert.equal(epochTwo.graphId, graphIdFor(rootSessionId, 2));

    const listed = query.query({ rootSessionId, action: "list" }) as {
      readonly graphs: readonly {
        readonly epoch: number;
        readonly phase: string;
        readonly counts: { readonly intents: number };
      }[];
    };
    assert.deepEqual(
      listed.graphs.map(({ epoch, phase }) => ({ epoch, phase })),
      [
        { epoch: 1, phase: "finished" },
        { epoch: 2, phase: "open" },
      ],
    );
    assert.equal(listed.graphs[0]?.counts.intents, 1);
    assert.throws(
      () =>
        query.query({
          rootSessionId: "another-root",
          action: "get",
          graphId: epochOne.graphId,
        }),
      /does not belong/u,
    );
    assert.equal(store.listGraphs(rootSessionId).length, 2);
  } finally {
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

function operationSource(rootSessionId: string, operationId: string) {
  return {
    sessionId: rootSessionId,
    turnId: `turn:${operationId}`,
    runId: `run:${operationId}`,
    toolCallId: `tool:${operationId}`,
  };
}

function addCommand(graphId: string, rootSessionId: string) {
  return {
    kind: "add" as const,
    operator: {
      graphId,
      operatorId: "query-operator",
      generation: 1,
      role: "query role",
      profileSnapshot: createBuiltinAgentGraphOperatorProfileCatalog().resolve({
        profileId: "explore",
        rootModelRouteId: "test/model",
      }),
      workspacePolicy: { kind: "shared" as const },
    },
    intent: {
      graphId,
      intentId: "query-intent",
      operatorId: "query-operator",
      operatorGeneration: 1,
      instruction: "inspect the graph",
      expectedOutputRecordId: agentOutputRecordIdFor(graphId, "query-intent"),
      inputRefs: [],
      createdAtRevision: 1,
      requestedBy: operationSource(rootSessionId, "add-one"),
    },
  };
}
