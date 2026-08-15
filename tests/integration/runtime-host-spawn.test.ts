import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectOrSpawnRuntimeHost,
  connectOrSpawnRuntimeHostWithDependencies,
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

test("runtime-host spawn: election window caps candidate launches (A6)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawncap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  // 假 launcher：spawn 立即"成功"，但没有任何真实 host 会落定——选举循环只能
  // 持续轮询到 deadline。慢冷启动环境（候选 19-31s 才就绪）此前会按 250ms 间隔
  // 在整个窗口内堆积几十个在途候选；封顶后同窗口最多 3 个。
  let launches = 0;
  const result = await connectOrSpawnRuntimeHostWithDependencies(
    {
      rootPath: root,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "spawn-cap-test-client",
      electionDeadlineMs: 1500,
      maxCandidateLaunches: 3,
    },
    {
      launchCandidate: () => {
        launches += 1;
        return { spawned: Promise.resolve({ pid: 40_000 + launches }) };
      },
      random: () => 0.5,
    },
  );

  assert.equal(result.kind, "failed", "无真实候选时选举应失败");
  assert.equal(result.reason, "startup_timeout");
  assert.equal(launches, 3, `候选 launch 数应封顶在 3，实际 ${launches}`);
});
