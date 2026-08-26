import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_OUTPUT_MAX_BYTES,
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
