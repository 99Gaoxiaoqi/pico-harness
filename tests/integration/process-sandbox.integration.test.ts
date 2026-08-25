import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildBubblewrapArgs,
  buildMacosProfile,
  buildManagedSpawnPlan,
  buildSandboxEnvironment,
  createSandboxPolicy,
  isVerifiedBundledExecutable,
} from "../../src/safety/process-sandbox/index.js";
import { evaluateSandboxCommand } from "../../src/safety/yolo-sandbox.js";

test("sandbox profile 固定模式与网络语义", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");

  const readonly = createSandboxPolicy({
    profile: "read-only",
    workspaceRoots: [workspace],
    scratchRoot: scratch,
    config: { network: "allow" },
  });
  assert.equal(readonly.network, "deny");
  assert.deepEqual(readonly.writeRoots, [readonly.scratchRoot]);
  assert.ok(readonly.readRoots.includes(workspace));

  const writable = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [workspace],
    scratchRoot: scratch,
  });
  assert.equal(writable.network, "allow");
  assert.ok(writable.writeRoots.includes(workspace));

  const unrestricted = createSandboxPolicy({
    profile: "danger-full-access",
    workspaceRoots: [workspace],
    scratchRoot: scratch,
    config: { network: "deny" },
  });
  assert.equal(unrestricted.network, "allow");
});

test("受限环境继承普通变量并隔离 HOME、临时目录与缓存", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-env-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  const env = buildSandboxEnvironment(
    { PATH: process.env.PATH, PICO_FAKE_TOKEN: "visible", HOME: "/host/home" },
    policy,
  );
  assert.equal(env.PICO_FAKE_TOKEN, "visible");
  assert.notEqual(env.HOME, "/host/home");
  assert.match(env.HOME ?? "", /scratch[/\\]home$/u);
  assert.match(env.TMPDIR ?? "", /scratch[/\\]tmp$/u);
  assert.match(env.XDG_CACHE_HOME ?? "", /scratch[/\\]cache$/u);
});

test("macOS profile 不包含全局 file-read 且按根目录开放", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  const profile = buildMacosProfile(policy);
  assert.doesNotMatch(profile, /^\(allow file-read\*\)$/mu);
  const canonicalRoot = policy.readRoots.find((candidate) => candidate.endsWith(root.split("/").at(-1)!));
  assert.ok(canonicalRoot);
  assert.match(
    profile,
    new RegExp(
      `\\(allow file-read\\* file-test-existence \\(subpath ${escapeRegExp(JSON.stringify(canonicalRoot))}`,
    ),
  );
  assert.match(profile, /\(allow network\*\)/u);
});

test("Bubblewrap profile 使用空命名空间、只读运行根和工作区写挂载", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-bwrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
    readRoots: ["/usr"],
  });
  const args = buildBubblewrapArgs(policy, "/bin/sh", ["-c", "true"], root);
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--disable-userns"));
  assert.ok(args.includes("--share-net"));
  assert.deepEqual(args.slice(-4), ["--", "/bin/sh", "-c", "true"]);
  assert.ok(
    args.some(
      (value, index) =>
        value === "--bind" && policy.writeRoots.includes(args[index + 1] ?? ""),
    ),
  );
});

test("静态写路径允许伪设备但仍拒绝普通工作区外路径", () => {
  const workspace = process.cwd();
  assert.equal(evaluateSandboxCommand("ls 2>/dev/null", workspace, [workspace]).allowed, true);
  assert.equal(evaluateSandboxCommand("echo ok > NUL", workspace, [workspace]).allowed, true);
  assert.equal(evaluateSandboxCommand("echo blocked > /etc/pico", workspace, [workspace]).allowed, false);
});

test("打包原生后端必须通过同目录 SHA-256 校验", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-resource-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "helper");
  await writeFile(executable, "trusted", "utf8");
  await chmod(executable, 0o755);
  const digest = createHash("sha256").update("trusted").digest("hex");
  await writeFile(`${executable}.sha256`, `${digest}  helper\n`, "utf8");
  assert.equal(isVerifiedBundledExecutable(executable), true);
  await writeFile(executable, "tampered", "utf8");
  assert.equal(isVerifiedBundledExecutable(executable), false);
});

test(
  "macOS Seatbelt 真实执行允许工作区和 /dev/null、拒绝工作区外读取",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-real-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(outside, "secret", "utf8");
    const policy = createSandboxPolicy({
      profile: "workspace-write",
      workspaceRoots: [workspace],
      scratchRoot: join(root, "scratch"),
      config: { network: "deny" },
    });
    const command = `printf allowed > ./inside.txt; ls 2>/dev/null; cat ${JSON.stringify(outside)}`;
    const plan = buildManagedSpawnPlan({
      command: "/bin/bash",
      args: ["--noprofile", "--norc", "-c", command],
      cwd: workspace,
      origin: "bash",
      policy,
    });
    const result = spawnSync(plan.command, plan.args, { cwd: workspace, env: plan.env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "allowed");
    assert.doesNotMatch(result.stdout, /secret/u);
  },
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
