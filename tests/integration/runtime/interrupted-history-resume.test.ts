import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FullCompactor, wrapFullCompactionSummary } from "@pico/pico-host/product-full-compactor";
import { recordRuntimeCompactionCheckpoint } from "@pico/runtime/runtime-compaction-checkpoint";
import { materializeRuntimeHistory } from "@pico/runtime/session-runtime-read-model";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { createSessionForkRuntimePort } from "@pico/pico-host/session-fork-runtime-port-adapter";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { ContextOverflowError } from "@pico/core";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";

test("恢复历史遇到无法压缩的上下文溢出时保留完整交换并报告错误", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-recovery-hard-reset-"));
  const runtimePort = createEngineRuntimePort();
  const session = new Session("recovery-hard-reset", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await session.commitMessages({ role: "user", content: "old request" });
  const abandoned = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await abandoned.recordTurnStarted(1);
  await abandoned.commitMessages(session, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "pending", name: "read_file", arguments: "{}" }],
    },
  ]);
  await session.commitMessages({ role: "user", content: "retry one" });
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  await RuntimeRun.repairSessionProjection(session, {
    capability: session.runtimeEventCapability!,
  });
  await session.commitMessages({ role: "user", content: "retry two" });
  let calls = 0;
  const engine = new AgentEngine({
    runtimePort,
    registry: new ToolRegistry(),
    workDir: session.workDir,
    provider: {
      async generate(messages) {
        assert.deepEqual(
          await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! }),
          [],
        );
        if (++calls === 1) throw new ContextOverflowError("fixture overflow");
        assert.ok(messages.some((m) => m.toolCallId === "pending"));
        assert.ok(messages.some((m) => m.content === "retry one"));
        return { role: "assistant", content: "recovered after overflow" };
      },
    },
  });
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await assert.rejects(
    run.run(() => engine.run(session)),
    ContextOverflowError,
  );
  assert.equal(calls, 1);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const checkpoint = events.find((e) => e.kind === "context.checkpoint.recorded");
  assert.equal(checkpoint, undefined, "不得用硬重置摘要替换未压缩的历史");
  const history = materializeRuntimeHistory(events);
  assert.ok(history.some((message) => message.toolCallId === "pending"));
  assert.ok(history.some((message) => message.content === "retry one"));
  assert.equal(history.at(-1)!.content, "retry two");
});

