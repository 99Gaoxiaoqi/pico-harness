import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectOrSpawnRuntimeHost,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "../../packages/runtime-host/src/index.js";

test("runtime-host spawn: connectOrSpawnRuntimeHost launches a detached candidate and connects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  const result = await connectOrSpawnRuntimeHost({
    rootPath: root,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "spawn-test-client",
    electionDeadlineMs: 30000,
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    // 短 idle grace：connection.close() 后 candidate 无连接，1s 内自动 idle 退出。
    idleGraceMs: 1000,
  });

  assert.equal(result.kind, "connected", `期望 connected，实际 ${JSON.stringify(result.kind)}`);
  if (result.kind !== "connected") return;

  const connection = result.connection;
  const status = await connection.request("host.status", {}, 5000);
  assert.equal(status.state, "ready");
  assert.equal(typeof status.hostEpoch, "string");
  await connection.close();
});
