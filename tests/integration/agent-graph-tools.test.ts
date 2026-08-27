import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentGraph,
  AgentGraphActivationIntent,
  AgentGraphOperator,
} from "../../src/agent-graph/core/contracts.js";
import {
  AGENT_GRAPH_MAX_COMMANDS,
  AGENT_GRAPH_MAX_INPUT_REFS,
  AGENT_GRAPH_MAX_INSTRUCTION_BYTES,
  AGENT_GRAPH_MAX_JSON_BYTES,
  AGENT_GRAPH_MAX_PROFILE_TOOLS,
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

const EMPTY_VIEW: AgentGraphSupervisorView = {
  ...EMPTY_PROJECTION,
  runtimeClaims: [],
  results: { records: [], totalBytes: 0, truncated: false },
};

class FakePort implements AgentGraphSupervisorToolPort {
  readonly updates: CommitAgentGraphUpdateInput[] = [];
  readonly reads: ReadAgentGraphProjectionInput[] = [];
  readonly yields: RegisterAgentGraphYieldInput[] = [];
  readonly cancelledYields: Array<{ permitId: string; rootSessionId: string }> = [];
  onRegisterYield?: () => void;

  async commitUpdate(input: CommitAgentGraphUpdateInput) {
    this.updates.push(input);
    const addCommands = input.commands.filter((command) => command.kind === "add");
    const operators = addCommands.map((command) => command.operator);
    const intents = input.commands.flatMap((command) =>
      command.kind === "add" || command.kind === "activate" ? [command.intent] : [],
    );
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
      workspace: { kind: "shared" },
    },
    intent: {
      intent_id: "intent-research",
      instruction: "  调研 PostgreSQL 的事务隔离。  ",
      input_record_ids: ["record-source-1"],
    },
    ...overrides,
  };
}

function activateCommand(overrides: Record<string, unknown> = {}) {
  return {
    kind: "activate",
    operator: { operator_id: "researcher", generation: 1 },
    intent: {
      intent_id: "intent-follow-up",
      instruction: "复核已有结论。",
      input_record_ids: ["record-source-2"],
    },
    ...overrides,
  };
}

function nestedJson(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

function padJsonToBytes(json: string, bytes: number): string {
  const padding = bytes - Buffer.byteLength(json, "utf8");
  assert.ok(padding >= 0, "JSON fixture must fit below its target boundary");
  return `${json}${" ".repeat(padding)}`;
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
  assert.deepEqual((command as { operator: AgentGraphOperator }).operator.workspacePolicy, {
    kind: "shared",
  });
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

test("update_agent_graph submits add and stop as one ordered atomic batch", async () => {
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
      ],
    }),
    { toolCallId: "provider-call-batch" },
  );

  assert.equal(port.updates.length, 1);
  assert.deepEqual(
    port.updates[0]?.commands.map((command) => command.kind),
    ["add", "stop"],
  );
  assert.equal((JSON.parse(raw) as { revision: number }).revision, 9);
});

test("update_agent_graph parses a follow-up activation for an existing Operator generation", async () => {
  const { port, byName } = fixture();
  await byName.get("update_agent_graph")!.execute(
    JSON.stringify({
      expected_revision: 1,
      operation_id: "operation-follow-up",
      commands: [activateCommand()],
    }),
    { toolCallId: "provider-call-follow-up" },
  );

  const command = port.updates[0]?.commands[0];
  assert.equal(command?.kind, "activate");
  if (command?.kind !== "activate") throw new Error("expected activate command");
  assert.equal(command.intent.operatorId, "researcher");
  assert.equal(command.intent.operatorGeneration, 1);
  assert.equal(command.intent.createdAtRevision, 2);
  assert.equal(command.intent.requestedBy.toolCallId, "provider-call-follow-up");
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
    /kind 必须是 add、activate、stop 或 finish/u,
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

test("update_agent_graph exposes and accepts only the production-supported shared workspace", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const schema = JSON.stringify(update.definition().inputSchema);
  assert.match(schema, /"enum":\["shared"\]/u);
  assert.doesNotMatch(schema, /isolated-worktree|base_ref/u);

  const command = addCommand() as ReturnType<typeof addCommand> & {
    operator: Record<string, unknown>;
  };
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-isolated-worktree",
        commands: [
          {
            ...command,
            operator: {
              ...command.operator,
              workspace: { kind: "isolated-worktree", base_ref: "main" },
            },
          },
        ],
      }),
      { toolCallId: "provider-call-isolated-worktree" },
    ),
    /workspace\.kind 当前仅支持 shared/u,
  );
  assert.equal(port.updates.length + port.reads.length + port.yields.length, 0);
});

