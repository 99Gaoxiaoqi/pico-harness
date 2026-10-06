import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  beginGatewayMaintenance,
  finishGatewayMaintenance,
  readGatewayServiceState,
  recordGatewayExit,
  setGatewayDesiredRunning,
  writeActiveGatewayRuntime,
  type ActiveGatewayRuntime,
} from "../../../packages/remote-gateway/src/supervision-state.js";
import {
  createGatewaySystemSupervisor,
  macGatewayLauncher,
  windowsGatewayTask,
} from "../../../apps/desktop/src/main/gateway-system-supervision.js";
import { RemoteManagementService } from "../../../apps/desktop/src/main/remote-management-service.js";

const stateModule = resolve("packages/remote-gateway/dist/supervision-state.js");
const runtime = (home: string): ActiveGatewayRuntime => ({
  schemaVersion: 1,
  buildId: "1.2.3",
  executablePath: process.execPath,
  gatewayPath: join(home, "gateway.cjs"),
  runtimeHome: join(home, "非默认 runtime home"),
  pathEntries: [join(home, "工具 bin")],
});
async function fixture(t: { after: (action: () => Promise<unknown>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "pico 监督 中文-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await Promise.all(
    ["gateway.cjs", "gateway-supervisor.cjs", "daemon.cjs"].map((name) =>
      writeFile(join(home, name), ""),
    ),
  );
  return home;
}

test("共享状态锁跨进程保持代次，旧更新不能覆盖停止，过期维护只清除自己的意图", async (t) => {
  const home = await fixture(t);
  const legacy = join(home, "mobile-connection.json");
  await writeFile(legacy, JSON.stringify({ enabled: true }));
  assert.equal((await readGatewayServiceState(home, legacy)).desiredRunning, true);
  const childScript = join(home, "state-writer.mjs");
  await writeFile(
    childScript,
    `import { setGatewayDesiredRunning } from ${JSON.stringify(stateModule)}; for(let i=0;i<8;i++) await setGatewayDesiredRunning(process.argv[2], i%2===0);`,
  );
  await Promise.all(
    Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [childScript, home])),
  );
  assert.equal((await readGatewayServiceState(home)).generation, 32);
  await setGatewayDesiredRunning(home, true);
  const update = await beginGatewayMaintenance(home, "old-build");
  await recordGatewayExit(home, { at: Date.now(), code: 0 });
  assert.equal((await readGatewayServiceState(home)).generation, update.generation);
  await setGatewayDesiredRunning(home, false);
  assert.equal(await finishGatewayMaintenance(home, update.generation), false);
  assert.equal((await readGatewayServiceState(home, legacy)).desiredRunning, false);
  const expiry = await beginGatewayMaintenance(home, "new-build", 10);
  await delay(20);
  const expired = await readGatewayServiceState(home);
  assert.equal(expired.maintenance, undefined);
  assert.equal(expired.desiredRunning, false);
  assert.equal(expired.generation, expiry.generation + 1);
  assert.equal(await finishGatewayMaintenance(home, expiry.generation), false);
  if (process.platform !== "win32")
    assert.equal((await stat(join(home, "service-state.json"))).mode & 0o777, 0o600);
});

test("macOS和Windows监督注册使用用户会话任务，开发模式不触碰系统注册", async (t) => {
  const home = await fixture(t);
  const commands: { file: string; args: readonly string[] }[] = [];
  let present = false;
  const run = async (file: string, args: readonly string[]) => {
    commands.push({ file, args });
    if (args.includes("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"))
      return "S-1-5-21-123-456-789-1001\n";
    if (args[0] === "print" || args[0] === "/Query") {
      if (!present) throw new Error("missing");
    }
    if (args[0] === "bootstrap" || args[0] === "/Create") present = true;
    return "";
  };
  const mac = createGatewaySystemSupervisor({
    home,
    packaged: true,
    platform: "darwin",
    userHome: home,
    uid: 501,
    run,
  });
  await mac.register(runtime(home));
  await mac.launch();
  assert.equal(await mac.registered(), true);
  const plist = join(home, "Library", "LaunchAgents", "com.pico.harness.remote-gateway.plist");
  const xml = await readFile(plist, "utf8");
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(xml, /<key>SuccessfulExit<\/key><false\/>/u);
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>15<\/integer>/u);
  const launcher = join(home, "supervision", "gateway-launcher.sh");
  if (process.platform !== "win32") await promisify(execFile)("/bin/sh", ["-n", launcher]);
  if (process.platform === "darwin") await promisify(execFile)("/usr/bin/plutil", ["-lint", plist]);
  assert.match(await readFile(launcher, "utf8"), /env -i/u);
  present = false;
  const windows = createGatewaySystemSupervisor({ home, packaged: true, platform: "win32", run });
  await windows.register(runtime(home));
  await windows.disable();
  const task = (await readFile(join(home, "supervision", "gateway-task.xml"))).toString("utf16le");
  assert.equal(task.charCodeAt(0), 0xfeff);
  for (const expected of [
    "InteractiveToken",
    "LeastPrivilege",
    "PT1M",
    "IgnoreNew",
    "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<DisallowStartIfOnBatteries>false",
    "<StopIfGoingOnBatteries>false",
    "<StartWhenAvailable>true",
  ])
    assert.ok(task.includes(expected));
  const ps = await readFile(join(home, "supervision", "gateway-launcher.ps1"), "utf8");
  assert.match(ps, /param\(\[Parameter\(Mandatory=\$true\)\]\[string\]\$GatewayHome\)/u);
  assert.doesNotMatch(ps, /\$Home\b/iu);
  assert.match(task, /-GatewayHome /u);
  assert.doesNotMatch(task, /-Home /u);
  assert.match(ps, /CreateNoWindow=\$true/u);
  assert.match(ps, /WaitForExit\(\)/u);
  assert.match(ps, /EnvironmentVariables.Clear\(\)/u);
  assert.ok(commands.some(({ args }) => args[0] === "/Create" && args.includes("/XML")));
  assert.ok(!commands.some(({ args }) => args.includes("/RP") || args.includes("/RU")));
  const before = commands.length;
  const dev = createGatewaySystemSupervisor({ home, packaged: false, run });
  await dev.register(runtime(home));
  await dev.launch();
  assert.equal(dev.backend, "none");
  assert.equal(commands.length, before);
  assert.match(macGatewayLauncher("/tmp/a'b 中文"), /a'"'"'b 中文/u);
  assert.throws(() => windowsGatewayTask("wrong", "powershell.exe", "a", "b"), /SID_INVALID/u);
});

