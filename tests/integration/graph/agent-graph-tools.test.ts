import assert from "node:assert/strict";
import test from "node:test";

import type { AgentGraph } from "../../../src/agent-graph/core/contracts.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../../src/agent-graph/operator-profile-catalog.js";
import type { CommitAgentGraphWorkInput } from "../../../src/agent-graph/work-request.js";
import {
  AGENT_GRAPH_MAX_COMMANDS,
  AGENT_GRAPH_MAX_INPUT_REFS,
  AGENT_GRAPH_MAX_INSTRUCTION_BYTES,
  AGENT_GRAPH_MAX_JSON_BYTES,
  AGENT_GRAPH_MAX_SELECTED_RECORDS,
  AGENT_GRAPH_MAX_VIEW_RECORDS,
  createAgentGraphSupervisorTools,
  type AgentGraphRootToolContext,
  type AgentGraphSupervisorProjection,
  type AgentGraphSupervisorView,
  type AgentGraphSupervisorToolPort,
  type CommitAgentGraphUpdateInput,
  type ReadAgentGraphProjectionInput,
  type RegisterAgentGraphYieldInput,
} from "../../../src/tools/agent-graph-tools.js";

const ROOT: AgentGraphRootToolContext = {
  kind: "graph_root_supervisor",
  graphId: "graph-1",
  epoch: 1,
  rootSessionId: "root-session-1",
  rootTurnId: "root-turn-1",
  rootRunId: "root-run-1",
  rootModelRouteId: "model-route-1",
};

const GRAPH: AgentGraph = {
  graphId: ROOT.graphId,
  rootSessionId: ROOT.rootSessionId,
  epoch: 1,
  admissionPhase: "open",
  headRevision: 0,
  selectedRecordIds: [],
  createdAt: 1,
};

const EMPTY_PROJECTION: AgentGraphSupervisorProjection = {
  graph: GRAPH,
  operators: [],
  intents: [],
  stops: [],
  provisions: [],
  claims: [],
  records: [],
};

const EMPTY_VIEW: AgentGraphSupervisorView = {
  ...EMPTY_PROJECTION,
  availableOperatorProfiles: createBuiltinAgentGraphOperatorProfileCatalog().listPublicProfiles(),
  intentReadiness: [],
  runtimeClaims: [],
  results: { records: [], totalBytes: 0, truncated: false },
};

class FakePort implements AgentGraphSupervisorToolPort {
  readonly workUpdates: CommitAgentGraphWorkInput[] = [];
  readonly updates: CommitAgentGraphUpdateInput[] = [];
  readonly reads: ReadAgentGraphProjectionInput[] = [];
  readonly yields: RegisterAgentGraphYieldInput[] = [];
  readonly cancelledYields: Array<{ permitId: string; rootSessionId: string }> = [];
  onRegisterYield?: () => void;

  async commitWork(input: CommitAgentGraphWorkInput) {
    this.workUpdates.push(input);
    return {
      revision: 1,
      replayed: false,
      projection: {
        ...EMPTY_PROJECTION,
        graph: { ...GRAPH, headRevision: 1 },
      },
    };
  }

  async commitUpdate(input: CommitAgentGraphUpdateInput): Promise<never> {
    this.updates.push(input);
    throw new Error("tool-level commands are retired");
  }

  async readProjection(input: ReadAgentGraphProjectionInput) {
    this.reads.push(input);
    return EMPTY_VIEW;
  }

  async registerYield(input: RegisterAgentGraphYieldInput) {
    this.yields.push(input);
    this.onRegisterYield?.();
    return { permitId: `permit:${input.toolCallId}`, replayed: false, snapshot: EMPTY_PROJECTION };
  }

  cancelYield(permitId: string, rootSessionId: string): void {
    this.cancelledYields.push({ permitId, rootSessionId });
  }
}

function fixture(context: AgentGraphRootToolContext | null = ROOT, swarm = false) {
  const port = new FakePort();
  const tools = createAgentGraphSupervisorTools({
    getRootContext: () => context ?? undefined,
    port,
    swarm,
  });
  const byName = new Map(tools.map((tool) => [tool.name(), tool]));
  return { port, tools, byName };
}