test("旧错序中断历史只读恢复，多工具分类保留，安全压缩后可重载并再次压缩", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-interrupted-history-"));
  const options = {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  };
  let session = new Session("interrupted-history", join(root, "workspace"), options);
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  await session.commitMessages({ role: "user", content: "original request" });
  const abandoned = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await abandoned.recordTurnStarted(1);
  const calls = [
    { id: "pending", name: "read_file", arguments: "{}" },
    { id: "dispatched", name: "write_file", arguments: "{}" },
  ];
  await abandoned.commitMessages(session, [{ role: "assistant", content: "", toolCalls: calls }]);
  await abandoned.recordToolStarted("dispatched", "write_file", "{}");
  // Reproduce the old Desktop ordering: new input persisted before reconciliation.
  await session.commitMessages({ role: "user", content: "retry one" });
  await RuntimeRun.reconcileIncompleteRuns({ capability: session.runtimeEventCapability! });
  const recovered = await session.runtimeEventStore!.readSession(session.id);
  const originalBytes = JSON.stringify(recovered);
  const receipts = recovered.filter((event) => event.kind === "tool.result.recorded");
  assert.deepEqual(
    receipts.map((e) => e.data.recovery?.classification),
    ["not_dispatched", "indeterminate"],
  );
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const history = await run.readModelHistoryEntries();
  assert.deepEqual(
    history.map((e) => e.message.toolCallId ?? e.message.content),
    ["original request", "", "pending", "dispatched", "retry one"],
  );
  assert.equal(history[3]!.compactionBoundarySafe, false, "不能把保留的 user 纳入原始覆盖边界");
  assert.equal(history[4]!.compactionBoundarySafe, false, "不能遗漏已覆盖的回执");
  assert.equal(
    JSON.stringify(await session.runtimeEventStore!.readSession(session.id)).startsWith(
      originalBytes.slice(0, -1),
    ),
    true,
  );

  const summary =
    "## Goal\nContinue work.\n## Progress\nRecovered tool exchange.\n## Next Steps\nContinue checking.\n## Critical Context\nTool batch must remain complete.";
  const wrappedSummary = wrapFullCompactionSummary(summary);
  let cut = 4;
  const compactor = new FullCompactor({
    provider: {
      async generate() {
        throw new Error("fixture preview only");
      },
    },
  });
  t.mock.method(compactor, "preview", async () => ({
    summary,
    wrappedSummary,
    compactedCount: cut,
    beforeTokens: 100,
    targetRetainedTokens: 1,
    retainedCount: 1,
    retainedTokens: 1,
  }));
  const compact = (active: RuntimeRun) =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: active,
      compactor,
      request: { trigger: "manual", inputBudgetTokens: 1000 },
      memoryDisposition: async () => "eligible",
    });
  await run.run(async () => {
    assert.equal(await compact(run), undefined);
    cut = 5;
    assert.equal(await compact(run), undefined);
    assert.equal(
      (await session.runtimeEventStore!.readSession(session.id)).filter(
        (e) => e.kind === "context.checkpoint.recorded",
      ).length,
      0,
    );
    await run.commitMessages(session, [
      { role: "user", content: "retry two" },
      { role: "assistant", content: "continued" },
    ]);
    cut = 6;
    assert.ok(await compact(run));
  });
  await session.close();
  session = new Session("interrupted-history", join(root, "workspace"), options);
  await session.recover();
  const next = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  assert.deepEqual(
    (await next.readModelHistory()).map((m) => m.content),
    [wrappedSummary, "continued"],
  );
  await next.run(async () => {
    await next.commitMessages(session, [
      { role: "user", content: "next" },
      { role: "assistant", content: "done" },
    ]);
    cut = 3;
    assert.ok(await compact(next));
  });
  const final = await session.runtimeEventStore!.readSession(session.id);
  assert.deepEqual(final.slice(0, recovered.length), recovered, "原始事件逐条不变");
  assert.deepEqual(
    materializeRuntimeHistory(final).map((m) => m.content),
    [wrappedSummary, "done"],
  );
  const snapshot = await session.readDurableForkSnapshot();
  const fork = {
    sourceSessionId: session.id,
    targetSessionId: "recovered-fork",
    seedEntries: snapshot.runtimeSeedEntries,
    modelCheckpoint: snapshot.modelCheckpoint,
    workDir: session.workDir,
    runtimeAuthority: session.runtimeEventStore!,
    publication: { async assertOwned() {} },
  };
  const port = createSessionForkRuntimePort();
  await port.bootstrapFork(fork);
  const forkEvents = await session.runtimeEventStore!.readSession("recovered-fork");
  assert.deepEqual(
    materializeRuntimeHistory(forkEvents).map((m) => m.content),
    [wrappedSummary, "done"],
  );
  await port.bootstrapFork(fork);
  assert.deepEqual(await session.runtimeEventStore!.readSession("recovered-fork"), forkEvents);

  // Corrupt variants must still fail closed; none is written into the database.
  const recoveryIndex = recovered.findIndex((e) => e.kind === "tool.result.recorded");
  for (const mutate of [
    (e: (typeof recovered)[number]) => ({ ...e, runId: "wrong-run" }),
    (e: (typeof recovered)[number]) => ({ ...e, turnId: "wrong-turn" }),
    (e: (typeof recovered)[number]) =>
      e.kind === "tool.result.recorded"
        ? { ...e, data: { ...e.data, status: "succeeded" as const } }
        : e,
  ]) {
    const invalid = [...recovered];
    invalid[recoveryIndex] = mutate(invalid[recoveryIndex]!);
    assert.throws(() => materializeRuntimeHistory(invalid));
  }
  assert.throws(() => materializeRuntimeHistory(recovered.filter((_, i) => i !== recoveryIndex)));
  assert.throws(() =>
    materializeRuntimeHistory([...recovered, { ...receipts[0]!, eventId: "duplicate-result" }]),
  );
  // A checkpoint between the input and recovery must not borrow a later receipt.
  const cp = final.find((e) => e.kind === "context.checkpoint.recorded")!;
  const crossed = [...recovered];
  crossed.splice(recoveryIndex, 0, cp);
  assert.throws(() => materializeRuntimeHistory(crossed));
});
