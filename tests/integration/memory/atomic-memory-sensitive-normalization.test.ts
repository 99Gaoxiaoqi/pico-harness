import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message } from "@pico/core";
import type {
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "@pico/core/atomic-memory-runtime-contracts";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { AtomicMemoryExtractionEngine } from "@pico/runtime/atomic-memory/extraction-engine";
import type {
  CanonicalMemoryItem,
  MemoryProposalItem,
} from "@pico/runtime/atomic-memory/extraction-proposal";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const WORKSPACE = "/synthetic-workspace";
const SESSION = JSON.stringify([WORKSPACE, "sensitive-normalization"]);
const NORMAL = "长期项目偏好使用 TypeScript。";
// Deliberately invalid synthetic data; never sent to a network Provider.
const SYNTHETIC = "sk-" + "SYNTHETICINVALID".repeat(2);

test("atomic memory rejects secrets after persistence normalization without widening evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-memory-sensitive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let nextDatabase = 0;
  const run = (options: Scenario = {}) =>
    execute(join(directory, `${++nextDatabase}.sqlite`), options);

  const normal = await run();
  assert.equal(normal.result.status, "remembered");
  assert.equal(normal.records.length, 1);
  assert.equal(normal.records[0]!.item.content, NORMAL);
  assert.deepEqual(
    normal.records[0]!.sources.map(({ eventId }) => eventId),
    ["event-1"],
  );
  assert.deepEqual(normal.stages, ["proposal", "canonicalize"]);
  assert.ok(normal.recall.includes(NORMAL));

  for (const [label, separator] of [
    ["plain", ""],
    ["200b", "\u200b"],
    ["200c", "\u200c"],
    ["200d", "\u200d"],
    ["feff", "\ufeff"],
  ] as const) {
    const synthetic = SYNTHETIC.slice(0, 3) + separator + SYNTHETIC.slice(3);
    for (const trigger of ["extract", "remember"] as const) {
      await t.test(`${trigger} source ${label}`, async () => {
        const result = await run({ trigger, userText: `长期项目代号为 ${synthetic}` });
        assertRejected(result);
        assert.deepEqual(result.stages, trigger === "remember" ? [] : ["proposal"]);
        if (trigger === "remember") {
          assert.ok("noOpReason" in result.result);
          assert.equal(result.result.noOpReason, "sensitive_information");
        }
      });
      for (const field of ["content", "keys"] as const) {
        for (const stage of ["proposal", "canonicalize"] as const) {
          await t.test(`${trigger} ${stage} ${field} ${label}`, async () => {
            const fields: Partial<CanonicalMemoryItem> =
              field === "content"
                ? { content: `长期项目代号为 ${synthetic}` }
                : { keys: [{ key: synthetic, type: "exact" }] };
            const result = await run({
              trigger,
              ...(stage === "proposal" ? { proposalFields: fields } : { canonicalFields: fields }),
            });
            assertRejected(result);
            assert.deepEqual(
              result.stages,
              stage === "proposal" ? ["proposal"] : ["proposal", "canonicalize"],
            );
          });
        }
      }
    }
    await t.test(`citation ${label}`, async () => {
      const result = await run({
        trigger: "extract",
        userText: `长期项目代号为 ${synthetic}`,
        proposalFields: { content: NORMAL },
      });
      assertRejected(result);
      assert.deepEqual(result.stages, ["proposal"]);
    });
    await t.test(`long visible remember source ${label}`, async () => {
      const result = await run({
        userText: NORMAL + "长期项目背景。".repeat(500) + synthetic,
        quote: NORMAL,
        proposalFields: { content: NORMAL },
      });
      assertRejected(result);
      assert.deepEqual(result.stages, []);
    });
  }

  // A hidden ledger tail must not reject a safe, Provider-visible request.
  const cropped = await run({
    userText: NORMAL + SYNTHETIC,
    sourceMessages: [{ role: "user", content: NORMAL }],
    quote: NORMAL,
    proposalFields: { content: NORMAL },
  });
  assert.equal(cropped.result.status, "remembered");
  assert.equal(cropped.records.length, 1);

  for (const options of [
    { quote: "来源不存在这个引文。" },
    { sourceRef: "event:wrong-source" },
    { userText: "长期项目偏好使用 Type\u200bScript。", quote: NORMAL },
    { role: "assistant" as const },
    { sourceMessages: [{ role: "user", content: NORMAL, toolCallId: "observation" }] },
    { denied: true },
  ] satisfies readonly Scenario[]) {
    const result = await run({ trigger: "extract", ...options });
    assertRejected(result);
  }
});

