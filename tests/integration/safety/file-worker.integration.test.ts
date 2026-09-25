import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, symlinkSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { RepoMapService } from "@pico/pico-host/code-intelligence";
import {
  detectSandboxBackend,
  createSandboxPolicy,
  managedProcessLauncher,
  SandboxViolationError,
} from "@pico/pico-host/process-sandbox";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import { FileWorkerTool } from "../../../packages/pico-host/src/file-worker-tool.js";
import { WorkspaceRoots as SourceWorkspaceRoots } from "../../../packages/pico-host/src/workspace-roots.js";
import { ExploreRepoTool } from "@pico/pico-host/explore-repo-tool";

const nativeAvailable = detectSandboxBackend() !== "unavailable";

test("prebound File Worker roots accept only the Host-bound lexical target", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-worker-prebound-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const allowed = join(workspace, "allowed.txt");
  const roots = WorkspaceRoots.createPreboundFileWorker(workspace);
  roots.replaceBoundaryEntries([{ path: allowed, access: "read", scope: "exact" }]);
  assert.equal(await roots.assertAllowed("allowed.txt"), allowed);
  await assert.rejects(roots.assertAllowed("sibling.txt"), /路径越界/u);
  await assert.rejects(roots.assertAllowed("../outside.txt"), /路径越界/u);
  await assert.rejects(roots.assertAllowed("ALLOWED.TXT"), /路径越界/u);
});

test("native file-worker process reads only its target and cannot connect to loopback", async (context) => {
  assert.equal(nativeAvailable, true, "本机缺少 File Worker 系统沙箱后端");
  const root = await mkdtemp(join(tmpdir(), "pico-file-worker-native-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const scratchRoot = join(root, "scratch");
  await mkdir(workspace);
  await mkdir(scratchRoot);
  const allowed = join(workspace, "allowed.txt");
  const sibling = join(workspace, "sibling.txt");
  await writeFile(allowed, "allowed-secret");
  await writeFile(sibling, "sibling-secret");
  const server = createServer((socket) => socket.end("network-open"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    `if (fs.readFileSync(${JSON.stringify(allowed)}, "utf8") !== "allowed-secret") process.exit(10);`,
    `try { fs.readFileSync(${JSON.stringify(sibling)}, "utf8"); process.exit(11); } catch {}`,
    `const socket = net.connect(${address.port}, "127.0.0.1");`,
    "socket.setTimeout(1500, () => { socket.destroy(); process.exit(0); });",
    "socket.on('data', () => process.exit(12));",
    "socket.on('error', () => process.exit(0));",
  ].join("\n");
  const policy = createSandboxPolicy({
    profile: "read-only",
    workspaceRoots: [],
    scratchRoot,
    readFiles: [allowed],
    config: { network: "deny" },
  });
  const { child, lease } = managedProcessLauncher.launch(
    {
      command: process.execPath,
      args: ["-e", script],
      cwd: workspace,
      origin: "file-worker",
      policy,
    },
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  let timer: NodeJS.Timeout | undefined;
  try {
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`File Worker 原生隔离探针超时: ${stderr}`)),
          10_000,
        );
      }),
    ]);
    assert.equal(exitCode, 0, stderr);
  } finally {
    clearTimeout(timer);
    await lease.terminate().catch(() => undefined);
  }
});

