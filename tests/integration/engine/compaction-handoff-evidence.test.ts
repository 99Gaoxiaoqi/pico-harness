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

test("v1 keeps its validation contract; v2 invalid refs receive one repair and never commit fabricated sources", async () => {
  const legacy = contextSummaryBody("旧摘要。");
  assert.equal(
    isValidStoredCompactionSummary(wrapFullCompactionSummary(legacy), "sections_v1"),
    true,
  );
  assert.equal(
    isValidStoredCompactionSummary(wrapFullCompactionSummary(legacy), "sections_v2"),
    false,
  );
  assert.equal(isValidStoredCompactionSummary(wrapFullCompactionSummary(legacy), undefined), false);
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