function padJsonToBytes(json: string, bytes: number): string {
  const padding = bytes - Buffer.byteLength(json, "utf8");
  assert.ok(padding >= 0, "JSON fixture must fit below its target boundary");
  return `${json}${" ".repeat(padding)}`;
}

test("update_agent_graph accepts only current work requests and forwards host-owned identity", async () => {
  const { port, byName, tools } = fixture();
  const update = byName.get("update_agent_graph")!;
  const schema = JSON.stringify(update.definition().inputSchema);
  assert.doesNotMatch(schema, /expected_revision|operation_id|commands/u);
  const raw = await update.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [
        {
          profile_id: "explore",
          instruction: "  调研 PostgreSQL 的事务隔离。  ",
          input_ids: ["record-source-1"],
          workspace: { kind: "shared" },
        },
      ],
    }),
    { toolCallId: "provider-call-1" },
  );

  assert.equal(port.workUpdates.length, 1);
  assert.deepEqual(port.workUpdates[0]?.source, {
    sessionId: ROOT.rootSessionId,
    turnId: ROOT.rootTurnId,
    runId: ROOT.rootRunId,
    toolCallId: "provider-call-1",
  });
  assert.equal(port.workUpdates[0]?.graphId, ROOT.graphId);
  assert.deepEqual(port.workUpdates[0]?.request, {
    operation: "add_work",
    work: [
      {
        profileId: "explore",
        instruction: "调研 PostgreSQL 的事务隔离。",
        inputIds: ["record-source-1"],
        requireConfiguredPreset: false,
        workspace: { kind: "shared" },
      },
    ],
  });
  const result = JSON.parse(raw) as {
    revision: number;
    replayed: boolean;
    projection: AgentGraphSupervisorProjection;
  };
  assert.equal(result.revision, 1);
  assert.equal(result.replayed, false);
  assert.equal(result.projection.graph.headRevision, 1);
  assert.equal(port.updates.length, 0);
  assert.equal(
    tools.every((tool) => tool.accesses?.("{}").length === 0),
    true,
  );
});

test("update_agent_graph rejects the retired command envelope without reaching internal commits", async () => {
  const { port, byName } = fixture();
  await assert.rejects(
    byName.get("update_agent_graph")!.execute(
      JSON.stringify({
        expected_revision: 8,
        operation_id: "operation-batch",
        commands: [{ kind: "finish", selected_record_ids: [] }],
      }),
      { toolCallId: "provider-call-batch" },
    ),
    /operation/u,
  );
  assert.equal(port.workUpdates.length, 0);
  assert.equal(port.updates.length, 0);
});

test("update_agent_graph parses a current follow-up request for an existing Operator", async () => {
  const { port, byName } = fixture();
  await byName.get("update_agent_graph")!.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [
        {
          operator_id: "researcher",
          instruction: "复核已有结论。",
          input_ids: ["record-source-2"],
        },
      ],
    }),
    { toolCallId: "provider-call-follow-up" },
  );

  assert.deepEqual(port.workUpdates[0]?.request, {
    operation: "add_work",
    work: [
      {
        operatorId: "researcher",
        instruction: "复核已有结论。",
        inputIds: ["record-source-2"],
      },
    ],
  });
});

test("update_agent_graph rejects malformed requests, forged root identity, and invalid Unicode", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "run",
        add_work: [{ profile_id: "explore", instruction: "do it" }],
      }),
      { toolCallId: "provider-call-bad-kind" },
    ),
    /operation 必须是 add_work、stop 或 finish/u,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "add_work",
        root_session_id: "forged-root",
        add_work: [{ profile_id: "explore", instruction: "do it" }],
      }),
      { toolCallId: "provider-call-forged" },
    ),
    /不支持字段 root_session_id/u,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [{ profile_id: "explore", instruction: "\ud800" }],
      }),
      { toolCallId: "provider-call-invalid-unicode" },
    ),
    /非法 UTF-16\/UTF-8/u,
  );
  assert.equal(port.workUpdates.length + port.updates.length, 0);
});