test("standalone packaged File Worker runs with an exact file grant", async (context) => {
  assert.equal(nativeAvailable, true, "本机缺少 File Worker 系统沙箱后端");
  const bundle = fileURLToPath(
    new URL("../../../resources/file-worker/file-worker.mjs", import.meta.url),
  );
  assert.equal(existsSync(bundle), true, "请先运行 npm run build:file-worker");
  const root = await mkdtemp(join(tmpdir(), "pico-file-worker-bundle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const scratchRoot = join(root, "scratch");
  await mkdir(workspace);
  await mkdir(scratchRoot);
  const allowed = join(workspace, "allowed.txt");
  await writeFile(allowed, "bundle-readable");
  const canonicalWorkspace = await realpath(workspace);
  const targetPath = WorkspaceRoots.createSync(workspace).resolveUnchecked("allowed.txt");
  const info = await lstat(allowed, { bigint: true });
  const workDirInfo = await lstat(canonicalWorkspace, { bigint: true });
  const operationId = randomUUID();
  const executable = process.env.PICO_FILE_WORKER_TEST_EXECUTABLE ?? process.execPath;
  const executableRoot =
    executable === process.execPath
      ? undefined
      : process.platform === "darwin"
        ? dirname(dirname(dirname(executable)))
        : dirname(executable);
  const policy = createSandboxPolicy({
    profile: "read-only",
    workspaceRoots: [],
    scratchRoot,
    readRoots: [dirname(bundle), ...(executableRoot ? [executableRoot] : [])],
    readFiles: [targetPath],
    config: { network: "deny" },
  });
  const { child, lease, plan } = managedProcessLauncher.launch(
    {
      command: executable,
      args: [bundle],
      cwd: canonicalWorkspace,
      origin: "file-worker",
      policy,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      explicitEnvKeys: ["ELECTRON_RUN_AS_NODE"],
    },
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const request = {
    operationId,
    boundaryRevision: 1,
    operation: "read_file",
    args: JSON.stringify({ path: "allowed.txt" }),
    workDir: canonicalWorkspace,
    workDirIdentity: {
      kind: "directory",
      dev: String(workDirInfo.dev),
      ino: String(workDirInfo.ino),
      size: String(workDirInfo.size),
      mtimeNs: String(workDirInfo.mtimeNs),
      ctimeNs: String(workDirInfo.ctimeNs),
    },
    ...(process.platform === "linux" ? { syntheticCwd: true } : {}),
    stagePath: join(scratchRoot, "prepared"),
    targets: [
      {
        path: targetPath,
        identity: {
          kind: "file",
          dev: String(info.dev),
          ino: String(info.ino),
          size: String(info.size),
          mtimeNs: String(info.mtimeNs),
          ctimeNs: String(info.ctimeNs),
        },
      },
    ],
    excludeSensitiveFiles: false,
  };
  child.stdin?.end(`${JSON.stringify(request)}\n`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const exitCode = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`独立 File Worker bundle 超时: ${stderr}`)),
          10_000,
        );
      }),
    ]);
    assert.equal(exitCode, 0, stderr);
    const response = JSON.parse(stdout.trim()) as { ok: boolean; result: string; error?: string };
    assert.equal(response.ok, true, response.error ?? stderr);
    assert.match(response.result, /bundle-readable/u);
  } finally {
    clearTimeout(timer);
    await lease.terminate().catch(() => undefined);
  }
});

test(
  "managed file tools use a network-denied, target-scoped worker and preserve output",
  {
    skip: !nativeAvailable,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-file-worker-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(join(workspace, "nested"));
    const roots = WorkspaceRoots.createSync(workspace);
    const originalLaunch = managedProcessLauncher.launch.bind(managedProcessLauncher);
    const policies: Array<{
      network: string;
      readFiles?: readonly string[];
      writeRoots: readonly string[];
    }> = [];
    const workerArgs: string[][] = [];
    context.mock.method(
      managedProcessLauncher,
      "launch",
      (
        request: Parameters<typeof managedProcessLauncher.launch>[0],
        options: Parameters<typeof managedProcessLauncher.launch>[1],
      ) => {
        if (request.origin === "file-worker") {
          policies.push(request.policy);
          workerArgs.push([...request.args]);
        }
        return originalLaunch(request, options);
      },
    );
    const registry = buildDefaultToolRegistry(workspace, {
      workspaceRoots: roots,
      processSandbox: { profile: "workspace-write", generation: 1 },
    });
    const run = (name: string, input: Record<string, unknown>) => {
      const tool = registry.getTool(name);
      assert.ok(tool, name);
      return tool.execute(JSON.stringify(input));
    };
    assert.match(
      await run("write_file", { path: "nested/example.txt", content: "alpha\n" }),
      /新建文件/u,
    );
    assert.match(await run("read_file", { path: "nested/example.txt" }), /alpha/u);
    assert.match(
      await run("edit_file", { path: "nested/example.txt", old_text: "alpha", new_text: "beta" }),
      /成功修改/u,
    );
    assert.equal(await readFile(join(workspace, "nested/example.txt"), "utf8"), "beta\n");
    assert.match(await run("glob", { path: "nested", pattern: "*.txt" }), /example\.txt/u);
    assert.match(await run("grep", { path: "nested", pattern: "beta" }), /beta/u);
    await writeFile(join(workspace, "source.ts"), "export const beta = 1;\n");
    const explore = new FileWorkerTool(new ExploreRepoTool(workspace, undefined), {
      roots: SourceWorkspaceRoots.createSync(workspace),
      workDir: workspace,
      resolveSandbox: () => ({ profile: "read-only", generation: 1 }),
    });
    assert.match(
      await explore.execute(
        JSON.stringify({ objective: "find beta in repository", queries: ["beta"] }),
      ),
      /source\.ts/u,
    );
    assert.equal(policies.length, 5);
    if (process.platform === "win32") {
      assert.ok(
        workerArgs.every((args) => args.length === 1 && args[0]?.endsWith("file-worker.mjs")),
        "Windows 受限 File Worker 必须直接启动已构建 bundle",
      );
    }
    assert.ok(policies.every((policy) => policy.network === "deny"));
    assert.ok(policies.every((policy) => !policy.writeRoots.includes(workspace)));
    assert.ok(
      policies.some((policy) =>
        policy.readFiles?.includes(roots.resolveUnchecked("nested/example.txt")),
      ),
    );
  },
);

