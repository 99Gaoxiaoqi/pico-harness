import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryExtractionSnapshot } from "@pico/core/atomic-memory-runtime-contracts";
import type { CanonicalMemoryItem } from "@pico/runtime/atomic-memory/extraction-proposal";
import { AtomicMemoryExtractionEngine } from "@pico/runtime/atomic-memory/extraction-engine";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { resolveRequestedReferenceNote } from "../../../packages/pico-host/src/atomic-memory-reference-note.js";

const safe = "The user prefers concise Chinese answers.";
const personal = [
  "Contact email is synthetic-person@example.invalid.",
  "联系手机号是13812345678。",
];
const secret = "api_key=sk-SYNTHETICINVALIDSYNTHETICINVALID";

function item(content: string, scope: "global" | "workspace" = "workspace"): CanonicalMemoryItem {
  return {
    content,
    kind: "preference",
    statementType: "fact",
    temporalType: "undated",
    eventStartedAt: null,
    eventEndedAt: null,
    scope,
    keys: [{ key: "answer preference", type: "concept" }],
  };
}

async function extract(
  t: TestContext,
  options: {
    trigger: "extract" | "remember";
    scope?: "global" | "workspace";
    proposal: string;
    userText?: string;
    canonical?: string;
    canonicalKey?: string;
    field?: "content" | "key" | "citation";
    mixed?: boolean;
  },
) {
  let nextId = 0;
  const store = new SqliteMemoryItemStore(":memory:", {
    now: () => 1_700_001_000_000,
    idFactory: () => `item-${++nextId}`,
  });
  t.after(() => store.close());
  const field = options.field ?? "content";
  const proposal = {
    ...item(field === "content" ? options.proposal : safe, options.scope),
    ...(field === "key" ? { keys: [{ key: options.proposal, type: "exact" as const }] } : {}),
    evidence: [{ sourceRef: "e1", quote: field === "citation" ? options.proposal : safe }],
  };
  const canonical = {
    ...item(options.canonical ?? proposal.content, options.scope),
    keys: options.canonicalKey
      ? [{ key: options.canonicalKey, type: "exact" as const }]
      : proposal.keys,
  };
  const sourceText = options.userText ?? (field === "citation" ? options.proposal : safe);
  const snapshot: MemoryExtractionSnapshot = {
    trigger: options.trigger,
    deletionRevision: 0,
    sessionId: "synthetic-session",
    workspaceKey: "synthetic-workspace",
    runId: "run",
    turnId: "turn",
    boundaryOrdinal: 2,
    boundaryEventId: "boundary",
    events: [
      {
        ordinal: 1,
        eventId: "user",
        runId: "run",
        turnId: "turn",
        role: "user",
        observedAt: 1_700_000_000_000,
        text: `${sourceText}\n${safe}`,
      },
      {
        ordinal: 2,
        eventId: "boundary",
        runId: "run",
        turnId: "turn",
        role: "other",
        observedAt: 1_700_000_000_001,
        text: "",
      },
    ],
  };
  let calls = 0;
  const safeProposal = { ...item(safe), evidence: [{ sourceRef: "e1", quote: safe }] };
  const engine = new AtomicMemoryExtractionEngine({
    store,
    gate: async () => ({ allowed: true }),
    model: {
      async call(request) {
        calls++;
        if (request.stage === "canonicalize") {
          const records = JSON.parse(
            request.prompt
              .split("<user_evidence_candidates>\n")[1]!
              .split("\n</user_evidence_candidates>")[0]!,
          ) as { candidateId: string; evidence: { quote: string }[] }[];
          return JSON.stringify({
            results: records.map((record) => ({
              candidateId: record.candidateId,
              status: "accepted",
              item:
                record.evidence[0]?.quote === safe &&
                options.mixed &&
                options.canonical === undefined
                  ? item(safe)
                  : canonical,
            })),
          });
        }
        return JSON.stringify({
          status: "complete",
          coverageStatus: "processed",
          requestedStatus: options.trigger === "remember" ? "resolved" : "not_applicable",
          requestedItems: options.trigger === "remember" ? [proposal] : [],
          incidentalItems:
            options.trigger === "extract"
              ? [proposal, ...(options.mixed ? [safeProposal] : [])]
              : [],
        });
      },
    },
  });
  const result = await engine.execute(snapshot);
  return { result, calls, records: await store.listItems({ workspaceKey: "synthetic-workspace" }) };
}

test("fact memory rejects existing PII categories at proposal and canonicalization for automatic and explicit scopes", async (t) => {
  for (const value of personal) {
    for (const trigger of ["extract", "remember"] as const) {
      for (const scope of ["global", "workspace"] as const) {
        for (const stage of ["proposal", "canonicalize"] as const) {
          await t.test(`${trigger} ${scope} ${stage} ${personal.indexOf(value)}`, async (t) => {
            const outcome = await extract(t, {
              trigger,
              scope,
              proposal: stage === "proposal" ? value : safe,
              ...(stage === "canonicalize" ? { canonical: value } : {}),
            });
            assert.equal(outcome.records.length, 0);
            assert.equal(outcome.result.requestedItems.length, 0);
            assert.notEqual(outcome.result.status, "remembered");
            if (trigger === "remember") {
              assert.equal(outcome.result.status, "not_applicable");
              assert.ok(
                "noOpReason" in outcome.result &&
                  outcome.result.noOpReason === "sensitive_information",
              );
            }
          });
        }
      }
    }
  }
});

