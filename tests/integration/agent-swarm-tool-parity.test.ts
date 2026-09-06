import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogAgentProfile } from "../../src/agents/catalog.js";
import { compileAgentGraphWork } from "../../src/agent-graph/work-request.js";
import {
  assertValidAgentGraphOperatorProfileSnapshot,
  createCatalogAgentGraphOperatorProfileCatalog,
} from "../../src/agent-graph/operator-profile-catalog.js";
import {
  createAgentGraphSupervisorTools,
  type AgentGraphRootToolContext,
  type AgentGraphSupervisorToolPort,
  type AgentGraphSupervisorView,
  type ReadAgentGraphProjectionInput,
} from "../../src/tools/agent-graph-tools.js";

const root: AgentGraphRootToolContext = {
  kind: "graph_root_supervisor",
  graphId: "graph",
  epoch: 1,
  rootSessionId: "root",
  rootTurnId: "turn",
  rootRunId: "run",
  rootModelRouteId: "parent/model",
  supervision: { mode: "swarm", authorization: "session_mode" },
};
const profile: CatalogAgentProfile = {
  name: "custom-reviewer",
  description: "Review a bounded change",
  systemPrompt: "Approved custom prompt",
  tools: ["read_file", "code_diagnostics"],
  modelRouteId: "provider/reviewer",
  thinkingEffort: "high",
  maxTurns: 12,
  source: "project-native",
  sourcePath: "/workspace/.pico/agents.yaml",
};
function fixture() {
  const catalog = createCatalogAgentGraphOperatorProfileCatalog([profile]);
  let view: AgentGraphSupervisorView = {
    graph: {
      graphId: "graph",
      rootSessionId: "root",
      epoch: 1,
      admissionPhase: "open",
      headRevision: 0,
      selectedRecordIds: [],
      createdAt: 1,
    },
    operators: [],
    intents: [],
    claims: [],
    provisions: [],
    stops: [],
    records: [],
    availableOperatorProfiles: catalog.listPublicProfiles(),
    intentReadiness: [],
    runtimeClaims: [],
    results: { records: [], totalBytes: 0, truncated: false },
  };
  const reads: ReadAgentGraphProjectionInput[] = [];
  const commands: ReturnType<typeof compileAgentGraphWork>[] = [];
  const port: AgentGraphSupervisorToolPort = {
    async commitWork(input) {
      const compiled = compileAgentGraphWork(
        input,
        input.source.toolCallId,
        view.graph.headRevision,
        [],
      );
      commands.push(compiled);
      for (const command of compiled)
        if (command.kind === "add")
          catalog.resolve({
            profileId: command.operator.profileId,
            rootModelRouteId: input.rootModelRouteId,
          });
      const intents = compiled.flatMap((command) =>
        command.kind === "add" || command.kind === "activate" ? [command.intent] : [],
      );
      view = {
        ...view,
        graph: { ...view.graph, headRevision: view.graph.headRevision + 1 },
        intents: [...view.intents, ...intents],
      };
      return { revision: view.graph.headRevision, replayed: false, projection: view };
    },
    async commitUpdate() {
      throw new Error("legacy update unused");
    },
    async readProjection(input) {
      reads.push(input);
      const records = view.results.records.filter((result) =>
        input.recordIds?.includes(result.recordId),
      );
      return {
        ...view,
        availableOperatorProfiles: catalog.listPublicProfiles(),
        results: {
          records,
          totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
          truncated: false,
        },
      };
    },
    async registerYield() {
      return { permitId: "permit", snapshot: view };
    },
    cancelYield() {},
  };
  const tools = new Map(
    createAgentGraphSupervisorTools({ swarm: true, getRootContext: () => root, port }).map(
      (tool) => [tool.name(), tool],
    ),
  );
  return {
    catalog,
    tools,
    reads,
    commands,
    setView: (next: AgentGraphSupervisorView) => {
      view = next;
    },
    getView: () => view,
  };
}