test("Desktop先确认系统注册再写运行意图，更新停机与重新登记保持随后发生的停止", async (t) => {
  const home = await fixture(t);
  const order: string[] = [];
  let running = false;
  const service = new RemoteManagementService({
    preferencesDirectory: home,
    gatewayHome: home,
    activeRuntime: async () => runtime(home),
    supervisor: {
      backend: "launchd",
      registered: async () => true,
      register: async () => {
        assert.equal((await readGatewayServiceState(home)).desiredRunning, false);
        order.push("register");
      },
      enable: async () => {
        order.push("enable");
      },
      launch: async () => {
        assert.equal((await readGatewayServiceState(home)).desiredRunning, true);
        running = true;
        order.push("launch");
      },
      disable: async () => {
        order.push("disable");
      },
      unregister: async () => undefined,
    },
    readConfiguration: async () => ({ configured: true, workspaces: [] }),
    configure: async () => undefined,
    spawn: async () => {
      throw new Error("OS owns startup");
    },
    makeQr: () => "",
    delay: async () => undefined,
    control: async (method) => {
      if (!running) throw new Error("offline");
      if (method === "status") return { buildId: "1.2.3" };
      if (method === "devices.list") return { devices: [] };
      if (method === "pair.pending") return [];
      if (method === "stopForUpdate") {
        const state = await beginGatewayMaintenance(home, "1.2.3");
        running = false;
        return state.maintenance;
      }
      throw new Error("unexpected");
    },
  });
  const started = await service.start();
  assert.deepEqual(order.slice(0, 3), ["register", "enable", "launch"]);
  assert.equal(started.running, true);
  assert.equal(started.supervision?.runningBuildId, "1.2.3");
  await service.prepareForUpdate();
  assert.equal((await readGatewayServiceState(home)).desiredRunning, true);
  const maintenance = (await readGatewayServiceState(home)).maintenance!;
  await setGatewayDesiredRunning(home, false);
  await service.restore();
  assert.equal((await readGatewayServiceState(home)).desiredRunning, false);
  assert.equal(await finishGatewayMaintenance(home, maintenance.generation), false);
  assert.equal(order.filter((value) => value === "launch").length, 1);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.supervision?.phase, "stopped");
});

