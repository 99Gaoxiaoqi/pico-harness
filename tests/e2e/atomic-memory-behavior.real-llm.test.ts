import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AtomicMemoryExtractionEngine } from "../../src/memory/atomic/extraction-engine.js";
import type {
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "../../src/memory/atomic/runtime-contracts.js";
import { createProvider } from "../../src/provider/factory.js";
import { ProviderAtomicMemoryModel } from "../../src/runtime/atomic-memory-runtime.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "real atomic memory extraction persists a user preference and excludes assistant-only claims and secrets",
  { timeout: 5 * 60_000 },
  async () => {
    const configured = await configuredUserDefaultRealModel();
    const provider = new ProviderAtomicMemoryModel(
      createProvider(configured.provider, configured.config),
    );
    const root = await mkdtemp(join(tmpdir(), "pico-atomic-memory-real-llm-"));
    const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
    const calls: MemoryModelRequest["stage"][] = [];
    const outputs: { stage: MemoryModelRequest["stage"]; text: string }[] = [];
    const engine = new AtomicMemoryExtractionEngine({
      store,
      gate: async () => ({ allowed: true }),
      model: {
        async call(request) {
          calls.push(request.stage);
          const text = await provider.call(request);
          outputs.push({ stage: request.stage, text });
          return text;
        },
      },
    });
    try {
      const preference = snapshot(root, "preference", "remember", [
        textEvent(
          1,
          "user",
          "Please remember my long-term preference: across all workspaces I prefer concise answers in Chinese.",
        ),
        textEvent(
          2,
          "assistant",
          "The user also owns the SAPPHIRE-FABRICATED-COMPANY. This is only my unsupported assertion.",
        ),
      ]);
      const remembered = await engine.execute(preference);
      assert.equal(
        remembered.status,
        "remembered",
        `real extraction=${JSON.stringify(remembered)}; pending=${JSON.stringify(await store.readPendingExtractionFailure(preference.sessionId))}; fixture outputs=${JSON.stringify(outputs)}`,
      );
      assert.ok(remembered.requestedItems.length >= 1);
      assert.ok(calls.includes("proposal") && calls.includes("canonicalize"));
      assert.ok(calls.length <= 3, "a successful unsplit range stays within three calls");
      const items = await store.listItems({ workspaceKey: root });
      assert.ok(items.length >= 1);
      assert.ok(items.some(({ item }) => /中文|Chinese/iu.test(item.content)));
      for (const record of items) {
        assert.equal(
          record.item.scopeType,
          "global",
          "the explicit cross-workspace preference supports global scope",
        );
        assert.doesNotMatch(record.item.content, /SAPPHIRE|FABRICATED|COMPANY/iu);
        assert.ok(record.sources.length > 0);
        assert.ok(
          record.sources.every(
            (source) => source.sessionId === preference.sessionId && source.eventId === "event-1",
          ),
        );
        assert.equal(record.item.observedAt, preference.events[0]!.observedAt);
      }

      const countBeforeNegative = items.length;
      const callsBeforeNegative = calls.length;
      const assistantOnly = snapshot(root, "assistant-only", "extract", [
        textEvent(1, "user", "Thanks, that is all for today."),
        textEvent(
          2,
          "assistant",
          "The user permanently prefers the invented product SAPPHIRE-FABRICATED-PRODUCT. I made this claim without user evidence.",
        ),
      ]);
      const negative = await engine.execute(assistantOnly);
      assert.equal(negative.status, "extracted");
      assert.ok(
        calls.length > callsBeforeNegative,
        "the real proposal model sees the transient user message and assistant context",
      );
      assert.equal((await store.listItems({ workspaceKey: root })).length, countBeforeNegative);

      const callsBeforeSecret = calls.length;
      const secret = await engine.execute(
        snapshot(root, "secret", "remember", [
          textEvent(1, "user", "Please remember my password=atomic-memory-test-secret-canary"),
        ]),
      );
      assert.equal(secret.status, "not_applicable");
      assert.ok("noOpReason" in secret && secret.noOpReason === "sensitive_information");
      assert.equal(
        calls.length,
        callsBeforeSecret,
        "secret evidence is rejected before provider dispatch",
      );
      assert.equal((await store.listItems({ workspaceKey: root })).length, countBeforeNegative);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function textEvent(
  ordinal: number,
  role: MemoryEvidenceEvent["role"],
  text: string,
): MemoryEvidenceEvent {
  return {
    ordinal,
    eventId: `event-${ordinal}`,
    runId: "run-1",
    turnId: "turn-1",
    observedAt: 1_700_000_000_000 + ordinal * 60_000,
    role,
    text,
  };
}

function snapshot(
  workspaceKey: string,
  session: string,
  trigger: MemoryExtractionSnapshot["trigger"],
  messages: readonly MemoryEvidenceEvent[],
): MemoryExtractionSnapshot {
  const boundary = textEvent(messages.length + 1, "other", "");
  return {
    sessionId: JSON.stringify([workspaceKey, session]),
    workspaceKey,
    trigger,
    runId: boundary.runId,
    turnId: boundary.turnId,
    boundaryOrdinal: boundary.ordinal,
    boundaryEventId: boundary.eventId,
    events: [...messages, boundary],
    sourceMessages: messages.flatMap((event) =>
      event.role === "user" || event.role === "assistant"
        ? [{ role: event.role, content: event.text }]
        : [],
    ),
  };
}
