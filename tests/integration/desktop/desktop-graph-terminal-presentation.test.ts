import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentGraphReadOnlyQueryService,
  SqliteAgentGraphControlStoreAdapter,
  createBuiltinAgentGraphOperatorProfileCatalog,
  type AgentGraphTimelineItem,
} from "@pico/runtime";
import { agentOutputRecordIdFor } from "@pico/core/agent-graph-identities";
import type { AgentGraphRuntimeEventEnvelope } from "@pico/core/agent-graph-runtime-event-contracts";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import { parseGraphDetail } from "../../../apps/desktop/src/renderer/workbar-panels/GraphPanelController.js";
import { graphBoardCards } from "../../../apps/desktop/src/renderer/conversation/ConversationGraphBoard.js";

test("Graph cleanup preserves durable success, cancellation and failure in desktop cards and history", async (context) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-graph-terminal-display-"));
  let now = 10;
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: () => now++ });
  context.after(async () => {
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const control = new SqliteAgentGraphControlStoreAdapter(store);
  const query = new AgentGraphReadOnlyQueryService(store);
  const fixtures = [
    { runtime: "completed", output: "success", expected: "completed", label: "完成" },
    { runtime: "cancelled", output: "success", expected: "cancelled", label: "已停止" },
    { runtime: "failed", output: "success", expected: "failed", label: "失败" },
    { runtime: "completed", output: "failure", expected: "failed", label: "失败" },
    { runtime: "completed", expected: "failed", label: "失败" },
    { runtime: "interrupted", expected: "interrupted", label: "已中断" },
    { runtime: "running", expected: "cancelled", label: "已停止" },
  ] as const;

  for (const [index, fixture] of fixtures.entries()) {
    const rootSessionId = `root-${index}`;
    const { graphId } = store.openRootEpoch(rootSessionId).record;
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn",
      runId: "root-run",
      toolCallId: "add",
    };
    const recordId = agentOutputRecordIdFor(graphId, "intent");
    const profile = createBuiltinAgentGraphOperatorProfileCatalog().resolve({
      profileId: "explore",
      rootModelRouteId: "test/model",
    });
    control.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 0,
      operationId: "add",
      source,
      commands: [
        {
          kind: "add",
          operator: {
            graphId,
            operatorId: "operator",
            generation: 1,
            role: "reader",
            profileSnapshot: profile,
            workspacePolicy: { kind: "shared" },
          },
          intent: {
            graphId,
            intentId: "intent",
            operatorId: "operator",
            operatorGeneration: 1,
            instruction: "Read fixture",
            expectedOutputRecordId: recordId,
            inputRefs: [],
            createdAtRevision: 1,
            requestedBy: source,
          },
        },
      ],
    });
    const provisionId = `provision-${index}`;
    const claimId = `claim-${index}`;
    const targetSessionId = `child-${index}`;
    store.ensureOperatorProvision({
      provisionId,
      graphId,
      operatorId: "operator",
      generation: 1,
      scheduleRevision: 1,
      provisionFingerprint: "provision",
      childSessionId: targetSessionId,
      profileSnapshot: profile,
      workspaceBinding: { kind: "shared" },
    });
    store.transitionOperatorProvision({
      provisionId,
      expectedVersion: 1,
      from: "requested",
      to: "provisioned",
    });
    const claim = store.claimActivation({
      claimId,
      graphId,
      intentId: "intent",
      operatorId: "operator",
      operatorGeneration: 1,
      expectedGraphRevision: 1,
      intentFingerprint: "intent",
      readinessFingerprint: "ready",
      targetSessionId,
      targetRunId: `run-${index}`,
      targetTurnId: `turn-${index}`,
      targetInvocationId: `invocation-${index}`,
      runStartedEventId: `started-${index}`,
    }).record;
    store.transitionActivationClaim({
      claimId,
      expectedVersion: 1,
      from: "claimed",
      to: "executing",
    });
    const event = (
      eventId: string,
      kind: string,
      data: object,
    ): AgentGraphRuntimeEventEnvelope => ({
      schemaVersion: 2,
      eventId,
      sessionId: targetSessionId,
      runId: claim.targetRunId,
      turnId: claim.targetTurnId,
      invocationId: claim.targetInvocationId,
      at: "2026-09-16T00:00:00.000Z",
      partial: false,
      visibility: "internal",
      kind,
      data,
    });
    const events = [event(claim.runStartedEventId, "run.started", {})];
    if ("output" in fixture) {
      const output = event(`output-${index}`, "agent.output", {
        payload: { activationId: claimId, status: fixture.output },
      });
      events.push(output);
      store.putRecordRef({
        recordId,
        graphId,
        claimId,
        operatorId: "operator",
        operatorGeneration: 1,
        recordFingerprint: "output",
        sourceSessionId: targetSessionId,
        sourceTurnId: claim.targetTurnId,
        sourceRunId: claim.targetRunId,
        sourceEventId: output.eventId,
        kind: "agent_output",
      });
    }
    if (fixture.runtime !== "running")
      events.push(event(`terminal-${index}`, "run.terminal", { status: fixture.runtime }));
    control.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 1,
      operationId: "finish",
      source: { ...source, toolCallId: "finish" },
      commands: [{ kind: "finish" }],
    });
    // This is the existing reconciler cleanup transition, independent of Runtime outcome.
    store.transitionActivationClaim({
      claimId,
      expectedVersion: 2,
      from: "executing",
      to: "cancelled",
      cancellationReason: "Graph finished",
    });

    const facts = await query.queryRuntimeFacts(
      graphId,
      {
        readRun: () => events,
        readEvent: (eventId) => events.find((item) => item.eventId === eventId),
      },
      { inspect: () => ({ status: "running" }) },
    );
    const rawDetail = query.query({ rootSessionId, action: "get", graphId }) as Record<
      string,
      unknown
    >;
    const detail = parseGraphDetail({ ...rawDetail, ...facts });
    assert.equal(detail.summary.phase, "finished");
    assert.equal(detail.claims[0]?.state, fixture.expected, JSON.stringify(fixture));
    assert.equal(graphBoardCards(detail)[0]?.label, fixture.label);
    assert.equal(
      store.listActivationClaims(graphId)[0]?.state,
      "cancelled",
      "display must not mutate cleanup facts",
    );
    store.transitionOperatorProvision({
      provisionId,
      expectedVersion: 2,
      from: "provisioned",
      to: "stopped",
    });
    const timeline = query.query({ rootSessionId, action: "timeline", graphId }) as {
      items: AgentGraphTimelineItem[];
    };
    assert.equal(
      timeline.items.find((item) => item.kind === "activation.executing")?.status,
      "executing",
    );
    assert.equal(
      timeline.items.find((item) => item.kind === "operator.provisioned")?.status,
      "provisioned",
    );
    assert.equal(
      timeline.items.find((item) => item.kind === "activation.cancelled")?.status,
      "cancelled",
    );
  }
});
