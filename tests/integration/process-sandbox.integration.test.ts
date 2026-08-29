import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  buildBubblewrapArgs,
  buildMacosProfile,
  buildManagedSpawnPlan,
  buildSandboxEnvironment,
  buildWindowsBrokerArgs,
  createSandboxPolicy,
  isVerifiedBundledExecutable,
  managedProcessLauncher,
  runtimeReadAliases,
  shellRuntimeReadRoots,
  WINDOWS_RESTRICTED_NODE_OPTIONS,
} from "../../src/safety/process-sandbox/index.js";
import { evaluateSandboxCommand } from "../../src/safety/yolo-sandbox.js";
import { createIsolatedPicoConfig } from "../../src/input/pico-config.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";
import type { McpClient } from "../../src/mcp/types.js";
import { BashTool } from "../../src/tools/bash.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";

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
  assert.equal(createIsolatedPicoConfig(workspace).sandbox.network, "allow");
});

test("Windows Broker 获取完整根目录与策略代次且不接受网络放行", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-winargs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
    generation: 7,
  });
  const args = buildWindowsBrokerArgs(policy, "node.exe", ["-e", "0"], root);
  assert.deepEqual(args.slice(-4), ["--", "node.exe", "-e", "0"]);
  assert.ok(args.includes("--read-root"));
  assert.ok(args.includes("--write-root"));
  assert.equal(args[args.indexOf("--generation") + 1], "7");
  assert.equal(args.includes("--network"), false);
});

test("Windows 受限进程只获得宿主固定的 Node 路径兼容参数", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-win-node-options-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const restricted = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [workspace],
    scratchRoot: join(root, "restricted-scratch"),
  });
  const restrictedPlan = buildManagedSpawnPlan({
    command: "powershell.exe",
    args: ["-Command", "node ./entry.cjs"],
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: "--require=untrusted-loader.cjs" },
    explicitEnvKeys: ["NODE_OPTIONS"],
    origin: "command-hook",
    policy: restricted,
    platform: "win32",
    controlRoot: join(root, "restricted-control"),
    backendExecutable: process.execPath,
  });
  assert.equal(restrictedPlan.env.NODE_OPTIONS, WINDOWS_RESTRICTED_NODE_OPTIONS);

  const unrestricted = createSandboxPolicy({
    profile: "danger-full-access",
    workspaceRoots: [workspace],
    scratchRoot: join(root, "unrestricted-scratch"),
  });
  const unrestrictedPlan = buildManagedSpawnPlan({
    command: "powershell.exe",
    args: [],
    cwd: workspace,
    env: { NODE_OPTIONS: "--require=trusted-by-unrestricted-host.cjs" },
    origin: "command-hook",
    policy: unrestricted,
    platform: "win32",
  });
  assert.equal(unrestrictedPlan.env.NODE_OPTIONS, "--require=trusted-by-unrestricted-host.cjs");
});

test("Windows 受限环境规范化 PATH 系统键但保留自定义键大小写", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-win-env-case-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  const env = buildSandboxEnvironment(
    { pAtH: "C:\\runtime", pAtHeXt: ".EXE;.CMD", CustomCase: "kept" },
    policy,
    "win32",
    ["CustomCase"],
  );
  assert.equal(env.PATH, "C:\\runtime");
  assert.equal(env.PATHEXT, ".EXE;.CMD");
  assert.equal(env.CustomCase, "kept");
  assert.equal(Object.hasOwn(env, "pAtH"), false);
  assert.equal(Object.hasOwn(env, "pAtHeXt"), false);
});

test("受限模式在原生后端缺失时 fail-closed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  assert.throws(
    () =>
      buildManagedSpawnPlan({
        command: "node",
        args: [],
        cwd: root,
        origin: "bash",
        policy,
        platform: "linux",
        arch: "x64",
        backendExecutable: join(root, "missing-bwrap"),
      }),
    /sandbox_unavailable/u,
  );
});

test("SandboxLease 统一终止进程并在退出后幂等释放", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-lease-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const managed = managedProcessLauncher.launch(
    {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root,
      origin: "bash",
      policy: createSandboxPolicy({
        profile: "danger-full-access",
        workspaceRoots: [root],
        scratchRoot: join(root, "scratch"),
      }),
    },
    { stdio: "ignore" },
  );
  await new Promise<void>((resolve, reject) => {
    managed.child.once("spawn", resolve);
    managed.child.once("error", reject);
  });
  assert.equal(managed.lease.released, false);
  await managed.lease.terminate("SIGKILL");
  assert.equal(managed.lease.released, true);
  await managed.lease.release();
  assert.equal(managed.lease.released, true);
});