test("update_agent_graph exposes shared and isolated workspace requests", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const schema = JSON.stringify(update.definition().inputSchema);
  assert.match(schema, /"enum":\["shared","isolated-worktree"\]/u);
  assert.match(schema, /isolated-worktree/u);
  assert.match(schema, /base_ref/u);

  await update.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [
        {
          profile_id: "explore",
          instruction: "Implement",
          workspace: { kind: "isolated-worktree", base_ref: "main" },
        },
      ],
    }),
    { toolCallId: "provider-call-isolated-worktree" },
  );
  assert.deepEqual(
    port.workUpdates[0]?.request.operation === "add_work"
      ? (() => {
          const work = port.workUpdates[0].request.work[0];
          return work && "profileId" in work ? work.workspace : undefined;
        })()
      : undefined,
    {
      kind: "isolated-worktree",
      baseRef: "main",
    },
  );
});

test("update_agent_graph rejects unknown fields at every current request boundary", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const cases = [
    {
      operation: "add_work",
      add_work: [{ profile_id: "explore", instruction: "bad", generation: 1 }],
    },
    {
      operation: "add_work",
      add_work: [
        {
          profile_id: "explore",
          instruction: "bad",
          workspace: { kind: "shared", path: "/forged" },
        },
      ],
    },
    {
      operation: "stop",
      stop: [{ intent_id: "intent-research", generation: 1 }],
    },
    { operation: "finish", finish: { result_ids: [], root_run_id: "forged-run" } },
  ];

  for (const [index, request] of cases.entries()) {
    await assert.rejects(
      update.execute(JSON.stringify(request), {
        toolCallId: `provider-call-nested-extra-${index}`,
      }),
      /不支持字段/u,
    );
  }
  assert.equal(port.workUpdates.length + port.updates.length, 0);
});

test("update_agent_graph rejects missing current fields and conflicting or duplicate identities", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const invalidRequests = [
    { operation: "add_work", add_work: [{ instruction: "missing target" }] },
    {
      operation: "add_work",
      add_work: [{ profile_id: "explore", operator_id: "operator-1", instruction: "conflict" }],
    },
    { operation: "add_work", add_work: [{ profile_id: "explore" }] },
    { operation: "stop", stop: [{}] },
    { operation: "finish", finish: {} },
    {
      operation: "add_work",
      add_work: [
        {
          profile_id: "explore",
          instruction: "duplicate input",
          input_ids: ["record-1", "record-1"],
        },
      ],
    },
    { operation: "finish", finish: { result_ids: ["record-1", "record-1"] } },
  ];

  for (const [index, request] of invalidRequests.entries()) {
    await assert.rejects(
      update.execute(JSON.stringify(request), { toolCallId: `provider-call-invalid-${index}` }),
    );
  }
  assert.equal(port.workUpdates.length + port.updates.length, 0);
});

