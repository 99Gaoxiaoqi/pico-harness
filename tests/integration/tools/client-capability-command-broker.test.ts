import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClientCapabilityCommandBroker } from "@pico/pico-host/client-capability-command-broker";
import { createComputerUseTools } from "@pico/pico-host/computer-use-tools";
import {
  loadDesktopClientToken,
  revokeDesktopClientToken,
  rotateDesktopClientToken,
} from "@pico/pico-host/desktop-client-token";
import { DESKTOP_RUNTIME_METHODS, parseStrictRuntimeParams, RUNTIME_METHODS } from "@pico/protocol";

const clientToken = "a".repeat(64);
const authenticated = { loadClientToken: async () => clientToken };

test("Desktop computer command requires a live client, stays within its session, and resolves exactly once", async () => {
  const broker = new ClientCapabilityCommandBroker({ ...authenticated, commandTimeoutMs: 500 });
  const task = broker.bind("task-a");
  await assert.rejects(task.execute("computer.observe"), /未连接/);
  await assert.rejects(
    broker.nextCommand({ clientId: "desktop-b", clientToken: "invalid", waitMs: 0 }),
    /凭据无效/,
  );
  assert.equal(
    (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 })).command,
    null,
  );
  const pending = task.execute("computer.observe");
  const command = (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 }))
    .command;
  assert.equal(command?.sessionId, "task-a");
  assert.equal(command?.action, "computer.observe");
  await assert.rejects(
    broker.resolveCommand({
      clientId: "desktop-a",
      clientToken: "invalid",
      commandId: command?.commandId ?? "",
      ok: true,
    }),
    /凭据无效/,
  );
  await assert.rejects(
    () =>
      broker.resolveCommand({
        clientId: "desktop-b",
        clientToken,
        commandId: command?.commandId ?? "",
        ok: true,
      }),
    /不属于当前客户端/,
  );
  await broker.resolveCommand({
    clientId: "desktop-a",
    clientToken,
    commandId: command?.commandId ?? "",
    ok: true,
    result: { observationId: "test" },
  });
  assert.deepEqual(await pending, { observationId: "test" });
  await assert.rejects(
    () =>
      broker.resolveCommand({
        clientId: "desktop-a",
        clientToken,
        commandId: command?.commandId ?? "",
        ok: true,
      }),
    /不存在/,
  );
});

test("Desktop private token rotates and old RPC clients cannot reclaim the channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-token-"));
  try {
    const first = await rotateDesktopClientToken(root);
    assert.equal(await loadDesktopClientToken(root), first);
    const broker = new ClientCapabilityCommandBroker({
      loadClientToken: () => loadDesktopClientToken(root),
    });
    await broker.nextCommand({ clientId: "desktop-first", clientToken: first, waitMs: 0 });
    const second = await rotateDesktopClientToken(root);
    assert.notEqual(second, first);
    await assert.rejects(
      broker.nextCommand({ clientId: "desktop-first", clientToken: first, waitMs: 0 }),
      /凭据无效/,
    );
    await broker.nextCommand({ clientId: "desktop-second", clientToken: second, waitMs: 0 });
    revokeDesktopClientToken(root, second);
    await assert.rejects(loadDesktopClientToken(root), /ENOENT/);
    await assert.rejects(
      broker.nextCommand({ clientId: "desktop-second", clientToken: second, waitMs: 0 }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation cancels queued computer command and stale desktop cannot settle it", async () => {
  const broker = new ClientCapabilityCommandBroker({ ...authenticated, commandTimeoutMs: 500 });
  await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 });
  const pending = broker
    .bind("task-a")
    .execute("computer.click", { observationId: "a", elementIndex: 0 });
  const rejected = assert.rejects(pending, /能力已撤销/);
  const command = (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 }))
    .command;
  assert.ok(command);
  broker.invalidateSession("task-a");
  await rejected;
  await assert.rejects(
    () =>
      broker.resolveCommand({
        clientId: "desktop-a",
        clientToken,
        commandId: command.commandId,
        ok: true,
      }),
    /不存在/,
  );
});

test("claimed native result can settle after polling lease expires, but revocation still wins", async () => {
  let now = 1_000;
  const broker = new ClientCapabilityCommandBroker({
    ...authenticated,
    now: () => now,
    clientTtlMs: 5,
    commandTimeoutMs: 500,
  });
  await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 });
  const first = broker.bind("task-a").execute("computer.observe");
  const command = (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 }))
    .command;
  assert.ok(command);
  now += 10;
  await broker.resolveCommand({
    clientId: "desktop-a",
    clientToken,
    commandId: command.commandId,
    ok: true,
  });
  assert.deepEqual(await first, {});

  await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 });
  const second = broker.bind("task-a").execute("computer.click");
  const rejected = assert.rejects(second, /能力已撤销/);
  const stale = (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 }))
    .command;
  assert.ok(stale);
  broker.invalidateSession("task-a");
  now += 10;
  await assert.rejects(
    () =>
      broker.resolveCommand({
        clientId: "desktop-a",
        clientToken,
        commandId: stale.commandId,
        ok: true,
      }),
    /不存在/,
  );
  await rejected;
});

test("Desktop MCP phase authorization is bound to the claimed command, exact tool and live grant", async () => {
  const broker = new ClientCapabilityCommandBroker({ ...authenticated, commandTimeoutMs: 500 });
  await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 });
  let allowed = true;
  const pending = broker
    .bind("task-a")
    .execute(
      "desktop_mcp.call",
      { authorityEpoch: "epoch-1", server: "docs", tool: "read", args: {} },
      () => allowed,
    );
  const rejected = assert.rejects(pending, /能力已撤销/);
  const command = (await broker.nextCommand({ clientId: "desktop-a", clientToken, waitMs: 0 }))
    .command;
  assert.ok(command);
  const phase = {
    clientId: "desktop-a",
    clientToken,
    commandId: command.commandId,
    sessionId: "task-a",
    authorityEpoch: "epoch-1",
    server: "docs",
    tool: "read",
    phase: "server-connect" as const,
  };
  assert.deepEqual(await broker.authorizeCommand(phase), { allowed: true });
  await assert.rejects(broker.authorizeCommand({ ...phase, tool: "write" }), /票据无效/);
  await assert.rejects(broker.authorizeCommand({ ...phase, clientId: "desktop-b" }), /票据无效/);
  allowed = false;
  await assert.rejects(broker.authorizeCommand(phase), /当前任务授权已撤销/);
  broker.invalidateSession("task-a");
  await assert.rejects(broker.authorizeCommand(phase), /票据无效/);
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
    parseStrictRuntimeParams("client.capability.next", {
      clientId: "desktop-a",
      clientToken,
      waitMs: 0,
    }),
    { clientId: "desktop-a", clientToken, waitMs: 0 },
  );
});