interface Scenario {
  readonly trigger?: "extract" | "remember";
  readonly userText?: string;
  readonly role?: "user" | "assistant";
  readonly sourceMessages?: readonly Message[];
  readonly quote?: string;
  readonly sourceRef?: string;
  readonly proposalFields?: Partial<CanonicalMemoryItem>;
  readonly canonicalFields?: Partial<CanonicalMemoryItem>;
  readonly denied?: boolean;
}

async function execute(database: string, options: Scenario) {
  const userText = options.userText ?? NORMAL;
  const trigger = options.trigger ?? "remember";
  const role = options.role ?? "user";
  const user: MemoryEvidenceEvent = {
    eventId: "event-1",
    ordinal: 1,
    runId: "run",
    turnId: "turn",
    observedAt: 1_700_000_000_000,
    role,
    text: userText,
  };
  const snapshot: MemoryExtractionSnapshot = {
    deletionRevision: 0,
    trigger,
    sessionId: SESSION,
    workspaceKey: WORKSPACE,
    runId: "run",
    turnId: "turn",
    boundaryOrdinal: 2,
    boundaryEventId: "event-2",
    events: [user, { ...user, ordinal: 2, eventId: "event-2", role: "other", text: "" }],
    sourceMessages: options.sourceMessages ?? [{ role, content: userText }],
    sourceEventMessagePositions: { "event-1": [0] },
  };
  const fields: CanonicalMemoryItem = {
    content: userText,
    kind: "context",
    statementType: "fact",
    temporalType: "undated",
    eventStartedAt: null,
    eventEndedAt: null,
    scope: "workspace",
    keys: [{ key: "长期项目", type: "concept" }],
  };
  const candidate: MemoryProposalItem = {
    ...fields,
    ...options.proposalFields,
    evidence: [
      { sourceRef: options.sourceRef ?? "event:event-1", quote: options.quote ?? userText },
    ],
  };
  const canonical = { ...fields, ...options.proposalFields, ...options.canonicalFields };
  const stages: MemoryModelRequest["stage"][] = [];
  let store = new SqliteMemoryItemStore(database);
  const engine = new AtomicMemoryExtractionEngine({
    store,
    gate: async () =>
      options.denied ? { allowed: false, reason: "memory_disabled" } : { allowed: true },
    model: {
      async call(request) {
        stages.push(request.stage);
        return request.stage === "canonicalize"
          ? JSON.stringify({
              results: [{ candidateId: "candidate_0", status: "accepted", item: canonical }],
            })
          : JSON.stringify({
              status: "complete",
              coverageStatus: "processed",
              requestedStatus: trigger === "remember" ? "resolved" : "not_applicable",
              requestedItems: trigger === "remember" ? [candidate] : [],
              incidentalItems: trigger === "extract" ? [candidate] : [],
            });
      },
    },
  });
  const result = await engine.execute(snapshot);
  store.close();
  store = new SqliteMemoryItemStore(database);
  try {
    const records = await store.listItems({ workspaceKey: WORKSPACE });
    const recall = await new AtomicMemoryContextBuilder(store, WORKSPACE).build("长期项目");
    return { result, records, stages, recall: recall.block };
  } finally {
    store.close();
  }
}

function assertRejected(result: Awaited<ReturnType<typeof execute>>) {
  assert.equal(result.records.length, 0);
  assert.equal(result.result.requestedItems.length, 0);
  assert.equal(result.recall.includes(SYNTHETIC), false);
}
