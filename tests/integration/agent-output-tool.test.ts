import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_OUTPUT_MAX_BYTES,
  AGENT_OUTPUT_MAX_REFS,
  AGENT_OUTPUT_MAX_REF_BYTES,
  createAgentOutputTool,
  type AgentOutputCommitPort,
  type CommitAgentOutputInput,
  type GraphOperatorActivationContext,
} from "../../src/tools/agent-output-tool.js";

const ACTIVATION: GraphOperatorActivationContext = {
  kind: "graph_operator_activation",
  graphId: "graph-1",
  operatorId: "researcher",
  operatorGeneration: 1,
  activationId: "activation-1",
  sessionId: "child-session-1",
  turnId: "child-turn-1",
  runId: "child-run-1",
};

function fixture(context: GraphOperatorActivationContext | null = ACTIVATION) {
  const commits: CommitAgentOutputInput[] = [];
  const port: AgentOutputCommitPort = {
    async commitAgentOutput(input) {
      commits.push(input);
      return {
        eventId: "event-agent-output-1",
        recordId: "record-agent-output-1",
        replayed: commits.length > 1,
      };
    },
  };
  return {
    commits,
    tool: createAgentOutputTool({ getActivationContext: () => context ?? undefined, port }),
  };
}

test("agent_output commits a stable success RuntimeEvent payload through its port", async () => {
  const { tool, commits } = fixture();
  const raw = await tool.execute(
    JSON.stringify({
      status: "success",
      output: "  已完成调研  ",
      evidence_refs: ["evidence://finding-1"],
      artifact_refs: ["artifact://report-1"],
    }),
    { toolCallId: "call-agent-output-1" },
  );

  assert.deepEqual(JSON.parse(raw), {
    status: "committed",
    eventId: "event-agent-output-1",
    recordId: "record-agent-output-1",
    replayed: false,
    idempotencyKey: commits[0]?.idempotencyKey,
  });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.activation, ACTIVATION);
  assert.equal(commits[0]?.toolCallId, "call-agent-output-1");
  assert.deepEqual(commits[0]?.eventPayload, {
    schemaVersion: "pico.agent_output.v1",
    graphId: "graph-1",
    operatorId: "researcher",
    operatorGeneration: 1,
    activationId: "activation-1",
    status: "success",
    output: "已完成调研",
    outputBytes: Buffer.byteLength("已完成调研", "utf8"),
    evidenceRefs: ["evidence://finding-1"],
    artifactRefs: ["artifact://report-1"],
    idempotencyKey: commits[0]?.idempotencyKey,
    fingerprint: commits[0]?.fingerprint,
  });
  assert.match(commits[0]!.idempotencyKey, /^agent-output:[a-f0-9]{64}$/u);
  assert.match(commits[0]!.fingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test("agent_output explicitly commits failure without inferring status from output text", async () => {
  const { tool, commits } = fixture();
  await tool.execute(
    JSON.stringify({ status: "failure", output: "任务看似已完成，但缺少必需证据。" }),
    { toolCallId: "call-agent-output-failure" },
  );
  assert.equal(commits[0]?.eventPayload.status, "failure");
  assert.equal(commits[0]?.eventPayload.output, "任务看似已完成，但缺少必需证据。");

  await assert.rejects(
    tool.execute(JSON.stringify({ output: "我完成了" }), { toolCallId: "call-missing-status" }),
    /status 必须是 success 或 failure/u,
  );
});

test("agent_output rejects calls outside a Graph operator activation", async () => {
  const { tool, commits } = fixture(null);
  await assert.rejects(
    tool.execute(JSON.stringify({ status: "success", output: "done" }), {
      toolCallId: "call-root-session",
    }),
    /仅可由有效的 Graph operator activation/u,
  );
  assert.equal(commits.length, 0);
});

test("agent_output rejects empty and byte-bounded output plus invalid refs", async () => {
  const { tool, commits } = fixture();
  await assert.rejects(
    tool.execute(JSON.stringify({ status: "success", output: "   " }), {
      toolCallId: "call-empty-output",
    }),
    /output 必须是非空字符串/u,
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({ status: "success", output: "你".repeat(AGENT_OUTPUT_MAX_BYTES) }),
      {
        toolCallId: "call-large-output",
      },
    ),
    new RegExp(`output 不得超过 ${AGENT_OUTPUT_MAX_BYTES} 字节`, "u"),
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({ status: "success", output: "done", evidence_refs: ["evidence://x", ""] }),
      { toolCallId: "call-empty-ref" },
    ),
    /evidence_refs\[1\] 必须是非空字符串/u,
  );
  assert.equal(commits.length, 0);
});

