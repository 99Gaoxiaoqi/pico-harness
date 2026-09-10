import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../../../src/engine/session.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import {
  assertRuntimeEvent,
  type RuntimeToolStartedEvent,
} from "../../../src/storage/runtime-event.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import {
  ToolCommitBoundaryError,
  type BaseTool,
  type ToolRecoveryProbeResult,
} from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

async function scene(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-recovery-parity-"));
  const open = () =>
    new Session("recovery-parity", root, {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    });
  let session = open();
  await session.recover();
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get session() {
      return session;
    },
    async reopen() {
      await session.close();
      session = open();
      await session.recover();
      return session;
    },
  };
}

function fixture(execute: BaseTool["execute"]): BaseTool {
  return {
    name: () => "inspect_effect",
    nesting: "nestable",
    recoveryMode: "reconcile",
    recoveryKey: "probe:v1",
    accesses: () => ToolAccesses.none(),
    definition: () => ({
      name: "inspect_effect",
      description: "fixture",
      inputSchema: { type: "object" },
    }),
    execute,
  };
}

async function interrupt(
  session: Session,
  registry: ToolRegistry,
  id: string,
  argumentsJson = "{}",
  secrets: readonly string[] = [],
) {
  const store = session.runtimeEventStore!;
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const settle = store.settleToolOperation.bind(store);
  store.settleToolOperation = async () => {
    throw new Error("T2 failpoint");
  };
  try {
    await assert.rejects(
      run.executeNestedTool({ id, name: "inspect_effect", arguments: argumentsJson }, registry, {
        step: registry.captureStep("step", ["inspect_effect"]),
        parentToolCallId: "exec-parent",
        argumentRedactionSecrets: secrets,
      }),
      (error) => error instanceof ToolCommitBoundaryError && error.phase === "T2",
    );
  } finally {
    store.settleToolOperation = settle;
  }
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const events = await store.readRun(session.id, run.runId);
  const recovery = events.find(
    (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === id,
  );
  assert.ok(recovery?.kind === "tool.result.recorded");
  const started = events.find(
    (event) => event.kind === "tool.started" && event.refs?.toolCallId === id,
  );
  assert.ok(started?.kind === "tool.started");
  return { recovery, started };
}

test("T1保存最终完整脱敏参数和恢复合同，重启后probe读取审计且从不重执行", async (t) => {
  const state = await scene(t);
  const registry = new ToolRegistry();
  const secret = "host-secret-42";
  const args = JSON.stringify({
    path: "before",
    body: JSON.stringify({ password: "field-secret", values: [secret] }),
    nested: [{ api_key: "api-secret" }],
    text: `prefix ${secret} suffix`,
  });
  let executed = 0;
  let received = "";
  const tool = fixture(async (input) => {
    executed++;
    received = input;
    return "done";
  });
  registry.register(tool);
  registry.useRequest(async (call) => ({
    allowed: true,
    call: { ...call, arguments: JSON.stringify({ ...JSON.parse(call.arguments), path: "final" }) },
  }));
  const { started, recovery } = await interrupt(state.session, registry, "audit", args, [secret]);
  assert.equal(JSON.parse(received).path, "final");
  assert.ok(received.includes(secret));
  assert.equal(started.data.argumentsHash, createHash("sha256").update(received).digest("hex"));
  assert.equal(started.data.argumentsRedacted, true);
  assert.equal(started.data.recoveryMode, "reconcile");
  assert.equal(started.data.recoveryKey, "probe:v1");
  assert.ok(!JSON.stringify(started).includes(secret));
  assert.ok(!JSON.stringify(started).includes("field-secret"));
  assert.ok(!JSON.stringify(started).includes("api-secret"));
  assert.equal(JSON.parse(started.data.argumentsJson!).path, "final");
  assert.equal(JSON.parse(JSON.parse(started.data.argumentsJson!).body).password, "[REDACTED]");
  const session = await state.reopen();
  const persisted = (await session.runtimeEventStore!.readRun(session.id, started.runId)).find(
    (event) => event.eventId === started.eventId,
  );
  assert.deepEqual(persisted, started);
  let probes = 0;
  tool.reconcile = async (input) => {
    probes++;
    assert.equal(input.argumentsJson, started.data.argumentsJson);
    assert.equal(input.argumentsRedacted, true);
    assert.equal(input.runId, started.runId);
    return {
      outcome: "effects_verified",
      evidenceUri: "file:///verified/final",
      summary: "Host verified the effect",
    };
  };
  const resumed = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  assert.equal(
    (await resumed.reconcileToolRecovery({ recoveryEventId: recovery.eventId, registry })).outcome,
    "effects_verified",
  );
  await resumed.assertNoUnresolvedToolEffects();
  await resumed.reconcileToolRecovery({ recoveryEventId: recovery.eventId, registry });
  assert.equal(probes, 1);
  assert.equal(executed, 1);
  assert.deepEqual(
    (await session.runtimeEventStore!.readRun(session.id, started.runId)).find(
      (event) => event.eventId === started.eventId,
    ),
    started,
  );
  await resumed.finish("completed");
});

test("probe缺证据、策略变化、异常与取消均Park，只有稳定合同证据可追加解决事实", async (t) => {
  const { session } = await scene(t);
  const registry = new ToolRegistry();
  let executions = 0;
  const tool = fixture(async () => {
    executions++;
    return "done";
  });
  registry.register(tool);
  const { recovery } = await interrupt(session, registry, "park");
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const reconcile = (signal?: AbortSignal) =>
    run.reconcileToolRecovery({ recoveryEventId: recovery.eventId, registry, signal });
  const verified = {
    outcome: "not_dispatched_verified",
    evidenceUri: "probe://verified",
    summary: "Evidence confirms no dispatch",
  } as const;
  assert.equal((await reconcile()).outcome, "park");
  tool.reconcile = async () => verified;
  tool.recoveryKey = "probe:v2";
  assert.equal((await reconcile()).outcome, "park");
  tool.recoveryKey = "probe:v1";
  tool.recoveryMode = "idempotent";
  assert.equal((await reconcile()).outcome, "park");
  tool.recoveryMode = "reconcile";
  tool.reconcile = async () => ({ ...verified, evidenceUri: "" });
  assert.equal((await reconcile()).outcome, "park");
  tool.reconcile = async () => {
    throw new Error("private probe error");
  };
  assert.equal((await reconcile()).outcome, "park");
  tool.reconcile = async () => {
    tool.reconcile = async () => verified;
    return verified;
  };
  assert.equal(
    (await reconcile()).outcome,
    "park",
    "Replacing the callback while probing invalidates the result",
  );
  const cancelled = new AbortController();
  tool.reconcile = async () => {
    cancelled.abort();
    return verified;
  };
  assert.equal((await reconcile(cancelled.signal)).outcome, "park");
  const commitCancelled = new AbortController();
  tool.reconcile = async () => verified;
  const store = session.runtimeEventStore!;
  const readSession = store.readSession.bind(store);
  let reads = 0;
  store.readSession = async (sessionId) => {
    const events = await readSession(sessionId);
    if (++reads === 2) commitCancelled.abort();
    return events;
  };
  try {
    assert.equal((await reconcile(commitCancelled.signal)).outcome, "park");
  } finally {
    store.readSession = readSession;
  }
  assert.equal(
    (await session.runtimeEventStore!.readSession(session.id)).filter(
      (event) => event.kind === "tool.recovery.resolved",
    ).length,
    0,
  );
  await assert.rejects(run.assertNoUnresolvedToolEffects(), /Unresolved tool effects/);
  tool.reconcile = async () => verified;
  assert.equal((await reconcile()).outcome, "not_dispatched_verified");
  assert.equal(executions, 1);
  await run.assertNoUnresolvedToolEffects();
  await run.finish("completed");
});

test("同一未决调用并发probe或人工判决只能提交一个一致结论", async (t) => {
  const { session } = await scene(t);
  const registry = new ToolRegistry();
  const tool = fixture(async () => "done");
  registry.register(tool);
  const { recovery } = await interrupt(session, registry, "concurrent");
  const first = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const second = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  let release!: () => void;
  const bothProbing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probes = 0;
  tool.reconcile = async () => {
    const index = ++probes;
    if (index === 2) release();
    await bothProbing;
    return {
      outcome: index === 1 ? "effects_verified" : "not_dispatched_verified",
      evidenceUri: `probe://evidence/${index}`,
      summary: `Evidence ${index}`,
    };
  };
  const results = await Promise.allSettled(
    [first, second].map((run) =>
      run.reconcileToolRecovery({ recoveryEventId: recovery.eventId, registry }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const resolutions = (await session.runtimeEventStore!.readSession(session.id)).filter(
    (event) => event.kind === "tool.recovery.resolved",
  );
  assert.equal(resolutions.length, 1);
  const resolution = resolutions[0]!;
  assert.ok(resolution.kind === "tool.recovery.resolved");
  await assert.rejects(
    second.resolveToolRecovery({
      ...resolution.data,
      outcome:
        resolution.data.outcome === "effects_verified"
          ? "not_dispatched_verified"
          : "effects_verified",
    }),
    /different verified resolution/,
  );
  const existing = await second.reconcileToolRecovery({
    recoveryEventId: recovery.eventId,
    registry,
  });
  assert.equal(existing.outcome, resolution.data.outcome);
  assert.equal(probes, 2);
  await first.assertNoUnresolvedToolEffects();
  await first.finish("completed");
  await second.finish("completed");
});

test("旧hash-only记录可读但不能probe；损坏审计拒绝，超限T1禁止副作用", async (t) => {
  const { session } = await scene(t);
  const store = session.runtimeEventStore!;
  const registry = new ToolRegistry();
  let executions = 0;
  const tool = fixture(async () => {
    executions++;
    return "done";
  });
  tool.reconcile = async (): Promise<ToolRecoveryProbeResult> =>
    assert.fail("Legacy calls have no probe authority");
  registry.register(tool);
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const started = (await store.readRun(session.id, run.runId))[0]!;
  const legacy: RuntimeToolStartedEvent = {
    ...started,
    eventId: "legacy-start",
    kind: "tool.started",
    partial: false,
    visibility: "internal",
    refs: { toolCallId: "legacy", parentToolCallId: "exec-parent" },
    data: {
      toolName: "inspect_effect",
      origin: "code_mode",
      argumentsHash: createHash("sha256").update("{}").digest("hex"),
    },
  };
  assertRuntimeEvent(legacy);
  await store.prepareToolOperation({
    dispatchEvent: legacy,
    toolCallId: "legacy",
    ownerFence: await session.assertRuntimeEventWriteAllowed(),
  });
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const recovery = (await store.readRun(session.id, run.runId)).find(
    (event) => event.kind === "tool.result.recorded",
  );
  assert.ok(recovery?.kind === "tool.result.recorded");
  const resumed = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  assert.equal(
    (await resumed.reconcileToolRecovery({ recoveryEventId: recovery.eventId, registry })).outcome,
    "park",
  );
  assert.throws(
    () =>
      assertRuntimeEvent({
        ...legacy,
        data: {
          ...legacy.data,
          argumentsJson: "{}",
          argumentsRedacted: false,
          recoveryMode: "invalid",
        },
      }),
    /audit|contract/,
  );
  await assert.rejects(
    resumed.executeNestedTool(
      {
        id: "oversized",
        name: "inspect_effect",
        arguments: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
      },
      registry,
      {
        step: registry.captureStep("step", ["inspect_effect"]),
        parentToolCallId: "exec-parent",
      },
    ),
    (error) => error instanceof ToolCommitBoundaryError && error.phase === "T1",
  );
  assert.equal(executions, 0);
  assert.equal(
    (await store.readRun(session.id, resumed.runId)).some((event) => event.kind === "tool.started"),
    false,
  );
  await assert.rejects(resumed.assertNoUnresolvedToolEffects(), /Unresolved tool effects/);
  await resumed.finish("completed");
});
