import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentGraph,
  AgentGraphActivationIntent,
  AgentGraphOperator,
} from "../../src/agent-graph/core/contracts.js";
import {
  createAgentGraphSupervisorTools,
  type AgentGraphRootToolContext,
  type AgentGraphSupervisorProjection,
  type AgentGraphSupervisorToolPort,
  type CommitAgentGraphUpdateInput,
  type RegisterAgentGraphYieldInput,
} from "../../src/tools/agent-graph-tools.js";

const ROOT: AgentGraphRootToolContext = {
  kind: "graph_root_supervisor",
  graphId: "graph-1",
  rootSessionId: "root-session-1",
  rootTurnId: "root-turn-1",
  rootRunId: "root-run-1",
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

class FakePort implements AgentGraphSupervisorToolPort {
  readonly updates: CommitAgentGraphUpdateInput[] = [];
  readonly reads: { graphId: string; rootSessionId: string }[] = [];
  readonly yields: RegisterAgentGraphYieldInput[] = [];

  async commitUpdate(input: CommitAgentGraphUpdateInput) {
    this.updates.push(input);
    const addCommands = input.commands.filter((command) => command.kind === "add");
    const operators = addCommands.map((command) => command.operator);
    const intents = addCommands.map((command) => command.intent);
    const stops = input.commands.filter((command) => command.kind === "stop");
    const finished = input.commands.find((command) => command.kind === "finish");
    return {
      revision: input.expectedRevision + 1,
      replayed: false,
      projection: {
        ...EMPTY_PROJECTION,
        graph: {
          ...GRAPH,
          headRevision: input.expectedRevision + 1,
          ...(finished
            ? {
                admissionPhase: "sealed" as const,
                selectedRecordIds: finished.selectedRecordIds ?? [],
              }
            : {}),
        },
        operators,
        intents,
        stops,
      },
    };
  }

  async readProjection(input: { graphId: string; rootSessionId: string }) {
    this.reads.push(input);
    return EMPTY_PROJECTION;
  }

  async registerYield(input: RegisterAgentGraphYieldInput) {
    this.yields.push(input);
    return { permitId: `permit:${input.toolCallId}`, replayed: false, snapshot: EMPTY_PROJECTION };
  }
}

function fixture(context: AgentGraphRootToolContext | null = ROOT) {
  const port = new FakePort();
  const tools = createAgentGraphSupervisorTools({
    getRootContext: () => context ?? undefined,
    port,
  });
  const byName = new Map(tools.map((tool) => [tool.name(), tool]));
  return { port, tools, byName };
}

function addCommand(overrides: Record<string, unknown> = {}) {
  return {
    kind: "add",
    operator: {
      operator_id: "researcher",
      generation: 1,
      role: "Researcher",
      description: "Research the requested topic.",
      profile: {
        profile_id: "explore",
        model: "model-1",
        tools: ["read_file", "web_search"],
        permission_policy: { filesystem: "read-only", network: false },
        system_prompt_version: "v1",
      },
      workspace: { kind: "isolated-worktree", base_ref: "main" },
    },
    intent: {
      intent_id: "intent-research",
      instruction: "  调研 PostgreSQL 的事务隔离。  ",
      input_record_ids: ["record-source-1"],
    },
    ...overrides,
  };
}

test("update_agent_graph normalizes one add command and forwards host-owned source identity", async () => {
  const { port, byName, tools } = fixture();
  const update = byName.get("update_agent_graph")!;
  const raw = await update.execute(
    JSON.stringify({
      expected_revision: 0,
      operation_id: "operation-1",
      commands: [addCommand()],
    }),
    { toolCallId: "provider-call-1" },
  );

  assert.equal(port.updates.length, 1);
  assert.deepEqual(port.updates[0]?.source, {
    sessionId: ROOT.rootSessionId,
    turnId: ROOT.rootTurnId,
    runId: ROOT.rootRunId,
    toolCallId: "provider-call-1",
  });
  assert.equal(port.updates[0]?.graphId, ROOT.graphId);
  assert.equal(port.updates[0]?.operationId, "operation-1");
  const command = port.updates[0]?.commands[0];
  assert.equal(command?.kind, "add");
  assert.equal((command as { operator: AgentGraphOperator }).operator.graphId, ROOT.graphId);
  assert.equal(
    (command as { intent: AgentGraphActivationIntent }).intent.instruction,
    "调研 PostgreSQL 的事务隔离。",
  );
  assert.equal((command as { intent: AgentGraphActivationIntent }).intent.createdAtRevision, 1);
  const result = JSON.parse(raw) as {
    revision: number;
    replayed: boolean;
    projection: AgentGraphSupervisorProjection;
  };
  assert.equal(result.revision, 1);
  assert.equal(result.replayed, false);
  assert.equal(result.projection.graph.headRevision, 1);
  assert.equal(result.projection.operators[0]?.operatorId, "researcher");
  assert.equal(
    tools.every((tool) => tool.accesses?.("{}").length === 0),
    true,
  );
});

test("update_agent_graph submits add, stop, and finish as one ordered atomic batch", async () => {
  const { port, byName } = fixture();
  const raw = await byName.get("update_agent_graph")!.execute(
    JSON.stringify({
      expected_revision: 8,
      operation_id: "operation-batch",
      commands: [
        addCommand(),
        {
          kind: "stop",
          target: { kind: "operator", operator_id: "researcher", generation: 1 },
          reason: "已获得足够证据",
        },
        { kind: "finish", selected_record_ids: ["record-final"] },
      ],
    }),
    { toolCallId: "provider-call-batch" },
  );

  assert.equal(port.updates.length, 1);
  assert.deepEqual(
    port.updates[0]?.commands.map((command) => command.kind),
    ["add", "stop", "finish"],
  );
  assert.deepEqual(port.updates[0]?.commands[2], {
    kind: "finish",
    selectedRecordIds: ["record-final"],
  });
  assert.equal((JSON.parse(raw) as { revision: number }).revision, 9);
});

test("update_agent_graph rejects malformed commands, forged root identity, and invalid Unicode", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-bad-kind",
        commands: [{ kind: "run", task: "do it" }],
      }),
      { toolCallId: "provider-call-bad-kind" },
    ),
    /kind 必须是 add、stop 或 finish/u,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-forged",
        root_session_id: "forged-root",
        commands: [addCommand()],
      }),
      { toolCallId: "provider-call-forged" },
    ),
    /不支持字段 root_session_id/u,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-invalid-unicode",
        commands: [addCommand({ intent: { intent_id: "intent-1", instruction: "\ud800" } })],
      }),
      { toolCallId: "provider-call-invalid-unicode" },
    ),
    /非法 UTF-16\/UTF-8/u,
  );
  assert.equal(port.updates.length, 0);
});

