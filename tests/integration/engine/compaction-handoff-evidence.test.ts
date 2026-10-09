import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type { Message } from "@pico/core";
import { FullCompactor, wrapFullCompactionSummary } from "@pico/runtime/full-compactor";
import {
  HANDOFF_EVIDENCE_METADATA_KEY,
  isCompactionEvidenceMetadata,
  recordRuntimeCompactionCheckpoint,
  renderCompactionEvidenceReference,
  resolveCompactionEvidenceReferences,
} from "@pico/runtime/runtime-compaction-checkpoint";
import {
  materializeRuntimeHistory,
  readRuntimeModelHistorySnapshot,
} from "@pico/runtime/session-runtime-read-model";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { isValidStoredCompactionSummary } from "../../../packages/runtime/src/history-compact-summary-validation.js";
import { contextSummaryBody } from "../../fixtures/context-summary.js";
import {
  checkpointRun,
  createHandoffFixture,
  handoffSummary,
} from "../../fixtures/compaction-handoff.js";

const request = { trigger: "manual" as const, inputBudgetTokens: 4000, targetRetainedTokens: 1 };

test("v2 durable evidence survives rolling compaction/restart and rejects mutated sources, sequences, boundaries and predecessor chains", async (t) => {
  const fixture = await createHandoffFixture("pico-handoff-", "ACTUAL_REPORT_TOKEN");
  let active = fixture.session;
  t.after(async () => {
    await active.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const references = [fixture.report.eventId, fixture.failed.eventId];
  const body = handoffSummary(
    references
      .map(
        (id) => `- ${renderCompactionEvidenceReference(id)} 原始工具结果；引用本身不证明摘要结论。`,
      )
      .join("\n"),
  );
  const originalEvents = await active.runtimeEventStore!.readSession(active.id);
  for (let round = 0; round < 2; round++) {
    const run = await RuntimeRun.start({
      capability: active.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      if (round)
        await run.commitMessages(active, [
          { role: "user", content: "继续核查，不要重复旧失败方案。" },
          { role: "assistant", content: "等待归档读取。" },
        ]);
      const result = await recordRuntimeCompactionCheckpoint({
        session: active,
        runtimeRun: checkpointRun(active, run),
        compactor: new FullCompactor({
          provider: {
            async generate(messages) {
              for (const id of references)
                assert.ok(messages[1]!.content.includes(renderCompactionEvidenceReference(id)));
              return { role: "assistant", content: body };
            },
          },
          maxAttempts: 1,
        }),
        request,
      });
      assert.ok(result);
      assert.equal(result.preview.summaryFormat, "sections_v2");
    });
  }
  const entries = await active.runtimeEventStore!.readSessionEntries(active.id);
  const events = entries.map(({ event }) => event);
  const sequences = new Map(entries.map(({ event, sequence }) => [event.eventId, sequence]));
  const checkpoints = events.filter((event) => event.kind === "context.checkpoint.recorded");
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[1]!.data.previousCheckpointId, checkpoints[0]!.data.checkpointId);
  const metadata = checkpoints[1]!.data.summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
  assert.ok(isCompactionEvidenceMetadata(metadata));
  assert.deepEqual(
    metadata.references.map(({ eventId }) => eventId),
    references,
  );
  assert.equal(metadata.references[0]!.sequence, sequences.get(fixture.report.eventId));
  assert.equal(metadata.references[0]!.status, "succeeded");
  assert.equal(metadata.references[1]!.status, "failed");
  assert.ok(metadata.references[0]!.archiveRef);
  assert.equal("observed" in metadata.references[0]!, false);
  assert.equal(JSON.stringify(metadata).includes(fixture.rawReport), false);
  assert.match(checkpoints[1]!.data.summary.content, /pico_handoff_sources/);
  assert.deepEqual(
    events.slice(0, originalEvents.length),
    originalEvents,
    "original persisted facts stay byte-equivalent",
  );
  const expected = materializeRuntimeHistory(events, sequences);
  await active.close();
  active = new Session(fixture.session.id, fixture.workDir, {
    picoHome: fixture.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  await active.recover();
  assert.deepEqual(
    (await readRuntimeModelHistorySnapshot(active.runtimeEventStore!, active.id)).messages,
    expected,
  );

  const mutated = events.map((event) =>
    event.kind === "tool.result.recorded" && event.eventId === fixture.report.eventId
      ? { ...event, data: { ...event.data, status: "failed" as const } }
      : event,
  );
  assert.throws(() => materializeRuntimeHistory(mutated, sequences), /invalid handoff evidence/);
  const wrongSequence = new Map(sequences).set(
    fixture.report.eventId,
    metadata.references[0]!.sequence + 1,
  );
  assert.throws(() => materializeRuntimeHistory(events, wrongSequence), /invalid handoff evidence/);
  const missingSequence = new Map(sequences);
  missingSequence.delete(fixture.report.eventId);
  assert.throws(
    () => materializeRuntimeHistory(events, missingSequence),
    /invalid handoff evidence/,
  );
  const chainTamper = events.map((event) =>
    event.eventId === checkpoints[0]!.eventId && event.kind === "context.checkpoint.recorded"
      ? {
          ...event,
          data: {
            ...event.data,
            summary: {
              ...event.data.summary,
              providerData: {
                ...event.data.summary.providerData,
                [HANDOFF_EVIDENCE_METADATA_KEY]: { ...metadata, summarySha256: "0".repeat(64) },
              },
            },
          },
        }
      : event,
  );
  assert.throws(
    () => materializeRuntimeHistory(chainTamper, sequences),
    /invalid handoff evidence/,
  );
  const input = {
    sessionId: active.id,
    throughEventId: originalEvents[0]!.eventId,
    summaryText: body,
    references,
  };
  assert.equal(
    resolveCompactionEvidenceReferences(entries, input),
    undefined,
    "reference beyond folded raw boundary fails",
  );
  assert.equal(
    resolveCompactionEvidenceReferences(entries, { ...input, sessionId: "other-session" }),
    undefined,
  );
  assert.equal(isCompactionEvidenceMetadata({ ...metadata, observed: true }), false);
  assert.equal(
    isCompactionEvidenceMetadata({
      ...metadata,
      references: [{ ...metadata.references[0], observed: true }],
    }),
    false,
  );
});

test("only v2 summaries are valid; invalid refs receive one repair and never commit fabricated sources", async () => {
  const summary = wrapFullCompactionSummary(contextSummaryBody("当前摘要。"));
  assert.equal(isValidStoredCompactionSummary(summary, "sections_v1"), false);
  assert.equal(isValidStoredCompactionSummary(summary, "sections_v2"), true);
  assert.equal(isValidStoredCompactionSummary(summary, undefined), false);
  const history: Message[] = [
    { role: "user", content: "original task" },
    { role: "assistant", content: "read result" },
    { role: "assistant", content: "tail" },
  ];
  let calls = 0;
  let writes = 0;
  const result = await recordRuntimeCompactionCheckpoint({
    session: { id: "repair" },
    runtimeRun: {
      claimsSession: () => true,
      readModelHistoryEntries: async () =>
        history.map((message, i) => ({ eventId: `source-${i}`, message })),
      findLastCompactionCheckpoint: async () => undefined,
      resolveCompactionEvidenceReferences: async () => undefined,
      recordCheckpoint: async () => {
        writes++;
      },
    },
    compactor: new FullCompactor({
      maxAttempts: 1,
      provider: {
        async generate() {
          calls++;
          return {
            role: "assistant",
            content: handoffSummary("- [event:invented] observed: all tests passed."),
          };
        },
      },
    }),
    request,
  });
  assert.equal(result, undefined);
  assert.equal(calls, 2, "bounded format/evidence repair only once");
  assert.equal(writes, 0);
});

test("production checkpoint commit rejects forged provenance and fork derives real target identities/sequences with idempotent unavailable-source handling", async (t) => {
  const fixture = await createHandoffFixture("pico-handoff-fork-", "FORK_REPORT_TOKEN");
  const targetState: { session?: Session } = {};
  t.after(async () => {
    await targetState.session?.close();
    await fixture.session.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const source = fixture.session;
  const evidence = [fixture.report.eventId, fixture.failed.eventId]
    .map((id) => `- ${renderCompactionEvidenceReference(id)} 原始执行结果。`)
    .join("\n");
  const run = await RuntimeRun.start({
    capability: source.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await run.run(async () =>
    assert.ok(
      await recordRuntimeCompactionCheckpoint({
        session: source,
        runtimeRun: run,
        compactor: new FullCompactor({
          provider: {
            async generate() {
              return { role: "assistant", content: handoffSummary(evidence) };
            },
          },
        }),
        request,
      }),
    ),
  );
  const snapshot = await source.readDurableForkSnapshot();
  assert.ok(snapshot.modelCheckpoint);
  const { createSessionForkRuntimePort } =
    await import("@pico/pico-host/session-fork-runtime-port-adapter");
  const { bindToolResultArchiveReader } = await import("@pico/runtime/tool-result-archive");
  const {
    attachCompactionEvidenceSources,
    compactionSummarySha256,
    computeCheckpointSourceDigest,
  } = await import("@pico/runtime/runtime-compaction-checkpoint");
  const port = createSessionForkRuntimePort();
  const store = source.runtimeEventStore!;
  const bootstrap = {
    sourceSessionId: source.id,
    targetSessionId: "handoff-target",
    operationId: "handoff-copy",
    operationCreatedAt: "2026-10-09T00:00:00.000Z",
    workDir: fixture.workDir,
    runtimeAuthority: store,
    seedEntries: snapshot.runtimeSeedEntries,
    modelCheckpoint: snapshot.modelCheckpoint,
    publication: { async assertOwned() {} },
  };
  for (const format of [undefined, "sections_v1"]) {
    await assert.rejects(
      port.bootstrapFork({
        ...bootstrap,
        targetSessionId: `rejected-fork-${format ?? "unmarked"}`,
        modelCheckpoint: {
          ...snapshot.modelCheckpoint,
          summary: {
            ...snapshot.modelCheckpoint.summary,
            providerData: {
              ...snapshot.modelCheckpoint.summary.providerData,
              picoSummaryFormat: format,
            },
          },
        },
      }),
      /invalid handoff evidence/,
    );
  }
  await port.bootstrapFork(bootstrap);
  const imported = await store.readSessionEntries(bootstrap.targetSessionId);
  const checkpoint = imported.find(
    ({ event }) => event.kind === "context.checkpoint.recorded",
  )!.event;
  if (checkpoint.kind !== "context.checkpoint.recorded") assert.fail("expected target checkpoint");
  for (const format of [undefined, "sections_v1"]) {
    const obsoleteCopy = imported.map(({ event }) =>
      event.kind === "context.checkpoint.recorded"
        ? {
            ...event,
            data: {
              ...event.data,
              summary: {
                ...event.data.summary,
                providerData: { ...event.data.summary.providerData, picoSummaryFormat: format },
              },
            },
          }
        : event,
    );
    assert.throws(() => materializeRuntimeHistory(obsoleteCopy), /invalid sectioned summary/);
  }
  const metadata = checkpoint.data.summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
  assert.ok(isCompactionEvidenceMetadata(metadata));
  assert.equal(metadata.sessionId, bootstrap.targetSessionId);
  assert.equal(metadata.previousCheckpointId, undefined);
  assert.equal(metadata.references.length, 2);
  for (const reference of metadata.references) {
    const entry = imported.find(({ event }) => event.eventId === reference.eventId)!;
    assert.ok(entry && entry.event.sessionId === bootstrap.targetSessionId);
    assert.equal(
      reference.sequence,
      entry.sequence,
      "copy must use actual stored sequence, never index",
    );

    assert.ok(![fixture.report.eventId, fixture.failed.eventId].includes(reference.eventId));
  }
  const report = metadata.references.find(({ toolName }) => toolName === "read_report")!;
  assert.equal(
    await bindToolResultArchiveReader(store, bootstrap.targetSessionId).readRaw(report.archiveRef!),
    fixture.rawReport,
  );
  assert.ok(
    !checkpoint.data.summary.content.includes(
      renderCompactionEvidenceReference(fixture.report.eventId),
    ),
  );
  await port.bootstrapFork(bootstrap);
  assert.deepEqual(
    await store.readSessionEntries(bootstrap.targetSessionId),
    imported,
    "canonical rebinding remains idempotent",
  );

  const target = new Session(bootstrap.targetSessionId, fixture.workDir, {
    picoHome: fixture.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  targetState.session = target;
  await target.recover();
  const targetRun = await RuntimeRun.start({
    capability: target.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await targetRun.run(async () => {
    const entries = await targetRun.readModelHistoryEntries();
    const throughEventId = entries[0]!.eventId;
    const body = handoffSummary(
      `- ${renderCompactionEvidenceReference(fixture.report.eventId)} observed: verification succeeded.`,
    );
    const sourceMetadata =
      snapshot.modelCheckpoint!.summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
    assert.ok(isCompactionEvidenceMetadata(sourceMetadata));
    const forged = {
      version: 1 as const,
      sessionId: target.id,
      throughEventId,
      summarySha256: compactionSummarySha256(body),
      references: sourceMetadata.references.filter(
        ({ eventId }) => eventId === fixture.report.eventId,
      ),
    };
    const summary: Message = {
      role: "assistant",
      content: attachCompactionEvidenceSources(wrapFullCompactionSummary(body), forged),
      providerData: { picoSummaryFormat: "sections_v2", [HANDOFF_EVIDENCE_METADATA_KEY]: forged },
    };
    const input = {
      checkpointId: "checkpoint:forged",
      coveredEventCount: 1,
      sourceDigest: computeCheckpointSourceDigest(entries.slice(0, 1)),
      throughEventId,
      summary,
    };
    await assert.rejects(targetRun.recordCheckpoint(input), /invalid handoff evidence/);
    for (const format of [undefined, "sections_v1", "unknown"])
      await assert.rejects(
        targetRun.recordCheckpoint({
          ...input,
          summary: { ...summary, providerData: { picoSummaryFormat: format } },
        }),
        /invalid sectioned summary/,
      );
    assert.equal(
      (await store.readSession(target!.id)).filter(
        (event) => event.kind === "context.checkpoint.recorded",
      ).length,
      1,
    );
    assert.equal(await targetRun.findLastCompactionCheckpoint(), undefined);
  });

  // The selected fork prefix deliberately excludes the original tool exchange.
  const selected = snapshot.runtimeSeedEntries.filter(
    (entry) =>
      entry.kind !== "model" ||
      (entry.event.kind === "message.committed" && !entry.event.data.message.toolCalls?.length),
  );
  const unavailableInput = {
    ...bootstrap,
    targetSessionId: "handoff-unavailable",
    operationId: "handoff-selected",
    seedEntries: selected,
    modelCheckpoint: {
      ...snapshot.modelCheckpoint,
      coveredMessageCount: selected.filter((entry) => entry.kind === "model").length - 1,
    },
  };
  await port.bootstrapFork(unavailableInput);
  const unavailableEvents = await store.readSession(unavailableInput.targetSessionId);
  const unavailable = unavailableEvents.find(
    (event) => event.kind === "context.checkpoint.recorded",
  )!;
  if (unavailable.kind !== "context.checkpoint.recorded")
    assert.fail("expected selected checkpoint");
  const unavailableMetadata =
    unavailable.data.summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
  assert.ok(isCompactionEvidenceMetadata(unavailableMetadata));
  assert.deepEqual(unavailableMetadata.references, []);
  assert.match(unavailable.data.summary.content, /来源未复制到当前会话/);
  assert.match(unavailable.data.summary.content, /## Evidence\n\(none\)/);
  assert.equal(unavailable.data.summary.content.includes("pico://archive/"), false);
  assert.equal(
    unavailable.data.summary.content.includes(
      renderCompactionEvidenceReference(fixture.report.eventId),
    ),
    false,
  );
  await port.bootstrapFork(unavailableInput);
  assert.deepEqual(await store.readSession(unavailableInput.targetSessionId), unavailableEvents);
});

test("explicit frozen Host Goal anchor permits only an accepted mid-turn safe fold without inventing user history", async () => {
  const anchor: Message = {
    role: "assistant",
    content: "完成报告核验。",
    providerData: { picoKind: "host_goal_anchor" },
  };
  const history: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "goal-read", name: "read_report", arguments: "{}" }],
    },
    { role: "user", toolCallId: "goal-read", content: "report" },
    { role: "assistant", content: "completed safe batch" },
    { role: "assistant", content: "retained tail" },
  ];
  let calls = 0;
  const compactor = new FullCompactor({
    provider: {
      async generate(messages) {
        calls++;
        assert.match(messages[1]!.content, /Host-provided frozen Goal condition/);
        return { role: "assistant", content: handoffSummary("(none)") };
      },
    },
  });
  const before = structuredClone(history);
  const common = {
    trigger: "manual" as const,
    inputBudgetTokens: 4000,
    targetRetainedTokens: 1,
    preservedAnchor: anchor,
  };
  assert.equal(
    await compactor.preview({ id: "host-anchor" }, history, {
      ...common,
      phase: "pre_turn",
      acceptedHistoryPrefixCount: 3,
    }),
    undefined,
  );
  assert.equal(
    await compactor.preview({ id: "host-anchor" }, history, { ...common, phase: "mid_turn" }),
    undefined,
  );
  const preview = await compactor.preview({ id: "host-anchor" }, history, {
    ...common,
    phase: "mid_turn",
    acceptedHistoryPrefixCount: 3,
  });
  assert.ok(preview);
  assert.equal(preview.compactedCount, 3);
  assert.match(preview.wrappedSummary, /当前 Host Goal 任务（冻结条件）：/);
  assert.equal(preview.wrappedSummary.includes("当前用户任务（原文）："), false);
  assert.equal(calls, 1);
  assert.deepEqual(history, before);
});