test("update_agent_graph rejects unknown fields at every nested command boundary", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const base = addCommand() as ReturnType<typeof addCommand> & {
    operator: Record<string, unknown> & {
      profile: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    intent: Record<string, unknown>;
  };
  const cases = [
    { ...base, operator: { ...base.operator, forged_session_id: "session-forged" } },
    {
      ...base,
      operator: {
        ...base.operator,
        profile: { ...base.operator.profile, graph_id: "graph-forged" },
      },
    },
    {
      ...base,
      operator: {
        ...base.operator,
        workspace: { ...base.operator.workspace, path: "/forged" },
      },
    },
    { ...base, intent: { ...base.intent, requested_by: "forged-root" } },
    {
      kind: "stop",
      target: { kind: "intent", intent_id: "intent-research", generation: 1 },
    },
    { kind: "finish", selected_record_ids: [], root_run_id: "forged-run" },
  ];

  for (const [index, command] of cases.entries()) {
    await assert.rejects(
      update.execute(
        JSON.stringify({
          expected_revision: 0,
          operation_id: `operation-nested-extra-${index}`,
          commands: [command],
        }),
        { toolCallId: `provider-call-nested-extra-${index}` },
      ),
      /不支持字段/u,
    );
  }
  assert.equal(port.updates.length, 0);
});

test("update_agent_graph rejects deep policy JSON and duplicate command identities", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const invalidCommands = [
    [
      addCommand({
        operator: {
          ...(addCommand() as { operator: Record<string, unknown> }).operator,
          profile: {
            ...(addCommand() as { operator: { profile: Record<string, unknown> } }).operator
              .profile,
            permission_policy: nestedJson(32),
          },
        },
      }),
    ],
    [
      addCommand({
        operator: {
          ...(addCommand() as { operator: Record<string, unknown> }).operator,
          profile: {
            ...(addCommand() as { operator: { profile: Record<string, unknown> } }).operator
              .profile,
            permission_policy: Array.from({ length: 300 }, (_, index) => index),
          },
        },
      }),
    ],
    [
      { kind: "finish", selected_record_ids: ["record-1"] },
      { kind: "stop", target: { kind: "intent", intent_id: "intent-1" } },
    ],
    [{ kind: "finish" }, { kind: "finish" }],
    [addCommand(), { kind: "finish" }],
    [activateCommand(), { kind: "finish" }],
    [
      addCommand({
        intent: {
          intent_id: "intent-duplicate-input",
          instruction: "duplicate input",
          input_record_ids: ["record-1", "record-1"],
        },
      }),
    ],
    [
      addCommand({
        operator: {
          ...(addCommand() as { operator: Record<string, unknown> }).operator,
          profile: {
            ...(addCommand() as { operator: { profile: Record<string, unknown> } }).operator
              .profile,
            tools: ["read_file", "read_file"],
          },
        },
      }),
    ],
    [{ kind: "finish", selected_record_ids: ["record-1", "record-1"] }],
  ];

  for (const [index, commands] of invalidCommands.entries()) {
    await assert.rejects(
      update.execute(
        JSON.stringify({
          expected_revision: 0,
          operation_id: `operation-conflict-${index}`,
          commands,
        }),
        { toolCallId: `provider-call-conflict-${index}` },
      ),
      /嵌套过深|数组不得超过|finish 最多一条且必须是最后一条|finish 不能与 add 或 activate|不得包含重复项/u,
    );
  }
  assert.equal(port.updates.length, 0);
});