test("agent_output enforces exact UTF-8 byte and reference-count boundaries", async () => {
  const { tool, commits } = fixture();
  const exactOutput = "🛠".repeat(AGENT_OUTPUT_MAX_BYTES / 4);
  assert.equal(Buffer.byteLength(exactOutput, "utf8"), AGENT_OUTPUT_MAX_BYTES);
  await tool.execute(JSON.stringify({ status: "success", output: exactOutput }), {
    toolCallId: "call-exact-output",
  });
  assert.equal(commits[0]?.eventPayload.outputBytes, AGENT_OUTPUT_MAX_BYTES);

  await assert.rejects(
    tool.execute(JSON.stringify({ status: "success", output: `${exactOutput}a` }), {
      toolCallId: "call-over-output",
    }),
    new RegExp(`output 不得超过 ${AGENT_OUTPUT_MAX_BYTES} 字节`, "u"),
  );

  const exactRef = "r".repeat(AGENT_OUTPUT_MAX_REF_BYTES);
  const half = AGENT_OUTPUT_MAX_REFS / 2;
  const evidenceRefs = Array.from({ length: half }, (_, index) => `evidence://${index}`);
  const artifactRefs = Array.from({ length: half }, (_, index) => `artifact://${index}`);
  evidenceRefs[0] = exactRef;
  await tool.execute(
    JSON.stringify({
      status: "failure",
      output: "bounded refs",
      evidence_refs: evidenceRefs,
      artifact_refs: artifactRefs,
    }),
    { toolCallId: "call-exact-refs" },
  );
  assert.equal(
    commits[1]!.eventPayload.evidenceRefs.length + commits[1]!.eventPayload.artifactRefs.length,
    AGENT_OUTPUT_MAX_REFS,
  );
  assert.equal(
    Buffer.byteLength(commits[1]!.eventPayload.evidenceRefs[0]!, "utf8"),
    exactRef.length,
  );

  await assert.rejects(
    tool.execute(
      JSON.stringify({
        status: "success",
        output: "over ref bytes",
        evidence_refs: [`${exactRef}a`],
      }),
      { toolCallId: "call-over-ref-bytes" },
    ),
    /evidence_refs\[0\] 不得超过/u,
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        status: "success",
        output: "over total refs",
        evidence_refs: [...evidenceRefs, "evidence://overflow"],
        artifact_refs: artifactRefs,
      }),
      { toolCallId: "call-over-total-refs" },
    ),
    new RegExp(`合计不得超过 ${AGENT_OUTPUT_MAX_REFS} 项`, "u"),
  );
  assert.equal(commits.length, 2);
});

