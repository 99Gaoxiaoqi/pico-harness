import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAgentCommandBroker } from "@pico/pico-host/browser-agent-command-broker";
import {
  executeBrowserElementAction,
  type BrowserDebuggerPort,
} from "../../../apps/desktop/src/main/browser-element-action.js";
import { BrowserAgentOperationFence } from "../../../apps/desktop/src/main/browser-logic.js";

function debuggerFixture(
  onCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): BrowserDebuggerPort {
  let attached = false;
  return {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    sendCommand: onCommand,
  };
}

function response(method: string): unknown {
  if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
  if (method === "DOM.querySelector") return { nodeId: 2 };
  if (method === "DOM.getBoxModel") {
    return { model: { border: [0, 0, 20, 0, 20, 20, 0, 20] } };
  }
  if (method === "DOM.describeNode") return { node: { nodeName: "INPUT" } };
  return {};
}

test("queued user navigation cancels a model click before the next CDP effect", async () => {
  const approved = "https://approved.example";
  let url = `${approved}/form`;
  const fence = new BrowserAgentOperationFence();
  const token = fence.begin(approved);
  const release = fence.enter(token, url);
  const entered = Promise.withResolvers<void>();
  const read = Promise.withResolvers<unknown>();
  const sent: string[] = [];
  const debuggerPort = debuggerFixture(async (method) => {
    sent.push(method);
    if (method === "DOM.getDocument") {
      entered.resolve();
      return read.promise;
    }
    return response(method);
  });
  const click = executeBrowserElementAction(debuggerPort, "button", { kind: "click" }, () =>
    fence.assert(token, url),
  ).finally(release);
  await entered.promise;

  // This is the production IPC order: revoke the token, drain the active command,
  // and only then let the user switch to another origin.
  const navigation = fence.runUserAction(() => {
    url = "https://other.example/form";
  });
  assert.equal(fence.origin, approved, "redirects remain fenced while CDP is in flight");
  assert.throws(() => fence.begin(approved), /正在执行或取消中/u);
  read.resolve(response("DOM.getDocument"));
  await assert.rejects(click, /代际已变化/u);
  await navigation;
  assert.deepEqual(sent, ["DOM.getDocument"]);
  assert.equal(fence.origin, undefined);
  assert.equal(url, "https://other.example/form");
});

test("same-origin redirect or changed current URL cancels model typing before insertText", async () => {
  for (const change of ["page-generation", "cross-origin-url"] as const) {
    const approved = "https://approved.example";
    let url = `${approved}/form`;
    const fence = new BrowserAgentOperationFence();
    const token = fence.begin(approved);
    const sent: string[] = [];
    const debuggerPort = debuggerFixture(async (method) => {
      sent.push(method);
      if (method === "DOM.focus") {
        if (change === "page-generation") fence.pageChanged();
        else url = "https://other.example/form";
      }
      return response(method);
    });
    await assert.rejects(
      executeBrowserElementAction(
        debuggerPort,
        "input",
        { kind: "type", text: "secret", clear: false },
        () => fence.assert(token, url),
      ),
      /代际已变化/u,
    );
    assert.deepEqual(sent, ["DOM.getDocument", "DOM.querySelector", "DOM.focus"]);
  }
});

test("user navigation holds the command fence until its async load finishes", async () => {
  const fence = new BrowserAgentOperationFence();
  fence.begin("https://approved.example");
  const started = Promise.withResolvers<void>();
  const finishLoad = Promise.withResolvers<void>();
  const navigating = fence.runUserAction(async () => {
    started.resolve();
    await finishLoad.promise;
  });
  await started.promise;
  assert.equal(fence.origin, undefined);
  assert.throws(() => fence.begin("https://other.example"), /正在执行或取消中/u);
  finishLoad.resolve();
  await navigating;
  assert.equal(fence.begin("https://other.example").origin, "https://other.example");
});

test("broker origin reaches the production action fence and concurrent model commands cannot overlap", async () => {
  const broker = new BrowserAgentCommandBroker();
  const lease = broker.acquireLease({ sessionId: "session-a", visible: true, generation: 1 });
  const pending = broker
    .bind("session-a")
    .execute(
      "type",
      { selector: "input", text: "hello", clear: false },
      { expectedOrigin: "https://approved.example" },
    );
  const command = (
    await broker.nextCommand({ sessionId: "session-a", leaseId: lease.leaseId, waitMs: 0 })
  ).command;
  assert.equal(command?.expectedOrigin, "https://approved.example");
  const fence = new BrowserAgentOperationFence();
  const token = fence.begin(command!.expectedOrigin!);
  const release = fence.enter(token, "https://approved.example/form");
  assert.throws(() => fence.begin("https://approved.example"), /正在执行或取消中/u);
  release();
  const sent: string[] = [];
  const debuggerPort = debuggerFixture(async (method) => {
    sent.push(method);
    return response(method);
  });
  assert.equal(
    await executeBrowserElementAction(
      debuggerPort,
      "input",
      { kind: "type", text: "hello", clear: false },
      () => fence.assert(token, "https://approved.example/form"),
    ),
    "input",
  );
  assert.ok(sent.includes("Input.insertText"));
  broker.resolveCommand({
    sessionId: "session-a",
    leaseId: lease.leaseId,
    commandId: command!.commandId,
    ok: true,
    result: {},
  });
  await pending;
});
