import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportedNodeVersion,
  NODE_RUNTIME_SUPPORT_LABEL,
} from "../../src/runtime/node-version-policy.js";

test("Node runtime policy accepts maintained verified release lines", () => {
  for (const version of ["22.13.0", "v22.23.0", "24.3.0", "24.18.0", "26.0.0", "26.5.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
  assert.equal(NODE_RUNTIME_SUPPORT_LABEL, "Node 22.13+、24.3+ 或 26.x");
});

test("Node runtime policy rejects unsupported minors, EOL odd releases, and future majors", () => {
  for (const version of ["22.12.9", "24.2.9", "23.11.0", "25.1.0", "27.0.0", "21.9.0", "invalid"]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});