test("all Supervisor tools reject calls without a host-injected root activation context", async () => {
  const { port, byName } = fixture(null);
  await assert.rejects(
    byName.get("update_agent_graph")!.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-1",
        commands: [addCommand()],
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
  assert.equal(port.updates.length + port.reads.length + port.yields.length, 0);
});

test("view_agent_graph returns the application projection and yield_agent_graph forwards exact root/run/tool identity", async () => {
  const { port, byName } = fixture();
  const viewed = JSON.parse(await byName.get("view_agent_graph")!.execute("{}"));
  assert.deepEqual(viewed, EMPTY_PROJECTION);
  assert.deepEqual(port.reads, [{ graphId: ROOT.graphId, rootSessionId: ROOT.rootSessionId }]);

  const yielded = JSON.parse(
    await byName.get("yield_agent_graph")!.execute("{}", {
      toolCallId: "provider-call-yield",
    }),
  );
  assert.deepEqual(port.yields, [
    {
      graphId: ROOT.graphId,
      rootSessionId: ROOT.rootSessionId,
      rootTurnId: ROOT.rootTurnId,
      rootRunId: ROOT.rootRunId,
      toolCallId: "provider-call-yield",
    },
  ]);
  assert.equal(yielded.permitId, "permit:provider-call-yield");
  assert.deepEqual(yielded.snapshot, EMPTY_PROJECTION);
});