test("agent_output rejects exact-shape, status, and malformed ref extremes without commit", async () => {
  const { tool, commits } = fixture();
  const cases: ReadonlyArray<{ readonly input: unknown; readonly error: RegExp }> = [
    { input: null, error: /期望 JSON 对象/u },
    { input: [], error: /期望 JSON 对象/u },
    {
      input: { status: "success", output: "done", graph_id: "forged-graph" },
      error: /不支持字段 graph_id/u,
    },
    { input: { status: "SUCCESS", output: "done" }, error: /status 必须是/u },
    { input: { status: true, output: "done" }, error: /status 必须是/u },
    { input: { status: null, output: "done" }, error: /status 必须是/u },
    {
      input: { status: "success", output: "done", evidence_refs: "evidence://not-array" },
      error: /evidence_refs 必须是字符串数组/u,
    },
    {
      input: {
        status: "success",
        output: "done",
        evidence_refs: ["evidence://same", "evidence://same"],
      },
      error: /evidence_refs 不得包含重复引用/u,
    },
    {
      input: { status: "success", output: "done", artifact_refs: ["artifact://bad\nref"] },
      error: /artifact_refs\[0\] 不得包含控制字符/u,
    },
    {
      input: { status: "success", output: "\ud800" },
      error: /output 包含非法 UTF-16\/UTF-8/u,
    },
    {
      input: { status: "success", output: "done", evidence_refs: ["evidence://\udc00"] },
      error: /evidence_refs\[0\] 包含非法 UTF-16\/UTF-8/u,
    },
    {
      input: {
        status: "success",
        output: "done",
        evidence_refs: [" provenance://same "],
        artifact_refs: ["provenance://same"],
      },
      error: /evidence_refs 与 artifact_refs 不得包含相同引用/u,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await assert.rejects(
      tool.execute(JSON.stringify(entry.input), { toolCallId: `call-invalid-${index}` }),
      entry.error,
    );
  }
  assert.equal(commits.length, 0);
});

test("agent_output rejects forged activation and tool-call identities before commit", async () => {
  const contexts = [
    { ...ACTIVATION, kind: "graph_root_supervisor" },
    { ...ACTIVATION, graphId: "forged graph" },
    { ...ACTIVATION, operatorId: "" },
    { ...ACTIVATION, operatorGeneration: 0 },
    { ...ACTIVATION, operatorGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...ACTIVATION, activationId: "activation\nid" },
    { ...ACTIVATION, sessionId: " session" },
    { ...ACTIVATION, turnId: "turn " },
    { ...ACTIVATION, runId: "run\tid" },
    { ...ACTIVATION, runId: "\ud800" },
  ];

  for (const [index, context] of contexts.entries()) {
    const { tool, commits } = fixture(context as GraphOperatorActivationContext);
    await assert.rejects(
      tool.execute(JSON.stringify({ status: "success", output: "done" }), {
        toolCallId: `call-forged-context-${index}`,
      }),
      /仅可由有效|调用上下文|operatorGeneration 无效/u,
    );
    assert.equal(commits.length, 0);
  }

  for (const toolCallId of [undefined, "", " call", "call\nid", "\udc00"] as const) {
    const { tool, commits } = fixture();
    await assert.rejects(
      tool.execute(
        JSON.stringify({ status: "success", output: "done" }),
        toolCallId === undefined ? undefined : { toolCallId },
      ),
      /toolCallId (?:无效|包含非法)/u,
    );
    assert.equal(commits.length, 0);
  }
});

test("agent_output passes the same activation idempotency key across replayed tool calls", async () => {
  const { tool, commits } = fixture();
  const args = JSON.stringify({
    status: "success",
    output: "deterministic result",
    evidence_refs: ["evidence://one"],
  });

  await tool.execute(args, { toolCallId: "call-first" });
  const replay = JSON.parse(await tool.execute(args, { toolCallId: "call-replayed" })) as {
    replayed: boolean;
    idempotencyKey: string;
  };

  assert.equal(commits.length, 2);
  assert.notEqual(commits[0]?.toolCallId, commits[1]?.toolCallId);
  assert.equal(commits[0]?.idempotencyKey, commits[1]?.idempotencyKey);
  assert.equal(commits[0]?.fingerprint, commits[1]?.fingerprint);
  assert.equal(replay.replayed, true);
  assert.equal(replay.idempotencyKey, commits[0]?.idempotencyKey);
});