test("会话授权提升策略代次并重启 stdio MCP", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-mcp-generation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const clients: Array<{ connects: number; closes: number }> = [];
  const initial = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
    generation: 0,
  });
  const manager = new McpConnectionManager(undefined, {
    processSandbox: initial,
    clientFactory: () => {
      const state = { connects: 0, closes: 0 };
      clients.push(state);
      return {
        toolCancellationScope: "process_tree",
        async connect() {
          state.connects++;
        },
        async listTools() {
          return [{ name: "do", description: "fixture", inputSchema: { type: "object" } }];
        },
        async callTool() {
          return { content: [], isError: false };
        },
        async listResources() {
          return { resources: [] };
        },
        async readResource() {
          return { contents: [] };
        },
        async listPrompts() {
          return { prompts: [] };
        },
        async getPrompt() {
          return { messages: [] };
        },
        async close() {
          state.closes++;
        },
      } satisfies McpClient;
    },
  });
  context.after(() => manager.closeAll());
  await manager.replaceSources([
    {
      id: "test",
      config: {
        mcpServers: {
          local: { name: "local", transport: "stdio", command: "fixture" },
        },
      },
    },
  ]);
  await manager.connectAll();
  await manager.updateProcessSandbox(
    createSandboxPolicy({
      profile: "workspace-write",
      workspaceRoots: [root],
      scratchRoot: join(root, "scratch"),
      generation: 1,
    }),
  );
  assert.equal(clients.length, 2);
  assert.deepEqual(clients, [
    { connects: 1, closes: 1 },
    { connects: 1, closes: 0 },
  ]);
  await manager.restartStdioServerForTool("mcp__local__do");
  assert.deepEqual(clients, [
    { connects: 1, closes: 1 },
    { connects: 1, closes: 1 },
    { connects: 1, closes: 0 },
  ]);
});

test("受限环境只继承系统白名单、恢复显式变量并拒绝加载器注入", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-env-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "workspace-write",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  const env = buildSandboxEnvironment(
    {
      PATH: process.env.PATH,
      LANG: "C",
      PICO_AMBIENT_SECRET_FIXTURE: "not-forwarded",
      PICO_EXPLICIT_FIXTURE: "forwarded",
      NODE_OPTIONS: "--require=untrusted-loader.cjs",
      DYLD_INSERT_LIBRARIES: "/tmp/untrusted-loader.dylib",
      LD_PRELOAD: "/tmp/untrusted-loader.so",
      GLIBC_TUNABLES: "glibc.malloc.check=3",
      GCONV_PATH: "/tmp/untrusted-gconv",
      PYTHONPATH: "/tmp/untrusted-python-modules",
      HOME: "/host/home",
    },
    policy,
    process.platform,
    [
      "PICO_EXPLICIT_FIXTURE",
      "NODE_OPTIONS",
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "GLIBC_TUNABLES",
      "GCONV_PATH",
      "PYTHONPATH",
    ],
  );
  assert.equal(env.LANG, "C");
  assert.equal(env.PICO_EXPLICIT_FIXTURE, "forwarded");
  assert.equal(env.PICO_AMBIENT_SECRET_FIXTURE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.GLIBC_TUNABLES, undefined);
  assert.equal(env.GCONV_PATH, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.notEqual(env.HOME, "/host/home");
  assert.match(env.HOME ?? "", /scratch[/\\]home$/u);
  assert.match(env.TMPDIR ?? "", /scratch[/\\]tmp$/u);
  assert.match(env.XDG_CACHE_HOME ?? "", /scratch[/\\]cache$/u);
});

