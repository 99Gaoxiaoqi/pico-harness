import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const imports = `
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ApprovalManager } from "@pico/pico-host/approval-manager";
`;

function runIsolatedApproval(source: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", imports + source], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /PASS/);
}

test("pending approval keeps an otherwise idle process alive until its timeout denies it", () => {
  runIsolatedApproval(`
const manager = new ApprovalManager(25);
const result = await manager.waitForApproval(
  "timeout", "read", "{}", () => {}, undefined, undefined, { providerCallId: "call" },
);
assert.equal(result.allowed, false);
assert.match(result.reason, /审批超时/);
assert.equal(manager.pendingCount, 0);
console.log("PASS: approval timeout settled");
`);
});

test("settled and cleared approvals release deadlines and abort listeners before process exit", () => {
  runIsolatedApproval(`
const manager = new ApprovalManager(60_000);
for (const action of ["resolve", "session", "modify", "cancel", "abort", "clear"]) {
  const controller = new AbortController();
  const pending = manager.waitForApproval(
    action, "read", "{}", () => {}, undefined, controller.signal, { providerCallId: action },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  if (action === "resolve") {
    manager.resolveApproval(action, true, "approved");
    assert.deepEqual(await pending, { allowed: true, reason: "approved" });
  } else if (action === "session") {
    manager.resolveApprovalForSession(action, "approved");
    assert.equal((await pending).allowForSession, true);
  } else if (action === "modify") {
    manager.resolveApprovalWithModify(action, "approved", "changed");
    assert.equal((await pending).modifiedContent, "changed");
  } else if (action === "cancel") {
    manager.cancelApproval(action);
    assert.equal((await pending).allowed, false);
  } else if (action === "abort") {
    const reason = new Error("cancelled");
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
  } else {
    manager.clear();
  }
  assert.equal(manager.pendingCount, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}
for (const failureSource of ["notify", "logger"]) {
  const failure = new Error(failureSource);
  const controller = new AbortController();
  const failingManager = new ApprovalManager(60_000, {
    info() { if (failureSource === "logger") throw failure; },
    warn() {},
  });
  const rejected = failingManager.waitForApproval(
    failureSource, "read", "{}",
    () => { if (failureSource === "notify") throw failure; },
    undefined, controller.signal, { providerCallId: failureSource },
  );
  await assert.rejects(rejected, (error) => error === failure);
  assert.equal(failingManager.pendingCount, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}
console.log("PASS: approval resources released");
`);
});
