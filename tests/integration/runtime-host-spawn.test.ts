import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectOrSpawnRuntimeHost,
  connectOrSpawnRuntimeHostWithDependencies,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "../../packages/runtime-host/src/index.js";
import {
  launchDetachedRuntimeHostCandidate,
  type CandidateLauncher,
  type DetachedCandidateProcess,
} from "../../packages/runtime-host/src/client/launcher.js";
import { TestRuntimeHostCandidateTracker } from "./helpers/test-runtime-daemon.js";

const TEST_CANDIDATE_INPUT = {
  rootPath: tmpdir(),
  expectedRootId: "0".repeat(64),
};

test("runtime-host spawn: teardown owns a late candidate before it ever registers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-late-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = join(root, "never-registers.mjs");
  writeFileSync(scriptPath, "setInterval(() => undefined, 1000);\n");
  const tracker = new TestRuntimeHostCandidateTracker();
  t.after(() => tracker.stopAll());

  const attempt = await tracker.launcher({
    rootPath: root,
    expectedRootId: "0".repeat(64),
    executable: process.execPath,
    entrypoint: scriptPath,
  }).spawned;
  assert.ok(attempt.process && !attempt.process.exited, "未注册候选应已被启动句柄捕获");

  await tracker.stopAll();
  assert.equal(attempt.process.exited, true, "无需等待 registration quiet window 也应完成退出");
});

test("runtime-host spawn: teardown waits for a delayed spawn result before stopping it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-delayed-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = join(root, "delayed-result.mjs");
  writeFileSync(scriptPath, "setInterval(() => undefined, 1000);\n");
  let ownedProcess: DetachedCandidateProcess | undefined;
  const delayedLauncher: CandidateLauncher = (input) => {
    const launch = launchDetachedRuntimeHostCandidate(input);
    return {
      spawned: launch.spawned.then(
        (attempt) =>
          new Promise((resolve) => {
            ownedProcess = attempt.process;
            setTimeout(() => resolve(attempt), 100);
          }),
      ),
    };
  };
  const tracker = new TestRuntimeHostCandidateTracker({ launchCandidate: delayedLauncher });
  t.after(() => tracker.stopAll());
  const launch = tracker.launcher({
    rootPath: root,
    expectedRootId: "0".repeat(64),
    executable: process.execPath,
    entrypoint: scriptPath,
  });

  await tracker.stopAll();
  const attempt = await launch.spawned;
  assert.equal(attempt.process, ownedProcess);
  assert.equal(ownedProcess?.exited, true, "晚到的 spawned 结果也必须等待到终态");
});

