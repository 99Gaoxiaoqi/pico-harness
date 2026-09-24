import assert from "node:assert/strict";
import test from "node:test";
import { ClientCapabilityCommandBroker } from "@pico/pico-host/client-capability-command-broker";
import { createComputerUseTools } from "@pico/pico-host/computer-use-tools";
import { DESKTOP_RUNTIME_METHODS, parseStrictRuntimeParams, RUNTIME_METHODS } from "@pico/protocol";

test("Desktop computer command requires a live client, stays within its session, and resolves exactly once", async () => {
  const broker = new ClientCapabilityCommandBroker({ commandTimeoutMs: 500 });
  const task = broker.bind("task-a");
  await assert.rejects(task.execute("computer.observe"), /未连接/);
  assert.equal((await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 })).command, null);
  const pending = task.execute("computer.observe");
  const command = (await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 })).command;
  assert.equal(command?.sessionId, "task-a");
  assert.equal(command?.action, "computer.observe");
  assert.throws(
    () =>
      broker.resolveCommand({
        clientId: "desktop-b",
        commandId: command?.commandId ?? "",
        ok: true,
      }),
    /不属于当前客户端/,
  );
  broker.resolveCommand({
    clientId: "desktop-a",
    commandId: command?.commandId ?? "",
    ok: true,
    result: { observationId: "test" },
  });
  assert.deepEqual(await pending, { observationId: "test" });
  assert.throws(
    () =>
      broker.resolveCommand({
        clientId: "desktop-a",
        commandId: command?.commandId ?? "",
        ok: true,
      }),
    /不存在/,
  );
});

test("revocation cancels queued computer command and stale desktop cannot settle it", async () => {
  const broker = new ClientCapabilityCommandBroker({ commandTimeoutMs: 500 });
  await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 });
  const pending = broker
    .bind("task-a")
    .execute("computer.click", { observationId: "a", elementIndex: 0 });
  const rejected = assert.rejects(pending, /能力已撤销/);
  const command = (await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 })).command;
  assert.ok(command);
  broker.invalidateSession("task-a");
  await rejected;
  assert.throws(
    () => broker.resolveCommand({ clientId: "desktop-a", commandId: command.commandId, ok: true }),
    /不存在/,
  );
});

test("claimed native result can settle after polling lease expires, but revocation still wins", async () => {
  let now = 1_000;
  const broker = new ClientCapabilityCommandBroker({
    now: () => now,
    clientTtlMs: 5,
    commandTimeoutMs: 500,
  });
  await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 });
  const first = broker.bind("task-a").execute("computer.observe");
  const command = (await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 })).command;
  assert.ok(command);
  now += 10;
  broker.resolveCommand({ clientId: "desktop-a", commandId: command.commandId, ok: true });
  assert.deepEqual(await first, {});

  await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 });
  const second = broker.bind("task-a").execute("computer.click");
  const rejected = assert.rejects(second, /能力已撤销/);
  const stale = (await broker.nextCommand({ clientId: "desktop-a", waitMs: 0 })).command;
  assert.ok(stale);
  broker.invalidateSession("task-a");
  now += 10;
  assert.throws(
    () => broker.resolveCommand({ clientId: "desktop-a", commandId: stale.commandId, ok: true }),
    /不存在/,
  );
  await rejected;
});

test("Computer tools expose fixed operations and Desktop client polling is not renderer-accessible", async () => {
  const calls: Array<{ action: string; input: unknown }> = [];
  const tools = createComputerUseTools({
    sessionId: "task-a",
    execute: async (action, input = {}) => {
      calls.push({ action, input });
      return { accepted: true };
    },
  });
  assert.deepEqual(
    tools.map((tool) => tool.name()),
    ["computer_observe", "computer_click", "computer_type"],
  );
  await tools[0]!.execute("{}");
  await tools[1]!.execute(
    JSON.stringify({ observationId: "12345678-1234-1234-1234-123456789abc", elementIndex: 2 }),
  );
  assert.deepEqual(
    calls.map((call) => call.action),
    ["computer.observe", "computer.click"],
  );
  await assert.rejects(
    tools[1]!.execute(JSON.stringify({ observationId: "bad", elementIndex: 2 })),
    /观察编号无效/,
  );
  assert.equal(RUNTIME_METHODS.includes("client.capability.next"), true);
  assert.equal(DESKTOP_RUNTIME_METHODS.includes("client.capability.next" as never), false);
  assert.deepEqual(
    parseStrictRuntimeParams("client.capability.next", { clientId: "desktop-a", waitMs: 0 }),
    { clientId: "desktop-a", waitMs: 0 },
  );
});
