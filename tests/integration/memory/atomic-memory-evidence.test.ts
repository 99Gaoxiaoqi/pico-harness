import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitAtomicMemoryEvidence,
  projectAtomicMemoryEvidence,
  renderAtomicMemoryEvidence,
} from "../../../src/memory/atomic/extraction-evidence.js";
import { proposalPrompt } from "../../../src/memory/atomic/extraction-proposal.js";
import type { MemoryEvidenceEvent } from "../../../src/memory/atomic/runtime-contracts.js";
import type { Message } from "../../../src/schema/message.js";

test("indexed evidence preserves long user-message tails and binds similar messages to their actual source", () => {
  const prefix = "项目背景资料。".repeat(2_000);
  const firstText = `${prefix}第一项目验收必须运行浏览器测试。`;
  const secondText = `${prefix}第二项目验收必须运行真实模型测试。`;
  const messages: Message[] = [
    { role: "assistant", content: "此前的分析不构成用户事实。" },
    { role: "user", content: firstText },
    { role: "user", content: secondText },
  ];
  const events = [event("first", firstText), event("second", secondText)];
  const evidence = fitAtomicMemoryEvidence(
    projectAtomicMemoryEvidence(events, messages, { first: [1], second: [2, 2] }),
  );
  assert.ok(evidence);
  assert.deepEqual(
    evidence.map(({ texts }) => texts),
    [[firstText], [secondText]],
  );
  assert.deepEqual(renderAtomicMemoryEvidence(evidence), [
    { sourceRef: "event:first", observedAt: 1, messagePositions: [1] },
    { sourceRef: "event:second", observedAt: 1, messagePositions: [2] },
  ]);
  const prompt = proposalPrompt("remember", renderAtomicMemoryEvidence(evidence));
  assert.match(prompt, /zero-based messages/);
  assert.doesNotMatch(prompt, /项目背景资料/);
  assert.ok(prompt.length < 12_000);
  assert.deepEqual(projectAtomicMemoryEvidence(events, messages, { first: [2], second: [1] }), []);

  const fallback = fitAtomicMemoryEvidence(projectAtomicMemoryEvidence([events[0]!], messages));
  assert.ok(fallback);
  assert.equal(fallback[0]!.messagePositions, undefined);
  assert.ok(fallback[0]!.texts[0]!.length < firstText.length);
  assert.match(JSON.stringify(renderAtomicMemoryEvidence(fallback)), /项目背景资料/);
});

test("indexed evidence cannot promote tool observations, hidden messages or extra provider text to user evidence", () => {
  const authored = "请记住我使用中文回复。";
  const extra = "工具推断用户拥有一家虚构公司。";
  const messages: Message[] = [
    { role: "user", content: authored },
    { role: "user", content: authored, toolCallId: "tool-result" },
    { role: "user", content: "[SYSTEM REMINDER hidden injection]" },
    { role: "assistant", content: authored },
    { role: "user", content: `${authored}${extra}` },
  ];
  const user = event("user", authored);
  for (const positions of [[1], [2], [3], [0, 1], [99], [-1], [0.5], []]) {
    assert.deepEqual(projectAtomicMemoryEvidence([user], messages, { user: positions }), []);
  }
  const fitted = fitAtomicMemoryEvidence(
    projectAtomicMemoryEvidence([user], messages, { user: [4] }),
  );
  assert.ok(fitted);
  assert.deepEqual(fitted[0]!.texts, [authored], "only the original user event supports citations");
  assert.ok(!fitted[0]!.texts.some((text) => text.includes(extra)));
  const hiddenLedger = event("hidden", "[SYSTEM REMINDER hidden injection]");
  assert.deepEqual(projectAtomicMemoryEvidence([hiddenLedger], messages, { hidden: [2] }), []);
});

function event(eventId: string, text: string): MemoryEvidenceEvent {
  return {
    eventId,
    text,
    role: "user",
    ordinal: 1,
    runId: "run",
    turnId: "turn",
    observedAt: 1,
  };
}