test("runtime-host spawn: teardown escalates only through the captured process capability", async () => {
  const signals: string[] = [];
  let exited = false;
  let resolveClosed!: () => void;
  const processCapability: DetachedCandidateProcess = {
    pid: 73_001,
    get exited() {
      return exited;
    },
    closed: new Promise((resolve) => {
      resolveClosed = () => resolve({ code: null, signal: "SIGKILL" });
    }),
    terminate(signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        exited = true;
        resolveClosed();
      }
      return true;
    },
  };
  const tracker = new TestRuntimeHostCandidateTracker({
    launchCandidate: () => ({
      spawned: Promise.resolve({ pid: processCapability.pid, process: processCapability }),
    }),
    gracefulExitTimeoutMs: 5,
    forcedExitTimeoutMs: 50,
  });
  await tracker.launcher(TEST_CANDIDATE_INPUT).spawned;

  await tracker.stopAll();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("runtime-host spawn: a failed launch settles teardown without inventing PID ownership", async () => {
  const tracker = new TestRuntimeHostCandidateTracker({
    launchCandidate: () => ({ spawned: Promise.reject(new Error("expected spawn failure")) }),
  });
  await assert.rejects(tracker.launcher(TEST_CANDIDATE_INPUT).spawned, /expected spawn failure/);
  await assert.doesNotReject(tracker.stopAll());
});

test("runtime-host spawn: an exited identity is never signalled even if its PID is stale", async () => {
  let terminateCalls = 0;
  const staleProcess: DetachedCandidateProcess = {
    pid: 73_002,
    exited: true,
    closed: Promise.resolve({ code: 0, signal: null }),
    terminate() {
      terminateCalls += 1;
      return true;
    },
  };
  const tracker = new TestRuntimeHostCandidateTracker({
    launchCandidate: () => ({
      spawned: Promise.resolve({ pid: staleProcess.pid, process: staleProcess }),
    }),
  });
  await tracker.launcher(TEST_CANDIDATE_INPUT).spawned;

  await tracker.stopAll();
  assert.equal(terminateCalls, 0, "已退出句柄不得因 PID 复用而再次发信号");
});

test("runtime-host spawn: connectOrSpawnRuntimeHost launches a detached candidate and connects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidates = new TestRuntimeHostCandidateTracker();
  t.after(() => candidates.stopAll());

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
    candidateLauncher: candidates.launcher,
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

test("runtime-host spawn: candidate launches are throttled by the minimum interval", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-throttle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  // 假 launcher：spawn 立即"成功"但无真实 host 落定，选举循环只能轮询到
  // deadline。250ms 最小间隔是无数量上限形态下唯一的 launch 节流闸门——
  // 直接断言相邻 launch 的时间间隔，防止节流被误删后退化为逐轮补发。
  const launchTimes: number[] = [];
  const result = await connectOrSpawnRuntimeHostWithDependencies(
    {
      rootPath: root,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "spawn-throttle-test-client",
      electionDeadlineMs: 1500,
    },
    {
      launchCandidate: () => {
        launchTimes.push(performance.now());
        return { spawned: Promise.resolve({ pid: 40_000 + launchTimes.length }) };
      },
      random: () => 0.5,
    },
  );

  assert.equal(result.kind, "failed", "无真实候选时选举应失败");
  assert.ok(launchTimes.length >= 3, `1.5s 窗口内应多次补发候选，实际 ${launchTimes.length} 次`);
  const minObservedGap = launchTimes
    .slice(1)
    .reduce((min, time, i) => Math.min(min, time - launchTimes[i]!), Number.POSITIVE_INFINITY);
  assert.ok(
    minObservedGap >= 240,
    `相邻候选 launch 间隔应保持 250ms 最小节流（观测最小 ${minObservedGap.toFixed(1)}ms）`,
  );
});

test("runtime-host spawn: permanent candidate startup failure fast-fails the election", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-fastfail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  // 假 launcher：候选"成功 spawn"但立即上报永久性启动失败（退出码 65 形态）。
  // fast-fail 语义：第一个报告收齐后立即刹车返回，不再按 250ms 节流补发
  // 烧完整个选举窗口——确定性失败从"45s 空转"变成"一次上报即收场"。
  let launches = 0;
  const result = await connectOrSpawnRuntimeHostWithDependencies(
    {
      rootPath: root,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "spawn-fastfail-test-client",
      electionDeadlineMs: 2000,
    },
    {
      launchCandidate: () => {
        launches += 1;
        return {
          spawned: Promise.resolve({
            pid: 41_000 + launches,
            startupFailure: Promise.resolve({ reason: "storage_root_incompatible" as const }),
          }),
        };
      },
      random: () => 0.5,
    },
  );

  assert.equal(result.kind, "failed", "永久失败应使选举失败返回");
  if (result.kind === "failed") {
    assert.equal(result.reason, "storage_root_incompatible");
  }
  assert.equal(launches, 1, `永久失败应在首个报告后刹车（实际拉起 ${launches} 个）`);
});

test("runtime-host spawn: non-permanent startup failure does not brake, reason carries to result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-softfail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  // 非永久失败（legacy 守卫拒绝/内部启动失败）不刹车——循环继续按节流补发
  // 到 deadline；收场时 failed.reason 携带上报的失败类，区分"候选在失败"
  // 与"什么都没出现"。
  let launches = 0;
  const result = await connectOrSpawnRuntimeHostWithDependencies(
    {
      rootPath: root,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "spawn-softfail-test-client",
      electionDeadlineMs: 1500,
    },
    {
      launchCandidate: () => {
        launches += 1;
        return {
          spawned: Promise.resolve({
            pid: 42_000 + launches,
            startupFailure: Promise.resolve({ reason: "legacy_daemon_running" as const }),
          }),
        };
      },
      random: () => 0.5,
    },
  );

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.reason, "legacy_daemon_running");
  }
  assert.ok(launches >= 2, `非永久失败不应刹车，窗口内应多次补发（实际 ${launches} 个）`);
});