test("Swarm selects approved catalog presets and compiles Maka target/replacement semantics", async () => {
  const f = fixture();
  assert.equal(f.tools.has("agent_graph_results"), false);
  const list = JSON.parse(await f.tools.get("agent_list")!.execute("{}"));
  assert.deepEqual(
    list.presets.map((item: { subagent_id: string }) => item.subagent_id),
    [profile.name],
  );
  assert.equal(JSON.stringify(list).includes(profile.systemPrompt), false);
  assert.deepEqual(f.reads[0]!.recordIds, []);
  const update = f.tools.get("update_agent_graph")!;
  const scheduled = JSON.parse(
    await update.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [
          {
            target_kind: "new_preset",
            subagent_id: profile.name,
            operator_id: "provider-placeholder",
            instruction: "Review",
            replacement_mode: "none",
            replaces: "ignored-placeholder",
          },
        ],
      }),
      { toolCallId: "schedule" },
    ),
  );
  assert.equal(scheduled.work.length, 1);
  assert.equal(f.commands[0]!.length, 1);
  const snapshot = f.catalog.resolve({ profileId: profile.name, rootModelRouteId: "parent/model" });
  assertValidAgentGraphOperatorProfileSnapshot(snapshot);
  assert.equal(snapshot.systemPrompt.content, profile.systemPrompt);
  assert.deepEqual(snapshot.tools, profile.tools);
  assert.equal(snapshot.modelRouteId, profile.modelRouteId);
  assert.equal(snapshot.thinkingEffort, "high");
  assert.equal(snapshot.maxTurns, 12);
  await update.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [
        {
          target_kind: "new_preset",
          subagent_id: profile.name,
          instruction: "Retry",
          replacement_mode: "replace",
          replaces: scheduled.work[0].workId,
        },
      ],
    }),
    { toolCallId: "retry" },
  );
  assert.equal(f.commands[1]![0]!.kind, "stop");
  const replacement = f.commands[1]![1]!;
  assert.equal(replacement.kind, "add");
  if (replacement.kind === "add")
    assert.equal(replacement.intent.replacesIntentId, scheduled.work[0].workId);
  await assert.rejects(
    update.execute(
      JSON.stringify({
        operation: "add_work",
        add_work: [
          {
            target_kind: "new_preset",
            subagent_id: profile.name,
            instruction: "Invalid",
            replacement_mode: "replace",
          },
        ],
      }),
      { toolCallId: "bad" },
    ),
    /replaces/,
  );
  await f.tools
    .get("yield_agent_graph")!
    .execute(JSON.stringify({ reason: "Waiting for results" }), { toolCallId: "yield" });
  await update.execute(
    JSON.stringify({
      operation: "stop",
      stop: [{ target_id: scheduled.work[0].workId, reason: "Stop selected work" }],
      finish: { provider: "placeholder" },
    }),
    { toolCallId: "stop" },
  );
  assert.equal(f.commands.at(-1)![0]!.kind, "stop");
  await update.execute(
    JSON.stringify({
      operation: "finish",
      finish: { result_ids: [], reason: "No useful result remains" },
      add_work: [{ provider: "placeholder" }],
    }),
    { toolCallId: "finish" },
  );
  assert.equal(f.commands.at(-1)![0]!.kind, "finish");
  assert.equal(
    f.catalog.resolve({ profileId: "review", rootModelRouteId: "parent/model" }).profileId,
    "review",
  );
  f.catalog.replaceProfiles([
    { ...profile, name: "new-choice", modelRouteId: "inherit" },
    { ...profile, name: "hook-role", hooks: {} },
  ]);
  assert.deepEqual(
    f.catalog.listPublicProfiles().map((item) => item.profileId),
    ["new-choice"],
  );
  assert.throws(
    () => f.catalog.resolve({ profileId: "hook-role", rootModelRouteId: "parent/model" }),
    /hooks/,
  );
  assert.equal(
    f.catalog.resolve({ profileId: "new-choice", rootModelRouteId: "parent/model" }).modelRouteId,
    "parent/model",
  );
  assertValidAgentGraphOperatorProfileSnapshot(snapshot);
});

test("Root agent_output reads only selected formal results by work or Maka execution locator", async () => {
  const f = fixture();
  await f.tools.get("update_agent_graph")!.execute(
    JSON.stringify({
      operation: "add_work",
      add_work: [{ subagent_id: profile.name, instruction: "Review" }],
    }),
    { toolCallId: "schedule" },
  );
  const view = f.getView();
  const intent = view.intents[0]!;
  const content = "Formal verified result";
  const claim = {
    claimId: "claim",
    graphId: "graph",
    intentId: intent.intentId,
    operatorId: intent.operatorId,
    operatorGeneration: 1,
    scheduleRevision: 1,
    intentFingerprint: "i",
    readinessFingerprint: "r",
    state: "executing" as const,
    targetSessionId: "child",
    targetTurnId: "child-turn",
    targetRunId: "child-run",
    targetInvocationId: "invocation",
    runStartedEventId: "start",
    claimedAt: 1,
  };
  const record = {
    recordId: intent.expectedOutputRecordId,
    graphId: "graph",
    operatorId: intent.operatorId,
    operatorGeneration: 1,
    activationClaimId: "claim",
    sourceSessionId: "child",
    sourceTurnId: "child-turn",
    sourceRunId: "child-run",
    sourceEventId: "output",
    kind: "agent-output" as const,
    createdAt: 1,
  };
  f.setView({
    ...view,
    claims: [claim],
    records: [record],
    intentReadiness: [
      {
        intentId: intent.intentId,
        status: "resolved",
        resolvedRecordIds: [],
        inFlightRecordIds: [],
        failedRecordIds: [],
        unknownRecordIds: [],
      },
    ],
    results: {
      records: [
        {
          recordId: record.recordId,
          status: "success",
          provenance: {
            graphId: "graph",
            operatorId: intent.operatorId,
            operatorGeneration: 1,
            claimId: "claim",
            sessionId: "child",
            turnId: "child-turn",
            runId: "child-run",
            invocationId: "invocation",
            eventId: "output",
          },
          content,
          bytes: Buffer.byteLength(content),
          truncated: false,
          resources: [],
        },
      ],
      totalBytes: Buffer.byteLength(content),
      truncated: false,
    },
  });
  const output = f.tools.get("agent_output")!;
  assert.equal(output.readOnly, true);
  for (const selector of [
    { work_ids: [intent.intentId] },
    { locator: "child_session_run", child_session_id: "child", run_id: "child-run" },
    { locator: "child_session_latest", child_session_id: "child", run_id: "ignored-placeholder" },
  ]) {
    const result = JSON.parse(
      await output.execute(JSON.stringify({ view: "result", ...selector })),
    );
    assert.equal(result.records[0].content, content);
    assert.equal(result.records[0].recordId, record.recordId);
    assert.deepEqual(f.reads.at(-1)!.recordIds, [record.recordId]);
  }
  await assert.rejects(
    output.execute(
      JSON.stringify({
        view: "result",
        locator: "child_session_run",
        child_session_id: "other-graph-child",
        run_id: "child-run",
      }),
    ),
    /未找到/,
  );
  await assert.rejects(
    output.execute(JSON.stringify({ status: "success", content: "Cannot submit" })),
    /参数无效/,
  );
});
