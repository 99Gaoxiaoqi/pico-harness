import assert from "node:assert/strict";
import test from "node:test";
import { DesktopInteractionBroker } from "../../src/daemon/desktop-interaction-broker.js";
import { createDesktopInteractionOwnerKey } from "../../src/daemon/production-host.js";

test("Desktop run ownerKey 稳定、定长且可被交互 Broker 接受", () => {
  const identity = ["/工作区/项目", "session-1", "run-1"] as const;
  const ownerKey = createDesktopInteractionOwnerKey(...identity);

  assert.equal(ownerKey, createDesktopInteractionOwnerKey(...identity));
  assert.match(ownerKey, /^desktop-run:v1:[0-9a-f]{64}$/);
  assert.doesNotThrow(() => new DesktopInteractionBroker({ ownerKey }));
});

test("Desktop run ownerKey 保留三元组字段边界并隔离不同运行", () => {
  const boundaryA = createDesktopInteractionOwnerKey("/a", "b/c", "d");
  const boundaryB = createDesktopInteractionOwnerKey("/a/b", "c", "d");
  const nextRun = createDesktopInteractionOwnerKey("/a", "b/c", "run-next");

  assert.notEqual(boundaryA, boundaryB);
  assert.notEqual(boundaryA, nextRun);
});
