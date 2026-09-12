import assert from "node:assert/strict";
import test from "node:test";
import {
  BackgroundAutonomousPolicySnapshotError,
  parseBackgroundAutonomousPolicySnapshot,
} from "../../../src/safety/background-autonomous-policy-schema.js";

const BASE_POLICY = {
  mode: "full-access",
  backgroundEnabled: true,
  trustedWorkspace: true,
  toolNetworkPolicy: "disabled",
  allowedTools: ["read_file"],
  hardlineVersion: "hardline-v1",
  hookVersion: "hook-v1",
  createdAt: 1,
} as const;

test("background policy accepts only the canonical full-access shape", () => {
  assert.deepEqual(parseBackgroundAutonomousPolicySnapshot(BASE_POLICY), BASE_POLICY);
});

test("background policy rejects removed modes and network field names", () => {
  for (const mode of ["yolo", "default", "plan", "root", undefined]) {
    assert.throws(
      () => parseBackgroundAutonomousPolicySnapshot({ ...BASE_POLICY, mode }),
      BackgroundAutonomousPolicySnapshotError,
    );
  }
  for (const legacyFields of [
    { networkPolicy: "disabled" },
    { allowedNetworkHosts: ["example.com"] },
  ]) {
    assert.throws(
      () => parseBackgroundAutonomousPolicySnapshot({ ...BASE_POLICY, ...legacyFields }),
      /旧版 networkPolicy\/allowedNetworkHosts 字段不受支持/u,
    );
  }
});

test("background policy requires an MCP config fingerprint", () => {
  assert.throws(
    () =>
      parseBackgroundAutonomousPolicySnapshot({
        ...BASE_POLICY,
        allowedTools: ["mcp__example__read"],
      }),
    /后台 MCP 工具必须绑定/u,
  );
  const canonical = {
    ...BASE_POLICY,
    allowedTools: ["mcp__example__read"],
    mcpConfigFingerprint: "a".repeat(64),
  };
  assert.deepEqual(parseBackgroundAutonomousPolicySnapshot(canonical), canonical);
});