test("update_agent_graph enforces UTF-8 and collection limits at exact boundaries", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const exactInstruction = "你".repeat(Math.floor(AGENT_GRAPH_MAX_INSTRUCTION_BYTES / 3)) + "ab";
  assert.equal(Buffer.byteLength(exactInstruction, "utf8"), AGENT_GRAPH_MAX_INSTRUCTION_BYTES);

  await update.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [
        {
          profile_id: "explore",
          instruction: exactInstruction,
          input_ids: Array.from(
            { length: AGENT_GRAPH_MAX_INPUT_REFS },
            (_, index) => `record-${index}`,
          ),
        },
      ],
    }),
    { toolCallId: "provider-call-exact-instruction" },
  );

  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [{ profile_id: "explore", instruction: `${exactInstruction}a` }],
      }),
      { toolCallId: "provider-call-over-instruction" },
    ),
    new RegExp(`不得超过 ${AGENT_GRAPH_MAX_INSTRUCTION_BYTES} 字节`, "u"),
  );

  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [
          {
            profile_id: "explore",
            instruction: "too many input refs",
            input_ids: Array.from(
              { length: AGENT_GRAPH_MAX_INPUT_REFS + 1 },
              (_, index) => `record-over-${index}`,
            ),
          },
        ],
      }),
      { toolCallId: "provider-call-over-input-refs" },
    ),
    new RegExp(`input_ids 不得超过 ${AGENT_GRAPH_MAX_INPUT_REFS} 项`, "u"),
  );
  const exactWork = Array.from({ length: AGENT_GRAPH_MAX_COMMANDS }, (_, index) => ({
    profile_id: "explore",
    instruction: `work-${index}`,
  }));
  await update.execute(JSON.stringify({ operation: "add_work", add_work: exactWork }), {
    toolCallId: "provider-call-exact-work",
  });
  await assert.rejects(
    update.execute(
      JSON.stringify({ operation: "add_work", add_work: [...exactWork, exactWork[0]] }),
      { toolCallId: "provider-call-over-work" },
    ),
    new RegExp(`add_work 必须包含 1 至 ${AGENT_GRAPH_MAX_COMMANDS} 项`, "u"),
  );

  const finishIds = Array.from(
    { length: AGENT_GRAPH_MAX_SELECTED_RECORDS + 1 },
    (_, index) => `record-finish-${index}`,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "finish",
        finish: { result_ids: finishIds },
      }),
      { toolCallId: "provider-call-over-selected" },
    ),
    new RegExp(`result_ids 不得超过 ${AGENT_GRAPH_MAX_SELECTED_RECORDS} 项`, "u"),
  );

  const minimal = JSON.stringify({
    operation: "finish",
    finish: { result_ids: [] },
  });
  const exactJson = padJsonToBytes(minimal, AGENT_GRAPH_MAX_JSON_BYTES);
  await update.execute(exactJson, { toolCallId: "provider-call-exact-json" });
  await assert.rejects(
    update.execute(`${exactJson} `, { toolCallId: "provider-call-over-json" }),
    new RegExp(`JSON 不得超过 ${AGENT_GRAPH_MAX_JSON_BYTES} 字节`, "u"),
  );

  assert.equal(port.workUpdates.length, 3);
  assert.equal(port.updates.length, 0);
});

test("all Supervisor tools reject calls without a host-injected root activation context", async () => {
  const { port, byName } = fixture(null);
  await assert.rejects(
    byName.get("update_agent_graph")!.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [{ profile_id: "explore", instruction: "do it" }],
      }),
      { toolCallId: "provider-call-1" },
    ),
    /仅可由有效的 Graph root activation 调用/u,
  );
  await assert.rejects(byName.get("view_agent_graph")!.execute("{}"), /有效的 Graph root/u);
  await assert.rejects(
    byName.get("yield_agent_graph")!.execute("{}", { toolCallId: "provider-call-yield" }),
    /有效的 Graph root/u,
  );
  assert.equal(
    port.workUpdates.length + port.updates.length + port.reads.length + port.yields.length,
    0,
  );
});

test("Supervisor tools reject forged host context and non-empty read/yield input", async () => {
  for (const context of [
    { ...ROOT, graphId: "forged graph" },
    { ...ROOT, rootSessionId: "root\nsession" },
    { ...ROOT, rootTurnId: "" },
    { ...ROOT, rootRunId: "\ud800" },
  ]) {
    const { port, byName } = fixture(context);
    await assert.rejects(
      byName.get("update_agent_graph")!.execute(
        JSON.stringify({
          operation: "add_work",
          add_work: [{ profile_id: "explore", instruction: "do it" }],
        }),
        { toolCallId: "provider-call-forged-context" },
      ),
      /调用上下文或参数|必须是非空字符串|非法 UTF-16\/UTF-8/u,
    );
    assert.equal(port.workUpdates.length + port.updates.length, 0);
  }

  const { port, byName } = fixture();
  await assert.rejects(
    byName.get("update_agent_graph")!.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [{ profile_id: "explore", instruction: "do it" }],
      }),
    ),
    /toolCallId/u,
  );
  await assert.rejects(
    byName.get("view_agent_graph")!.execute(JSON.stringify({ graph_id: ROOT.graphId })),
    /不支持字段 graph_id/u,
  );
  await assert.rejects(
    byName.get("yield_agent_graph")!.execute("[]", { toolCallId: "provider-call-yield" }),
    /期望 JSON 对象/u,
  );
  assert.equal(
    port.workUpdates.length + port.updates.length + port.reads.length + port.yields.length,
    0,
  );
});