test("runtime-host spawn: launcher decodes protocol exit codes into startup failure reports", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-exitcode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 真 launcher + 真进程退出码：协议内退出码（65）必须反查回失败报告，
  // 协议外退出码（flock loser 的 2）必须解析为 undefined——这座桥是 candidate
  // 侧退出码与 connectOrSpawn 消费端之间的唯一信道。
  // 注意：unref 的 child 不维持本进程事件循环，裸 await 报告 promise 会在循环
  // 撤空后被判 dangling——真实消费方（选举循环）总有退避计时器保活，这里用
  // ref'd 计时器竞速模拟同样的保活条件。
  const awaitReport = <T>(promise: Promise<T>, timeoutMs = 5000): Promise<T | "timeout"> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const launchScript = (name: string, exitCode: number): string => {
    const scriptPath = join(root, name);
    writeFileSync(scriptPath, `process.exit(${exitCode});\n`);
    return scriptPath;
  };
  const launchWith = (entrypoint: string) =>
    launchDetachedRuntimeHostCandidate({
      rootPath: root,
      expectedRootId: "0".repeat(64),
      executable: process.execPath,
      entrypoint,
      logDirectory: join(root, "candidate-logs"),
    });

  const permanent = await (await launchWith(launchScript("exit-65.mjs", 65))).spawned;
  assert.ok(permanent.startupFailure, "协议内退出码应暴露 startupFailure 报告");
  const permanentReport = await awaitReport(permanent.startupFailure);
  assert.notEqual(permanentReport, "timeout", "退出事件应在保活窗口内到达");
  assert.equal(
    permanentReport && permanentReport !== "timeout" ? permanentReport.reason : undefined,
    "storage_root_incompatible",
    "退出码 65 应反查为存储根不兼容（永久）",
  );

  const loser = await (await launchWith(launchScript("exit-2.mjs", 2))).spawned;
  assert.ok(loser.startupFailure, "attempt 应携带 startupFailure promise");
  const loserReport = await awaitReport(loser.startupFailure);
  assert.notEqual(loserReport, "timeout", "退出事件应在保活窗口内到达");
  assert.equal(loserReport, undefined, "协议外退出码（flock loser 2）应解析为无报告");
});

test("runtime-host spawn: candidate stdout/stderr is persisted to the log directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawnlog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logDirectory = join(root, "candidate-logs");
  // 一个往 stderr/stdout 各写一行就退出的脚本候选：死锁/崩溃取证依赖的正是
  // 这条"子进程输出必须落盘"的链路（此前 stdio: 'ignore' 全部丢弃）。
  const scriptPath = join(root, "noisy-candidate.mjs");
  writeFileSync(
    scriptPath,
    "console.error('candidate stderr evidence');\nconsole.log('candidate stdout evidence');\n",
  );

  const launch = launchDetachedRuntimeHostCandidate({
    rootPath: root,
    expectedRootId: "0".repeat(64),
    executable: process.execPath,
    entrypoint: scriptPath,
    logDirectory,
  });
  const attempt = await launch.spawned;

  assert.ok(attempt.logFile, "attempt 应报告日志文件路径");
  assert.ok(
    attempt.logFile.startsWith(logDirectory),
    `日志应在指定目录内，实际 ${attempt.logFile}`,
  );
  // detached 子进程异步写入；轮询到双行证据（带 10s 上限）。
  const deadline = Date.now() + 10_000;
  let contents = "";
  while (Date.now() < deadline) {
    contents = readFileSync(attempt.logFile, "utf8");
    if (
      contents.includes("candidate stderr evidence") &&
      contents.includes("candidate stdout evidence")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(contents, /# candidate launch/, "日志应带 launch 头部（空日志也证明 launch 发生）");
  assert.match(contents, /candidate stderr evidence/);
  assert.match(contents, /candidate stdout evidence/);
});