test("没有Desktop或既有daemon时，从精简系统环境冷启动仍使用登记的PICO_HOME和中文空格工具目录", async (t) => {
  if (process.platform === "win32") {
    t.skip("此进程验证使用 POSIX 工具；真实 Windows 打包冷启动另行验收");
    return;
  }
  const home = await fixture(t);
  const registered = runtime(home);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(registered.pathEntries[0]!);
  const tool = join(registered.pathEntries[0]!, "pico-supervision-tool");
  await writeFile(tool, "#!/bin/sh\nprintf tool-ok\n");
  await chmod(tool, 0o700);
  const evidence = join(home, "daemon-environment.json");
  await writeFile(
    join(home, "daemon.cjs"),
    `const fs=require('node:fs'); const cp=require('node:child_process'); fs.writeFileSync(${JSON.stringify(evidence)},JSON.stringify({home:process.env.PICO_HOME,path:process.env.PATH,buildId:process.env.PICO_GATEWAY_BUILD_ID,secret:process.env.OPENAI_API_KEY,nodeOptions:process.env.NODE_OPTIONS,tool:cp.execFileSync('pico-supervision-tool',[],{encoding:'utf8'})}));`,
  );
  await writeFile(
    registered.gatewayPath,
    `const cp=require('node:child_process'); const child=cp.spawn(process.execPath,[${JSON.stringify(join(home, "daemon.cjs"))}],{stdio:'inherit'}); child.once('exit',()=>setTimeout(()=>process.exit(0),300));`,
  );
  await writeActiveGatewayRuntime(home, registered);
  await setGatewayDesiredRunning(home, true);
  const entry = join(home, "supervisor-test.mts");
  await writeFile(
    entry,
    `import { runGatewaySupervisor } from ${JSON.stringify(resolve("apps/desktop/src/main/gateway-supervisor.ts"))}; process.exitCode = await runGatewaySupervisor(${JSON.stringify(home)});`,
  );
  const child = spawn(
    process.execPath,
    ["--import", resolve("node_modules/tsx/dist/loader.mjs"), entry],
    {
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        TMPDIR: tmpdir(),
        OPENAI_API_KEY: "must-not-copy",
        NODE_OPTIONS: "",
      },
      stdio: "pipe",
    },
  );
  let error = "";
  child.stderr.on("data", (value: Buffer) => {
    error += value.toString();
  });
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  for (let i = 0; i < 200; i++) {
    try {
      await access(evidence);
      break;
    } catch {
      await delay(20);
    }
  }
  await setGatewayDesiredRunning(home, false);
  assert.equal(await exited, 0, error);
  const observed = JSON.parse(await readFile(evidence, "utf8"));
  assert.equal(observed.home, registered.runtimeHome);
  assert.equal(observed.tool, "tool-ok");
  assert.equal(observed.buildId, registered.buildId);
  assert.equal(observed.path.split(":")[0], registered.pathEntries[0]);
  assert.equal(observed.secret, undefined);
  assert.equal(observed.nodeOptions, undefined);
  const lastExit = (await readGatewayServiceState(home)).lastExit;
  assert.ok(lastExit?.code === 0 || lastExit?.signal === "SIGTERM");
});

test("启动中的真实Gateway子进程遇到停止或维护会退出，维护结束只启动当前代次", async (t) => {
  if (process.platform === "win32") {
    t.skip("此进程验证使用当前 POSIX Node fixture；真实 Windows 后台另行验收");
    return;
  }
  const home = await fixture(t);
  const registered = runtime(home);
  const marker = join(home, "starting-child.json");
  const exitMarker = join(home, "terminated-child.json");
  const count = join(home, "child-count.json");
  await writeFile(
    registered.gatewayPath,
    `const fs=require('node:fs');const countFile=${JSON.stringify(count)};const n=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8'))+1:1;fs.writeFileSync(countFile,String(n));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,n,generation:Number(process.env.PICO_GATEWAY_SUPERVISION_GENERATION)}));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(exitMarker)},JSON.stringify({pid:process.pid,n}));process.exit(0);});setInterval(()=>{},1000);`,
  );
  await writeActiveGatewayRuntime(home, registered);
  const firstState = await setGatewayDesiredRunning(home, true);
  const entry = join(home, "supervisor-race.mts");
  await writeFile(
    entry,
    `import { runGatewaySupervisor } from ${JSON.stringify(resolve("apps/desktop/src/main/gateway-supervisor.ts"))}; process.exitCode = await runGatewaySupervisor(${JSON.stringify(home)});`,
  );
  const launch = () =>
    spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), entry], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir() },
      stdio: "pipe",
    });
  async function waitMarker(path: string, expected: number) {
    for (let i = 0; i < 200; i++) {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value.n === expected) return value as { pid: number; n: number; generation?: number };
      } catch {
        /* marker not published */
      }
      await delay(20);
    }
    throw new Error(`child marker ${expected} did not arrive`);
  }
  const first = launch();
  t.after(() => {
    first.kill("SIGKILL");
  });
  const firstExit = new Promise<number | null>((done) => first.once("exit", done));
  const started = await waitMarker(marker, 1);
  assert.equal(started.generation, firstState.generation);
  await setGatewayDesiredRunning(home, false);
  await waitMarker(exitMarker, 1);
  assert.equal(await firstExit, 0);
  assert.throws(() => process.kill(started.pid, 0), /ESRCH/u);
  await setGatewayDesiredRunning(home, true);
  const second = launch();
  t.after(() => {
    second.kill("SIGKILL");
  });
  const secondExit = new Promise<number | null>((done) => second.once("exit", done));
  const beforeUpdate = await waitMarker(marker, 2);
  const maintenance = await beginGatewayMaintenance(home, "1.2.3", 5_000);
  await waitMarker(exitMarker, 2);
  assert.throws(() => process.kill(beforeUpdate.pid, 0), /ESRCH/u);
  assert.equal(await finishGatewayMaintenance(home, maintenance.generation), true);
  const afterUpdate = await waitMarker(marker, 3);
  assert.equal(afterUpdate.generation, maintenance.generation + 1);
  await setGatewayDesiredRunning(home, false);
  await waitMarker(exitMarker, 3);
  assert.equal(await secondExit, 0);
});
