import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserAgentBrokerError,
  BrowserAgentCommandBroker,
} from "../../src/daemon/browser-agent-command-broker.js";
import { createBrowserAgentTools } from "../../src/tools/browser-agent.js";
import { DESKTOP_RUNTIME_METHODS, parseStrictRuntimeParams } from "@pico/protocol";

test("Browser Agent 仅在当前 Session 持有可见租约时执行固定命令", async () => {
  const broker = new BrowserAgentCommandBroker({ commandTimeoutMs: 500 });
  const sessionA = broker.bind("session-a");
  await assert.rejects(
    sessionA.execute("get_state"),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_NOT_VISIBLE",
  );

  const leaseA = broker.acquireLease({
    sessionId: "session-a",
    visible: true,
    generation: 1,
  });
  const leaseB = broker.acquireLease({
    sessionId: "session-b",
    visible: true,
    generation: 1,
  });
  const pending = sessionA.execute("navigate", { url: "https://example.com/" });

  assert.equal(
    (await broker.nextCommand({ sessionId: "session-b", leaseId: leaseB.leaseId, waitMs: 0 }))
      .command,
    null,
  );
  const command = (
    await broker.nextCommand({ sessionId: "session-a", leaseId: leaseA.leaseId, waitMs: 0 })
  ).command;
  assert.equal(command?.action, "navigate");
  assert.equal(command?.input["url"], "https://example.com/");

  assert.throws(
    () =>
      broker.resolveCommand({
        sessionId: "session-b",
        leaseId: leaseB.leaseId,
        commandId: command?.commandId ?? "missing",
        ok: true,
        result: {},
      }),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_LEASE_STALE",
  );
  broker.resolveCommand({
    sessionId: "session-a",
    leaseId: leaseA.leaseId,
    commandId: command?.commandId ?? "missing",
    ok: true,
    result: { url: "https://example.com/" },
  });
  assert.deepEqual(await pending, { url: "https://example.com/" });
});

test("面板隐藏、租约过期和命令超时均 fail closed", async () => {
  let now = 1_000;
  const broker = new BrowserAgentCommandBroker({
    now: () => now,
    leaseTtlMs: 50,
    commandTimeoutMs: 25,
  });
  const authority = broker.bind("session-a");
  const lease = broker.acquireLease({
    sessionId: "session-a",
    visible: true,
    generation: 1,
  });
  const interrupted = authority.execute("reload");
  broker.acquireLease({
    sessionId: "session-a",
    visible: false,
    generation: 2,
    leaseId: lease.leaseId,
  });
  await assert.rejects(interrupted, /浏览器面板已隐藏/);

  const renewed = broker.acquireLease({
    sessionId: "session-a",
    visible: true,
    generation: 3,
  });
  now += 51;
  await assert.rejects(
    broker.nextCommand({ sessionId: "session-a", leaseId: renewed.leaseId, waitMs: 0 }),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_NOT_VISIBLE",
  );

  broker.acquireLease({ sessionId: "session-a", visible: true, generation: 4 });
  await assert.rejects(
    authority.execute("back"),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_COMMAND_TIMEOUT",
  );
});

test("Browser Agent generation floor prevents a closed viewport from reacquiring a lease", () => {
  const broker = new BrowserAgentCommandBroker();
  broker.acquireLease({ sessionId: "session-a", visible: true, generation: 5 });
  broker.invalidateSession("session-a", "Session archived");
  assert.throws(
    () => broker.acquireLease({ sessionId: "session-a", visible: true, generation: 5 }),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_LEASE_STALE",
  );
  assert.equal(
    broker.acquireLease({ sessionId: "session-a", visible: true, generation: 6 }).visible,
    true,
  );

  broker.acquireLease({ sessionId: "session-b", visible: false, generation: 9 });
  assert.throws(
    () => broker.acquireLease({ sessionId: "session-b", visible: true, generation: 9 }),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_LEASE_STALE",
  );
});

test("Browser Agent 工具只暴露固定操作且校验输入边界", async () => {
  const calls: Array<{ action: string; input: unknown }> = [];
  const tools = createBrowserAgentTools({
    sessionId: "session-a",
    execute: async (action, input = {}) => {
      calls.push({ action, input });
      return { accepted: true };
    },
  });
  assert.deepEqual(
    tools.map((tool) => tool.name()),
    [
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_get_state",
      "browser_click",
      "browser_type",
    ],
  );
  const navigate = tools.find((tool) => tool.name() === "browser_navigate");
  const type = tools.find((tool) => tool.name() === "browser_type");
  assert.ok(navigate);
  assert.ok(type);
  await navigate.execute(JSON.stringify({ url: "https://example.com" }));
  await type.execute(JSON.stringify({ selector: "#search", text: "pico", clear: false }));
  assert.deepEqual(calls, [
    { action: "navigate", input: { url: "https://example.com" } },
    { action: "type", input: { selector: "#search", text: "pico", clear: false } },
  ]);
  await assert.rejects(navigate.execute(JSON.stringify({ url: "" })), /url 必须是非空字符串/);
});

test("Browser Agent Desktop 协议拒绝多余字段和无效 resolve payload", () => {
  for (const method of [
    "browser.agent.lease",
    "browser.agent.next",
    "browser.agent.resolve",
  ] as const) {
    assert.equal(DESKTOP_RUNTIME_METHODS.includes(method), true);
  }
  assert.deepEqual(
    parseStrictRuntimeParams("browser.agent.lease", {
      sessionId: "session-a",
      visible: true,
      generation: 1,
    }),
    { sessionId: "session-a", visible: true, generation: 1 },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("browser.agent.lease", {
        sessionId: "session-a",
        visible: true,
        generation: 1,
        script: "alert(1)",
      }),
    /不允许字段 script/,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("browser.agent.resolve", {
        sessionId: "session-a",
        leaseId: "lease-a",
        commandId: "command-a",
        ok: true,
        result: () => undefined,
      }),
    /必须是 JSON 对象/,
  );
});
