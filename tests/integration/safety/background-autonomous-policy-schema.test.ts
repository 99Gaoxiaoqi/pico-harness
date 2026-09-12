import assert from "node:assert/strict";
import test from "node:test";
import {
  BackgroundAutonomousPolicySnapshotError,
  parseBackgroundAutonomousPolicySnapshot,
  parsePersistedBackgroundAutonomousPolicySnapshot,
} from "../../../src/safety/background-autonomous-policy-schema.js";

const BASE_POLICY = {
  backgroundEnabled: true,
  trustedWorkspace: true,
  toolNetworkPolicy: "disabled",
  allowedTools: ["read_file"],
  hardlineVersion: "hardline-v1",
  hookVersion: "hook-v1",
  createdAt: 1,
} as const;

test("background policy migrates durable yolo without accepting it at the live boundary", () => {
  const legacy = { ...BASE_POLICY, mode: "yolo" };
  const decoded = parsePersistedBackgroundAutonomousPolicySnapshot(legacy);
  assert.equal(decoded.mode, "full-access");
  assert.throws(
    () => parseBackgroundAutonomousPolicySnapshot(legacy),
    BackgroundAutonomousPolicySnapshotError,
  );
  assert.deepEqual(parseBackgroundAutonomousPolicySnapshot(decoded), decoded);
});

test("background durable policy rejects unknown modes instead of widening authority", () => {
  for (const mode of ["default", "plan", "root", undefined]) {
    assert.throws(
      () => parsePersistedBackgroundAutonomousPolicySnapshot({ ...BASE_POLICY, mode }),
      BackgroundAutonomousPolicySnapshotError,
    );
  }
});
