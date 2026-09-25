import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildManagedSpawnPlan,
  createSandboxPolicy,
  type ManagedSpawnRequest,
} from "@pico/pico-host/process-sandbox";

const proofEnabled =
  process.platform === "win32" && process.env.PICO_WINDOWS_TASK_NETWORK_PROOF === "1";

test(
  "Windows task network capability and loopback exemption are task scoped and revocable",
  {
    skip: !proofEnabled,
    timeout: 180_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-task-network-proof-"));
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    const control = join(root, "control");
    await Promise.all([mkdir(workspace), mkdir(scratch), mkdir(control)]);
    const policy = createSandboxPolicy({
      profile: "read-only",
      workspaceRoots: [workspace],
      scratchRoot: scratch,
      config: { network: "deny" },
    });
    const broker = join(
      process.cwd(),
      "resources",
      "sandbox",
      "win32-x64",
      "pico-appcontainer-broker.exe",
    );
    assert.ok(existsSync(broker), `missing native Windows Broker: ${broker}`);
    const profileName = `PicoTaskNetwork.${randomBytes(16).toString("hex")}`;
    const otherProfileName = `PicoTaskNetwork.${randomBytes(16).toString("hex")}`;
    const taskId = `test-${randomBytes(8).toString("hex")}`;
    const boundaryRevision = 1;
    const loopback = createServer((socket) => socket.end("loopback-ok"));
    const privateAddress = Object.values(networkInterfaces())
      .flat()
      .find(
        (address) =>
          address?.family === "IPv4" &&
          !address.internal &&
          /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/u.test(address.address),
      )?.address;
    assert.ok(privateAddress, "Windows native proof requires a private IPv4 interface");
    const lan = createServer((socket) => socket.end("lan-ok"));
    await listen(loopback, "127.0.0.1");
    await listen(lan, privateAddress);
    const loopbackPort = portOf(loopback);
    const lanPort = portOf(lan);
    const probeScript = [
      'const net=require("node:net");',
      `const cases=${JSON.stringify([
        ["127.0.0.1", loopbackPort, "loopback-ok"],
        [privateAddress, lanPort, "lan-ok"],
        ["1.1.1.1", 443, ""],
      ])};`,
      "(async()=>{for(const [host,port,want] of cases){await new Promise((resolve,reject)=>{let data='';const s=net.connect({host,port});s.setTimeout(6000,()=>s.destroy(new Error('timeout')));s.on('data',c=>data+=c);s.on('connect',()=>{if(!want){s.destroy();resolve()}});s.on('end',()=>data===want?resolve():reject(new Error('unexpected response '+data)));s.on('error',reject)})}process.stdout.write('all-ok')})().catch(e=>{console.error(e);process.exit(23)})",
    ].join("");
    const loopbackOnlyScript = [
      'const s=require("node:net").connect({host:"127.0.0.1",port:',
      String(loopbackPort),
      '});s.setTimeout(4000,()=>s.destroy(new Error("timeout")));s.on("data",()=>process.stdout.write("connected"));s.on("end",()=>process.exit(0));s.on("error",()=>process.exit(23));',
    ].join("");
    let prepared = false;
    let crashPrepared = false;
    try {
      const blocked = await runSandboxed(loopbackOnlyScript);
      assert.notEqual(blocked.code, 0, "a process without a receipt reached host loopback");
      const externalOnlyScript =
        'const s=require("node:net").connect({host:"1.1.1.1",port:443});s.setTimeout(4000,()=>s.destroy(new Error("timeout")));s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(23));';
      const blockedExternal = await runSandboxed(externalOnlyScript);
      assert.notEqual(blockedExternal.code, 0, "a process without a receipt reached the Internet");

      const prepare = await runBroker([
        "--task-network",
        "prepare",
        "--profile-name",
        profileName,
        "--control-root",
        control,
        "--host-pid",
        String(process.pid),
        "--json",
      ]);
      assert.equal(prepare.code, 0, prepare.stderr);
      assert.equal(JSON.parse(prepare.stdout).result, "applied");
      prepared = true;
      const verify = await runBroker([
        "--task-network",
        "verify",
        "--profile-name",
        profileName,
        "--control-root",
        control,
        "--json",
      ]);
      assert.equal(verify.code, 0, verify.stderr);
      assert.equal(JSON.parse(verify.stdout).result, "match");

      const receipt = await writeReceipt(profileName, "session");
      const allowed = await runSandboxed(probeScript, receipt);
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.equal(allowed.stdout, "all-ok");

      const revoking = join(control, "revoking");
      await writeFile(revoking, "1", { flag: "wx" });
      const duringRevocation = await runSandboxed(loopbackOnlyScript, receipt);
      assert.notEqual(duringRevocation.code, 0, "a revoking task launched a network process");
      await rm(revoking);

      const fileWorker = await runSandboxed(loopbackOnlyScript, receipt, "file-worker");
      assert.notEqual(fileWorker.code, 0, "File Worker accepted network authority");

      const otherTaskReceipt = await writeReceipt(otherProfileName, "session");
      const otherTask = await runSandboxed(loopbackOnlyScript, otherTaskReceipt);
      assert.notEqual(otherTask.code, 0, "another task inherited the prepared network identity");

      const oneShot = await writeReceipt(profileName, "once");
      const onceAllowed = await runSandboxed(loopbackOnlyScript, oneShot);
      assert.equal(onceAllowed.code, 0, onceAllowed.stderr);
      const onceReplay = await runSandboxed(loopbackOnlyScript, oneShot);
      assert.notEqual(onceReplay.code, 0, "one-shot network receipt was replayed");

      const revoke = await runBroker([
        "--task-network",
        "revoke",
        "--profile-name",
        profileName,
        "--control-root",
        control,
        "--json",
      ]);
      assert.equal(revoke.code, 0, revoke.stderr);
      assert.equal(JSON.parse(revoke.stdout).result, "revoked");
      prepared = false;
      const afterRevoke = await runSandboxed(loopbackOnlyScript, receipt);
      assert.notEqual(afterRevoke.code, 0, "revoked task receipt still reached host loopback");

      const crashPrepare = await runBroker([
        "--task-network",
        "prepare",
        "--profile-name",
        otherProfileName,
        "--control-root",
        control,
        "--host-pid",
        String(process.pid),
        "--json",
      ]);
      assert.equal(crashPrepare.code, 0, crashPrepare.stderr);
      crashPrepared = true;
      const crashReceipt = await writeReceipt(otherProfileName, "session");
      const ready = await readFile(join(control, `network-${otherProfileName}.ready`), "utf8");
      const helperPid = Number(ready.split(":")[0]);
      assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
      process.kill(helperPid);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterCrash = await runSandboxed(loopbackOnlyScript, crashReceipt);
      assert.notEqual(afterCrash.code, 0, "a crashed helper left a usable network receipt");
      const crashVerify = await runBroker([
        "--task-network",
        "verify",
        "--profile-name",
        otherProfileName,
        "--control-root",
        control,
        "--json",
      ]);
      assert.notEqual(crashVerify.code, 0, "crashed helper still verified as prepared");
      const crashRevoke = await runBroker([
        "--task-network",
        "revoke",
        "--profile-name",
        otherProfileName,
        "--control-root",
        control,
        "--json",
      ]);
      assert.notEqual(crashRevoke.code, 0, "crashed helper cleanup silently succeeded");
      const helper = join(dirname(broker), "pico-appcontainer-host-prep.exe");
      const recover = await runProcess(
        helper,
        ["recover-task-network", "--profile-name", otherProfileName, "--json"],
        process.env,
      );
      assert.equal(recover.code, 0, recover.stderr);
      const finalRevoke = await runBroker([
        "--task-network",
        "revoke",
        "--profile-name",
        otherProfileName,
        "--control-root",
        control,
        "--json",
      ]);
      assert.equal(finalRevoke.code, 0, finalRevoke.stderr);
      crashPrepared = false;
    } finally {
      if (prepared) {
        await runBroker([
          "--task-network",
          "revoke",
          "--profile-name",
          profileName,
          "--control-root",
          control,
          "--json",
        ]);
      }
      if (crashPrepared) {
        const helper = join(dirname(broker), "pico-appcontainer-host-prep.exe");
        await runProcess(
          helper,
          ["recover-task-network", "--profile-name", otherProfileName],
          process.env,
        );
        await runBroker([
          "--task-network",
          "revoke",
          "--profile-name",
          otherProfileName,
          "--control-root",
          control,
          "--json",
        ]);
      }
      loopback.close();
      lan.close();
      await rm(root, { recursive: true, force: true });
    }

    async function writeReceipt(profile: string, scope: "session" | "once"): Promise<string> {
      const ticket = randomBytes(32).toString("hex");
      const path = join(control, `${ticket}.json`);
      await writeFile(
        path,
        JSON.stringify({
          schema: 1,
          taskId,
          boundaryRevision,
          generation: policy.generation,
          profileName: profile,
          scope,
          ticket,
          expiresAtMs: Date.now() + 300_000,
        }),
        { flag: "wx" },
      );
      return path;
    }

    async function runSandboxed(
      script: string,
      receipt?: string,
      origin: ManagedSpawnRequest["origin"] = "bash",
    ) {
      const plan = buildManagedSpawnPlan({
        command: process.execPath,
        args: ["-e", script],
        cwd: workspace,
        origin,
        policy,
        controlRoot: control,
      });
      assert.equal(plan.backend, "windows-appcontainer");
      const separator = plan.args.indexOf("--");
      assert.ok(separator > 0);
      const args = plan.args.slice(0, separator);
      setArg(args, "--origin", origin);
      if (receipt) {
        setArg(args, "--task-id", taskId);
        setArg(args, "--boundary-revision", String(boundaryRevision));
        setArg(args, "--network-receipt", receipt);
      }
      args.push(...plan.args.slice(separator));
      return runProcess(broker, args, plan.env);
    }

    function runBroker(args: string[]) {
      return runProcess(broker, args, process.env);
    }
  },
);

function setArg(args: string[], key: string, value: string): void {
  const index = args.indexOf(key);
  if (index < 0) args.push(key, value);
  else args[index + 1] = value;
}

function runProcess(executable: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function listen(server: ReturnType<typeof createServer>, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