test("all Supervisor tools reject root identities with leading or trailing whitespace", async () => {
  const contexts = [
    { ...ROOT, graphId: ` ${ROOT.graphId}` },
    { ...ROOT, graphId: `${ROOT.graphId} ` },
    { ...ROOT, rootSessionId: ` ${ROOT.rootSessionId}` },
    { ...ROOT, rootSessionId: `${ROOT.rootSessionId} ` },
    { ...ROOT, rootTurnId: ` ${ROOT.rootTurnId}` },
    { ...ROOT, rootTurnId: `${ROOT.rootTurnId} ` },
    { ...ROOT, rootRunId: ` ${ROOT.rootRunId}` },
    { ...ROOT, rootRunId: `${ROOT.rootRunId} ` },
  ];

  for (const [index, context] of contexts.entries()) {
    const { port, byName } = fixture(context);
    await assert.rejects(
      byName.get("update_agent_graph")!.execute(
        JSON.stringify({
          operation: "add_work",
          add_work: [{ profile_id: "explore", instruction: `work-${index}` }],
        }),
        { toolCallId: `provider-call-padded-root-${index}` },
      ),
      /调用上下文/u,
    );
    await assert.rejects(byName.get("view_agent_graph")!.execute("{}"), /调用上下文/u);
    await assert.rejects(
      byName.get("yield_agent_graph")!.execute("{}", {
        toolCallId: `provider-call-padded-root-yield-${index}`,
      }),
      /调用上下文/u,
    );
    assert.equal(
      port.workUpdates.length + port.updates.length + port.reads.length + port.yields.length,
      0,
    );
  }
});

test("view_agent_graph returns the application projection and yield_agent_graph forwards exact root/run/tool identity", async () => {
  const { port, byName } = fixture();
  const viewed = JSON.parse(await byName.get("view_agent_graph")!.execute("{}"));
  assert.deepEqual(viewed, EMPTY_VIEW);
  assert.deepEqual(port.reads, [
    { graphId: ROOT.graphId, epoch: ROOT.epoch, rootSessionId: ROOT.rootSessionId },
  ]);

  await byName
    .get("view_agent_graph")!
    .execute(JSON.stringify({ record_ids: ["record-1", "record-2"] }));
  assert.deepEqual(port.reads[1], {
    graphId: ROOT.graphId,
    epoch: ROOT.epoch,
    rootSessionId: ROOT.rootSessionId,
    recordIds: ["record-1", "record-2"],
  });

  await assert.rejects(
    byName
      .get("view_agent_graph")!
      .execute(JSON.stringify({ record_ids: ["record-1", "record-1"] })),
    /record_ids 不得包含重复项/u,
  );
  await assert.rejects(
    byName.get("view_agent_graph")!.execute(
      JSON.stringify({
        record_ids: Array.from(
          { length: AGENT_GRAPH_MAX_VIEW_RECORDS + 1 },
          (_, index) => `record-${index}`,
        ),
      }),
    ),
    new RegExp(`record_ids 不得超过 ${AGENT_GRAPH_MAX_VIEW_RECORDS} 项`, "u"),
  );

  const yielded = JSON.parse(
    await byName.get("yield_agent_graph")!.execute("{}", {
      toolCallId: "provider-call-yield",
    }),
  );
  assert.deepEqual(port.yields, [
    {
      graphId: ROOT.graphId,
      epoch: ROOT.epoch,
      rootSessionId: ROOT.rootSessionId,
      rootTurnId: ROOT.rootTurnId,
      rootRunId: ROOT.rootRunId,
      toolCallId: "provider-call-yield",
    },
  ]);
  assert.equal(yielded.permitId, "permit:provider-call-yield");
  assert.deepEqual(yielded.snapshot, EMPTY_PROJECTION);
});

test("yield_agent_graph cancels a registered permit when the tool call aborts after registration", async () => {
  const { port, byName } = fixture();
  const controller = new AbortController();
  port.onRegisterYield = () => controller.abort();

  await assert.rejects(
    byName.get("yield_agent_graph")!.execute("{}", {
      toolCallId: "provider-call-aborted-yield",
      signal: controller.signal,
    }),
    /abort/u,
  );
  assert.deepEqual(port.cancelledYields, [
    {
      permitId: "permit:provider-call-aborted-yield",
      rootSessionId: ROOT.rootSessionId,
    },
  ]);
});
