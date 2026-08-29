import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidAgentGraphOperatorProfileSnapshot,
  createBuiltinAgentGraphOperatorProfileCatalog,
} from "../../src/agent-graph/operator-profile-catalog.js";

test("builtin Graph Operator catalog resolves immutable least-privilege snapshots", () => {
  const catalog = createBuiltinAgentGraphOperatorProfileCatalog();
  assert.deepEqual(
    catalog.listPublicProfiles().map((profile) => profile.profileId),
    ["explore", "implement", "review"],
  );

  const first = catalog.resolve({ profileId: "explore", rootModelRouteId: "route-a" });
  const replay = catalog.resolve({ profileId: "explore", rootModelRouteId: "route-a" });
  const otherRoute = catalog.resolve({ profileId: "explore", rootModelRouteId: "route-b" });

  assert.deepEqual(first, replay);
  assert.notEqual(first.profileFingerprint, otherRoute.profileFingerprint);
  assert.deepEqual(first.permissionPolicy, { mode: "default", allowSessionGrants: false });
  assert.equal(first.extensionPolicy, "none");
  assert.deepEqual(first.tools, ["read_file", "glob", "grep", "repo_map"]);
  assertValidAgentGraphOperatorProfileSnapshot(first);
  assert.throws(
    () => catalog.resolve({ profileId: "unknown", rootModelRouteId: "route-a" }),
    /Unknown Agent Graph Operator profile/u,
  );
});

test("Graph Operator snapshot validation fails closed on every execution-boundary drift", () => {
  const snapshot = createBuiltinAgentGraphOperatorProfileCatalog().resolve({
    profileId: "implement",
    rootModelRouteId: "route-a",
  });
  const invalidSnapshots: unknown[] = [
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, modelRouteId: "route-b" },
    { ...snapshot, tools: [...snapshot.tools, "agent_output"] },
    { ...snapshot, permissionPolicy: { mode: "yolo", allowSessionGrants: true } },
    { ...snapshot, systemPrompt: { ...snapshot.systemPrompt, content: "tampered" } },
    { ...snapshot, extensionPolicy: "workspace" },
    { ...snapshot, extra: true },
  ];

  for (const candidate of invalidSnapshots) {
    assert.throws(() => assertValidAgentGraphOperatorProfileSnapshot(candidate));
  }
});