test("update_agent_graph enforces UTF-8 and collection limits at exact boundaries", async () => {
  const { port, byName } = fixture();
  const update = byName.get("update_agent_graph")!;
  const exactInstruction = "你".repeat(Math.floor(AGENT_GRAPH_MAX_INSTRUCTION_BYTES / 3)) + "ab";
  assert.equal(Buffer.byteLength(exactInstruction, "utf8"), AGENT_GRAPH_MAX_INSTRUCTION_BYTES);

  await update.execute(
    JSON.stringify({
      expected_revision: 0,
      operation_id: "operation-exact-instruction",
      commands: [
        addCommand({
          intent: {
            intent_id: "intent-exact-instruction",
            instruction: exactInstruction,
            input_record_ids: Array.from(
              { length: AGENT_GRAPH_MAX_INPUT_REFS },
              (_, index) => `record-${index}`,
            ),
          },
          operator: {
            ...(addCommand() as { operator: Record<string, unknown> }).operator,
            profile: {
              ...(addCommand() as { operator: { profile: Record<string, unknown> } }).operator
                .profile,
              tools: Array.from(
                { length: AGENT_GRAPH_MAX_PROFILE_TOOLS },
                (_, index) => `tool-${index}`,
              ),
            },
          },
        }),
      ],
    }),
    { toolCallId: "provider-call-exact-instruction" },
  );

  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 1,
        operation_id: "operation-over-instruction",
        commands: [
          addCommand({
            intent: {
              intent_id: "intent-over-instruction",
              instruction: `${exactInstruction}a`,
            },
          }),
        ],
      }),
      { toolCallId: "provider-call-over-instruction" },
    ),
    new RegExp(`不得超过 ${AGENT_GRAPH_MAX_INSTRUCTION_BYTES} 字节`, "u"),
  );

  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 1,
        operation_id: "operation-over-input-refs",
        commands: [
          addCommand({
            intent: {
              intent_id: "intent-over-input-refs",
              instruction: "too many input refs",
              input_record_ids: Array.from(
                { length: AGENT_GRAPH_MAX_INPUT_REFS + 1 },
                (_, index) => `record-over-${index}`,
              ),
            },
          }),
        ],
      }),
      { toolCallId: "provider-call-over-input-refs" },
    ),
    new RegExp(`input_record_ids 不得超过 ${AGENT_GRAPH_MAX_INPUT_REFS} 项`, "u"),
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 1,
        operation_id: "operation-over-profile-tools",
        commands: [
          addCommand({
            operator: {
              ...(addCommand() as { operator: Record<string, unknown> }).operator,
              profile: {
                ...(addCommand() as { operator: { profile: Record<string, unknown> } }).operator
                  .profile,
                tools: Array.from(
                  { length: AGENT_GRAPH_MAX_PROFILE_TOOLS + 1 },
                  (_, index) => `tool-over-${index}`,
                ),
              },
            },
          }),
        ],
      }),
      { toolCallId: "provider-call-over-profile-tools" },
    ),
    /profile\.tools 不得超过/u,
  );

  const exactCommands = Array.from({ length: AGENT_GRAPH_MAX_COMMANDS }, (_, index) => ({
    kind: "stop",
    target: { kind: "intent", intent_id: `intent-${index}` },
  }));
  await update.execute(
    JSON.stringify({
      expected_revision: 1,
      operation_id: "operation-exact-commands",
      commands: exactCommands,
    }),
    { toolCallId: "provider-call-exact-commands" },
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 2,
        operation_id: "operation-over-commands",
        commands: [...exactCommands, exactCommands[0]],
      }),
      { toolCallId: "provider-call-over-commands" },
    ),
    new RegExp(`commands 不得超过 ${AGENT_GRAPH_MAX_COMMANDS} 项`, "u"),
  );

  const finishIds = Array.from(
    { length: AGENT_GRAPH_MAX_SELECTED_RECORDS + 1 },
    (_, index) => `record-finish-${index}`,
  );
  await assert.rejects(
    update.execute(
      JSON.stringify({
        expected_revision: 2,
        operation_id: "operation-over-selected",
        commands: [{ kind: "finish", selected_record_ids: finishIds }],
      }),
      { toolCallId: "provider-call-over-selected" },
    ),
    new RegExp(`selected_record_ids 不得超过 ${AGENT_GRAPH_MAX_SELECTED_RECORDS} 项`, "u"),
  );

  const minimal = JSON.stringify({
    expected_revision: 2,
    operation_id: "operation-json-boundary",
    commands: [{ kind: "finish" }],
  });
  const exactJson = padJsonToBytes(minimal, AGENT_GRAPH_MAX_JSON_BYTES);
  await update.execute(exactJson, { toolCallId: "provider-call-exact-json" });
  await assert.rejects(
    update.execute(`${exactJson} `, { toolCallId: "provider-call-over-json" }),
    new RegExp(`JSON 不得超过 ${AGENT_GRAPH_MAX_JSON_BYTES} 字节`, "u"),
  );

  assert.equal(port.updates.length, 3);
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
          expected_revision: 0,
          operation_id: "operation-forged-context",
          commands: [addCommand()],
        }),
        { toolCallId: "provider-call-forged-context" },
      ),
      /调用上下文或参数|必须是非空字符串|非法 UTF-16\/UTF-8/u,
    );
    assert.equal(port.updates.length, 0);
  }

  const { port, byName } = fixture();
  await assert.rejects(
    byName.get("update_agent_graph")!.execute(
      JSON.stringify({
        expected_revision: 0,
        operation_id: "operation-missing-tool-call",
        commands: [addCommand()],
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
  assert.equal(port.updates.length + port.reads.length + port.yields.length, 0);
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
          expected_revision: 0,
          operation_id: `operation-padded-root-${index}`,
          commands: [addCommand()],
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
    assert.equal(port.updates.length + port.reads.length + port.yields.length, 0);
  }
});

test("view_agent_graph returns the application projection and yield_agent_graph forwards exact root/run/tool identity", async () => {
  const { port, byName } = fixture();
  const viewed = JSON.parse(await byName.get("view_agent_graph")!.execute("{}"));
  assert.deepEqual(viewed, EMPTY_VIEW);
  assert.deepEqual(port.reads, [{ graphId: ROOT.graphId, rootSessionId: ROOT.rootSessionId }]);

  await byName
    .get("view_agent_graph")!
    .execute(JSON.stringify({ record_ids: ["record-1", "record-2"] }));
  assert.deepEqual(port.reads[1], {
    graphId: ROOT.graphId,
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