test("danger-full-access 保留完整宿主环境且不应用受限显式键规则", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-env-yolo-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const policy = createSandboxPolicy({
    profile: "danger-full-access",
    workspaceRoots: [root],
    scratchRoot: join(root, "scratch"),
  });
  const base = {
    PATH: process.env.PATH,
    PICO_AMBIENT_FIXTURE: "preserved",
    NODE_OPTIONS: "--require=trusted-by-unrestricted-host.cjs",
    HOME: "/host/home",
  };
  assert.deepEqual(buildSandboxEnvironment(base, policy, process.platform, []), base);
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
  const canonicalRoot = policy.readRoots.find((candidate) => candidate.endsWith(basename(root)));
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
  const unshareUser = args.indexOf("--unshare-user");
  const disableUserns = args.indexOf("--disable-userns");
  assert.ok(unshareUser >= 0, "--disable-userns requires an explicit --unshare-user");
  assert.ok(disableUserns > unshareUser);
  assert.ok(args.includes("--share-net"));
  for (const root of ["/bin", "/sbin", "/lib", "/lib64"]) {
    assert.ok(
      args.some(
        (value, index) =>
          value === "--ro-bind-try" && args[index + 1] === root && args[index + 2] === root,
      ),
      `missing lexical runtime root ${root}`,
    );
  }
  assert.deepEqual(args.slice(-4), ["--", "/bin/sh", "-c", "true"]);
  assert.ok(
    args.some(
      (value, index) => value === "--bind" && policy.writeRoots.includes(args[index + 1] ?? ""),
    ),
  );
});

test("静态写路径允许伪设备但仍拒绝普通工作区外路径", () => {
  const workspace = process.cwd();
  assert.equal(evaluateSandboxCommand("ls 2>/dev/null", workspace, [workspace]).allowed, true);
  assert.equal(evaluateSandboxCommand("printf ok >/dev/tty", workspace, [workspace]).allowed, true);
  assert.equal(evaluateSandboxCommand("echo ok > NUL", workspace, [workspace]).allowed, true);
  assert.equal(
    evaluateSandboxCommand("echo blocked > /etc/pico", workspace, [workspace]).allowed,
    false,
  );
});

test("模型命令文本不能把任意绝对可执行路径提升为运行时读根", () => {
  const outside = join(tmpdir(), "pico-sensitive", "not-a-command");
  const roots = shellRuntimeReadRoots(
    `${outside}; cat ${join(tmpdir(), "pico-sensitive/secret")}`,
    {
      PATH: process.env.PATH,
    },
  );
  assert.equal(
    roots.some((root) => root.includes("pico-sensitive")),
    false,
  );
});

test(
  "Homebrew formula alias 指向其他 Cellar 根时不授权",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-homebrew-alias-mismatch-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const formulaRoot = join(root, "Cellar", "fixture", "1.0.0");
    const otherFormulaRoot = join(root, "Cellar", "other", "1.0.0");
    const alias = join(root, "opt", "fixture");
    await mkdir(formulaRoot, { recursive: true });
    await mkdir(otherFormulaRoot, { recursive: true });
    await mkdir(join(root, "opt"), { recursive: true });
    await symlink(otherFormulaRoot, alias);

    const aliases = runtimeReadAliases("/bin/sh", { PATH: "/usr/bin:/bin" }, "darwin", [
      formulaRoot,
    ]);
    assert.equal(aliases.includes(alias), false);
  },
);

test(
  "BashTool 允许 /dev/null 重定向且不接受伪绝对命令的读根提升",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-bash-sandbox-authority-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "READ_ROOT_ESCAPE_CONFIRMED", "utf8");
    const roots = await WorkspaceRoots.create(workspace);
    const bash = new BashTool(workspace, undefined, {
      sandbox: {
        workspaceRoots: roots,
        profile: "workspace-write",
        scratchRoot: join(root, "scratch"),
      },
    });
    assert.equal(
      await bash.execute(JSON.stringify({ command: "ls 2>/dev/null" })),
      "命令执行成功,无终端输出。",
    );
    await assert.rejects(
      bash.execute(
        JSON.stringify({
          command: `${join(outside, "not-a-command")}; /bin/cat ${join(outside, "secret")}`,
        }),
      ),
      /sandbox_runtime_denied/u,
    );
  },
);

test("打包原生后端必须通过同目录 SHA-256 校验", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-process-sandbox-resource-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "helper");
  await writeFile(executable, "trusted", "utf8");
  await chmod(executable, 0o755);
  const digest = createHash("sha256").update("trusted").digest("hex");
  await writeFile(`${executable}.sha256`, `${digest}  helper\n`, "utf8");
  assert.equal(isVerifiedBundledExecutable(executable), true);
  if (process.platform !== "win32") {
    await chmod(executable, 0o644);
    assert.equal(isVerifiedBundledExecutable(executable, "linux"), false);
    await chmod(executable, 0o755);
  }
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
    const result = spawnSync(plan.command, plan.args, {
      cwd: workspace,
      env: plan.env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "allowed");
    assert.doesNotMatch(result.stdout, /secret/u);
  },
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
