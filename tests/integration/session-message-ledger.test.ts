import assert from "node:assert/strict";
import test from "node:test";
import { assistantMessage, toolResultMessage, type Message } from "../../src/schema/message.js";
import { Session } from "../../src/engine/session.js";
import { SessionMessageLedger } from "../../src/engine/session-message-ledger.js";

test("SessionMessageLedger defers ordinary messages until every tool result is released", () => {
  let now = 10;
  const ledger = new SessionMessageLedger({ now: () => now });
  const assistant = assistantMessage("先调用工具", [
    { id: "call-a", name: "read", arguments: "{}" },
    { id: "call-b", name: "read", arguments: "{}" },
  ]);
  const deferred: Message = { role: "user", content: "用户补充" };

  assert.deepEqual(ledger.append(assistant).appended, [assistant]);
  assert.equal(ledger.append(deferred).deferred, true);
  assert.deepEqual(ledger.readHistory(), [assistant]);

  now = 20;
  const first = toolResultMessage("call-a", "A");
  assert.deepEqual(ledger.append(first).appended, [first]);
  assert.deepEqual(ledger.readHistory(), [assistant, first]);

  now = 30;
  const second = toolResultMessage("call-b", "B");
  assert.deepEqual(ledger.append(second).appended, [second, deferred]);
  assert.deepEqual(ledger.readHistory(), [assistant, first, second, deferred]);
  assert.equal(ledger.deferredCount, 0);
  assert.equal(ledger.pendingToolCallCount, 0);
});

test("SessionMessageLedger projection rebuilds pending state and tool metadata", () => {
  const ledger = new SessionMessageLedger({ now: () => 100 });
  const assistant = assistantMessage("调用", [{ id: "call", name: "read", arguments: "{}" }]);
  const result = toolResultMessage("call", "输出");

  ledger.appendProjected([assistant, result]);
  assert.equal(ledger.pendingToolCallCount, 0);
  assert.equal(ledger.hasPendingToolResults(), false);
  const meta = ledger.getToolResultMeta().get("call");
  assert.deepEqual(meta, { cachedAt: 100, accessCount: 0 });

  assert.deepEqual(ledger.getModelContext(), [assistant, result]);
  assert.equal(ledger.getToolResultMeta().get("call")?.accessCount, 1);

  ledger.replace([assistant]);
  assert.equal(ledger.pendingToolCallCount, 1);
  assert.equal(ledger.getToolResultMeta().has("call"), false);
  assert.equal(ledger.hasPendingToolResults(), true);
});

test("SessionMessageLedger replacement operations preserve their explicit history boundary", () => {
  const messages: Message[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ];
  const ledger = new SessionMessageLedger({ messages });

  ledger.truncateTo(1);
  assert.deepEqual(ledger.getModelContext(), messages.slice(1));
  ledger.retainPrefix(1);
  assert.deepEqual(ledger.getModelContext(), [messages[1]]);
  ledger.compact({ role: "assistant", content: "摘要" }, 1);
  assert.deepEqual(ledger.getModelContext(), [{ role: "assistant", content: "摘要" }]);
});

test("SessionMessageLedger suffix rewrites preserve live tool metadata", () => {
  let now = 100;
  const ledger = new SessionMessageLedger({ now: () => now });
  const assistant = assistantMessage("调用", [{ id: "call", name: "read", arguments: "{}" }]);
  const result = toolResultMessage("call", "输出");

  ledger.append(assistant);
  ledger.append(result);
  ledger.getModelContext();
  now = 200;
  ledger.truncateTo(1);

  assert.deepEqual(ledger.getToolResultMeta().get("call"), { cachedAt: 100, accessCount: 1 });
  ledger.compact({ role: "assistant", content: "摘要" }, 0);
  assert.deepEqual(ledger.getToolResultMeta().get("call"), { cachedAt: 100, accessCount: 1 });
});

test("SessionMessageLedger rewind boundary can clear stale pending tool state", () => {
  const ledger = new SessionMessageLedger();
  const assistant = assistantMessage("调用", [{ id: "call", name: "read", arguments: "{}" }]);
  ledger.append(assistant);
  ledger.retainPrefix(1, { resetOrderingState: true });

  const followUp: Message = { role: "user", content: "重新规划" };
  assert.equal(ledger.append(followUp).deferred, false);
  assert.deepEqual(ledger.getModelContext(), [assistant, followUp]);
});

test("Session delegates in-memory tool ordering and metadata to its message ledger", async () => {
  const session = new Session("message-ledger-session", process.cwd(), { persistence: false });
  try {
    const assistant = assistantMessage("调用", [{ id: "call", name: "read", arguments: "{}" }]);
    const deferred: Message = { role: "user", content: "稍后处理" };
    const result = toolResultMessage("call", "输出");

    await session.commitMessages(assistant, deferred);
    assert.deepEqual(session.getHistory(), [assistant]);
    await session.commitMessages(result);
    assert.deepEqual(session.getHistory(), [assistant, result, deferred]);
    assert.equal(session.getToolResultMeta().get("call")?.accessCount, 0);
    session.getModelContext();
    assert.equal(session.getToolResultMeta().get("call")?.accessCount, 1);
  } finally {
    await session.close();
  }
});

test("Session truncate keeps metadata for retained tool results", async () => {
  const session = new Session("message-ledger-truncate", process.cwd(), { persistence: false });
  try {
    const assistant = assistantMessage("调用", [{ id: "call", name: "read", arguments: "{}" }]);
    const result = toolResultMessage("call", "输出");
    await session.commitMessages(assistant, result);
    session.getModelContext();
    const before = session.getToolResultMeta().get("call");
    assert.ok(before);

    await session.truncateTo(1);
    assert.deepEqual(session.getToolResultMeta().get("call"), before);
  } finally {
    await session.close();
  }
});