test(
  "managed worker rejects out-of-root exploration and a swapped parent before commit",
  {
    skip: !nativeAvailable,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-file-worker-race-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const external = join(root, "external");
    await mkdir(workspace);
    await mkdir(external);
    await mkdir(join(workspace, "swapped", "sub"), { recursive: true });
    const roots = WorkspaceRoots.createSync(workspace);
    const explore = new FileWorkerTool(new ExploreRepoTool(workspace, undefined), {
      roots: SourceWorkspaceRoots.createSync(workspace),
      workDir: workspace,
      resolveSandbox: () => ({ profile: "read-only", generation: 1 }),
    });
    await assert.rejects(
      explore.execute(JSON.stringify({ objective: "find local files", roots: ["../external"] })),
      /路径越界/u,
    );

    let calls = 0;
    const registry = buildDefaultToolRegistry(workspace, {
      workspaceRoots: roots,
      processSandbox: {
        profile: "workspace-write",
        generation: 1,
        resolveSandbox: () => {
          calls++;
          if (calls === 2) {
            renameSync(join(workspace, "swapped"), join(workspace, "swapped-original"));
            symlinkSync(external, join(workspace, "swapped"), "dir");
          }
          return { profile: "workspace-write", generation: 1 };
        },
      },
    });
    const write = registry.getTool("write_file");
    assert.ok(write);
    await assert.rejects(
      write.execute(JSON.stringify({ path: "swapped/sub/file.txt", content: "no escape" })),
      /目标真实路径发生变化|目标身份已变化|写入过程中目标路径已改变/u,
    );
    assert.equal(existsSync(join(external, "sub")), false);
    assert.equal(existsSync(join(external, "sub/file.txt")), false);
  },
);

test("managed write fails closed when the File Worker cannot launch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-worker-unavailable-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const registry = buildDefaultToolRegistry(workspace, {
    workspaceRoots: WorkspaceRoots.createSync(workspace),
    processSandbox: { profile: "workspace-write", generation: 1 },
  });
  context.mock.method(managedProcessLauncher, "launch", () => {
    throw new SandboxViolationError("sandbox_unavailable", "测试中没有 File Worker 后端");
  });
  const write = registry.getTool("write_file");
  assert.ok(write);
  await assert.rejects(
    write.execute(JSON.stringify({ path: "x.txt", content: "secret" })),
    /sandbox_unavailable/u,
  );
  assert.equal(existsSync(join(workspace, "x.txt")), false);
});

test(
  "managed write refuses a missing parent without creating directories",
  {
    skip: !nativeAvailable,
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-file-worker-parent-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const registry = buildDefaultToolRegistry(workspace, {
      workspaceRoots: WorkspaceRoots.createSync(workspace),
      processSandbox: { profile: "workspace-write", generation: 1 },
    });
    const write = registry.getTool("write_file");
    assert.ok(write);
    await assert.rejects(
      write.execute(JSON.stringify({ path: "missing/sub/file.txt", content: "no escape" })),
      /父目录已存在/u,
    );
    assert.equal(existsSync(join(workspace, "missing")), false);
  },
);

test("managed worker refuses mutable runtime code inside the task workspace", async () => {
  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const registry = buildDefaultToolRegistry(projectRoot, {
    workspaceRoots: WorkspaceRoots.createSync(projectRoot),
    processSandbox: { profile: "workspace-write", generation: 1 },
  });
  const read = registry.getTool("read_file");
  assert.ok(read);
  await assert.rejects(
    read.execute(JSON.stringify({ path: "package.json" })),
    /受信代码或运行时与模型可写工作区重叠/u,
  );
});

test("managed mode closes unprepared host-side code and skill reads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-worker-host-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const registry = buildDefaultToolRegistry(workspace, {
    workspaceRoots: WorkspaceRoots.createSync(workspace),
    processSandbox: { profile: "workspace-write", generation: 1 },
    codeIntelligence: new RepoMapService(workspace),
  });
  for (const name of ["repo_map", "code_definition"]) {
    const tool = registry.getTool(name);
    assert.ok(tool, name);
    await assert.rejects(tool.execute("{}"), /仍需宿主直接读取工作区/u);
  }
  const skill = registry.getTool("skill_view");
  assert.ok(skill);
  await assert.rejects(skill.execute('{"name":"unprepared"}'), /技能目录尚未建立/u);
});