test("PII in keys or cited evidence cannot be laundered into a safe-looking fact; mixed automatic candidates remain usable", async (t) => {
  for (const value of [...personal, secret]) {
    for (const field of ["content", "key", "citation"] as const) {
      const rejected = await extract(t, { trigger: "extract", proposal: value, field });
      assert.equal(rejected.records.length, 0);
      const mixed = await extract(t, { trigger: "extract", proposal: value, field, mixed: true });
      assert.deepEqual(
        mixed.records.map(({ item }) => item.content),
        [safe],
      );
    }
    const canonicalKey = await extract(t, {
      trigger: "extract",
      proposal: safe,
      canonicalKey: value,
    });
    assert.equal(canonicalKey.records.length, 0);
  }
});

test("memory safety follows persistence removal of zero-width characters without adding PII categories", async (t) => {
  for (const separator of ["\u200b", "\u200c", "\u200d", "\ufeff"]) {
    const value = `Contact: synthetic-person@${separator}example.invalid`;
    assert.notEqual(
      sanitizeMemoryContent({ title: "", content: value, reason: "" }).disposition,
      "allow",
    );
    assert.equal((await extract(t, { trigger: "extract", proposal: value })).records.length, 0);
  }
  const allowed = await extract(t, { trigger: "remember", proposal: safe });
  assert.equal(allowed.result.status, "remembered");
  assert.deepEqual(
    allowed.records.map(({ item }) => item.content),
    [safe],
  );
});

test("an explicit PII request cannot be reported saved as a model-written safe summary", async (t) => {
  for (const value of [...personal, secret]) {
    const outcome = await extract(t, { trigger: "remember", userText: value, proposal: safe });
    assert.equal(outcome.calls, 0);
    assert.equal(outcome.records.length, 0);
    assert.equal(outcome.result.status, "not_applicable");
    assert.ok(
      "noOpReason" in outcome.result && outcome.result.noOpReason === "sensitive_information",
    );
    assert.deepEqual(outcome.result.requestedItems, []);
  }
});

test("manual and host-bound reference-note entrances reject the same new PII and secrets without rewriting old items", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-pii-entrances-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const picoHome = join(root, "pico-home");
  const service = new DesktopAtomicMemoryService({ picoHome, publish: () => {} });
  const old = (await service.create(workspace, safe)).item;
  // A legacy row deliberately bypasses new-entry admission. Reading/validating
  // new writes must not rewrite historical PII or bump that row's version.
  const legacyStore = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const legacy = await legacyStore.applyMutations({
    operationId: "synthetic-legacy-pii",
    mutations: [
      {
        type: "create",
        item: {
          content: personal[0]!,
          kind: "identity",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "global",
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "legacy contact", keyType: "concept", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  const legacyId = legacy.results[0]!.itemId;
  const legacyBefore = await legacyStore.readItem(legacyId);
  legacyStore.close();
  for (const value of [...personal, secret]) {
    await assert.rejects(service.create(workspace, value));
    await assert.rejects(
      service.update(workspace, {
        workspacePath: workspace,
        itemId: old.itemId,
        expectedVersion: old.version,
        idempotencyKey: `rejected-${value.length}`,
        content: value,
      }),
    );
    const reference = resolveRequestedReferenceNote(
      {
        trigger: "remember",
        deletionRevision: 0,
        sessionId: "reference",
        workspaceKey: "workspace",
        runId: "new",
        turnId: "new",
        boundaryOrdinal: 2,
        boundaryEventId: "authorization",
        events: [
          {
            ordinal: 1,
            eventId: "reply",
            runId: "old",
            turnId: "old",
            role: "assistant",
            observedAt: 1,
            text: value,
          },
          {
            ordinal: 2,
            eventId: "authorization",
            runId: "new",
            turnId: "new",
            role: "user",
            observedAt: 2,
            text: "记一下",
          },
        ],
      },
      { completedRunIds: new Set(["old"]) },
    );
    assert.deepEqual(reference, { status: "unresolved", reason: "sensitive_information" });
  }
  const remaining = (await service.list(workspace, { workspacePath: workspace })).items;
  assert.equal(remaining.length, 2);
  const oldAfter = remaining.find(({ itemId }) => itemId === old.itemId);
  assert.equal(oldAfter?.content, safe);
  assert.equal(oldAfter?.version, old.version);
  const reopened = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  try {
    assert.deepEqual(await reopened.readItem(legacyId), legacyBefore);
  } finally {
    reopened.close();
  }
});
