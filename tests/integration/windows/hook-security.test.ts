import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  sanitizeCommandHookEnvironment,
  resolveHookShell,
} from "../../../src/hooks/config/command-shell.js";
import {
  DefaultHookExecutor,
  type HookHandlerExecutorOptions,
} from "../../../src/hooks/executors/executor.js";
import { HookTrustStore } from "../../../src/hooks/trust/store.js";
import type { CommandHookHandler, HookOutput } from "../../../src/hooks/types.js";
import { createSandboxPolicy } from "../../../src/safety/process-sandbox/index.js";

const WINDOWS_ONLY =
  process.platform === "win32" ? false : "requires Windows executable and process-tree semantics";

test(
  "Windows command Hooks execute .exe entries and accept shell-owned extensions (.cmd)",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "direct-exe");
    const entryPath = join(fixture.workspace, "entry.cjs");
    await writeFile(
      entryPath,
      'process.stdout.write(JSON.stringify({ additionalContext: "windows-exe" }));\n',
    );
    const handler = {
      type: "command",
      command: process.execPath,
      args: ["./entry.cjs"],
    } as const satisfies CommandHookHandler;

    const executor = createHookExecutor(fixture);
    context.after(async () => await executor.dispose());
    const output = await executeStopHook(executor, fixture, handler, "windows-direct-exe");
    assert.equal(output.additionalContext, "windows-exe", JSON.stringify(output));

    // 受限 Windows Hook 固定由 PowerShell 解释，shell-owned .cmd 仍可显式调用。
    const cmdPath = join(fixture.workspace, "greet.cmd");
    await writeFile(cmdPath, '@echo {"additionalContext":"windows-cmd"}\r\n');
    const cmdHandler = {
      type: "command",
      command: `& "${cmdPath}"`,
    } as const satisfies CommandHookHandler;
    const cmdOutput = await executeStopHook(executor, fixture, cmdHandler, "windows-cmd");
    assert.equal(cmdOutput.additionalContext, "windows-cmd", JSON.stringify(cmdOutput));
  },
);

test(
  "Windows restricted command Hooks use AppContainer-compatible PowerShell",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "restricted-powershell");
    const handler = {
      type: "command",
      command: `Write-Output '{"additionalContext":"restricted-powershell"}'`,
    } as const satisfies CommandHookHandler;
    const trustStore = new HookTrustStore({
      picoHome: join(fixture.root, "pico-home"),
      env: process.env,
    });
    await trustStore.trust({ workspace: fixture.workspace, source: fixture.source, handler });
    const executor = createHookExecutor(
      fixture,
      process.env,
      "workspace-write",
      async (entry, shell) =>
        await trustStore.authorizeCommandExecution(
          { workspace: fixture.workspace, source: entry.source, handler: entry.handler },
          shell,
        ),
    );
    context.after(async () => await executor.dispose());

    const output = await executeStopHook(
      executor,
      fixture,
      handler,
      "windows-restricted-powershell",
    );
    assert.equal(output.additionalContext, "restricted-powershell", JSON.stringify(output));

    const denyHandler = {
      type: "command",
      command: `Write-Output '{"decision":"deny","reason":"restricted-deny"}'`,
    } as const satisfies CommandHookHandler;
    await trustStore.trust({
      workspace: fixture.workspace,
      source: fixture.source,
      handler: denyHandler,
    });
    const denied = await executeStopHook(
      executor,
      fixture,
      denyHandler,
      "windows-restricted-powershell-deny",
    );
    assert.deepEqual(denied, { decision: "deny", reason: "restricted-deny" });
  },
);

test(
  "Windows danger-full-access command Hooks retain Git Bash preference",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "danger-git-bash");
    assert.equal(resolveHookShell().kind, "bash", "Windows CI host must provide Git Bash");
    const executor = createHookExecutor(fixture, process.env, "danger-full-access");
    context.after(async () => await executor.dispose());

    const output = await executeStopHook(
      executor,
      fixture,
      {
        type: "command",
        command: `printf '%s' '{"additionalContext":"danger-git-bash"}'`,
      },
      "windows-danger-git-bash",
    );
    assert.equal(output.additionalContext, "danger-git-bash", JSON.stringify(output));
  },
);

test(
  "Windows resolves bare command names through the shell at runtime (mixed-case Path keys)",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "mixed-case-path");
    const entryPath = join(fixture.workspace, "entry.cjs");
    await writeFile(
      entryPath,
      "process.stdout.write(JSON.stringify({ additionalContext: `${process.env.pAtH ?? process.env.PATH}` }));\n",
    );
    const environment = withoutExecutionPath(process.env);
    environment.pAtH = `${join(process.execPath, "..")};${environment.pAtH ?? ""}`;
    // PowerShell 解析裸命令名依赖 PATHEXT（真实 Windows 恒有；测试受控环境需显式补回）。
    environment.pAtHeXt = ".CMD;.EXE";
    const handler = {
      type: "command",
      command: basename(process.execPath, extname(process.execPath)),
      args: ["./entry.cjs"],
    } as const satisfies CommandHookHandler;

    // handler.env 覆盖 PATH 放行（shell 化语义：配置即用户意图）。
    const overridden = sanitizeCommandHookEnvironment(
      { type: "command", command: "node", args: [], env: { PATH: "custom" } },
      environment,
    );
    assert.equal(overridden.PATH, "custom");

    const executor = createHookExecutor(fixture, environment);
    context.after(async () => await executor.dispose());
    const output = await executeStopHook(executor, fixture, handler, "windows-mixed-case-path");
    // 子进程看到的 PATH 就是受控环境的 pAtH 值（nodeDir 前缀 + 尾随分号）。
    assert.equal(output.additionalContext, `${join(process.execPath, "..")};`);
  },
);

test(
  "Windows Node Hooks accept literal tildes in absolute code paths",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "absolute-tilde");
    const entryDirectory = join(fixture.workspace, "RUNNER~1");
    const entryPath = join(entryDirectory, "entry.cjs");
    await mkdir(entryDirectory);
    await writeFile(
      entryPath,
      'process.stdout.write(JSON.stringify({ additionalContext: "absolute-tilde" }));\n',
    );
    const handler = {
      type: "command",
      command: process.execPath,
      args: [entryPath],
    } as const satisfies CommandHookHandler;

    const executor = createHookExecutor(fixture);
    context.after(async () => await executor.dispose());
    const output = await executeStopHook(executor, fixture, handler, "windows-absolute-tilde");
    assert.equal(output.additionalContext, "absolute-tilde", JSON.stringify(output));
  },
);

test(
  "Windows sandbox broker resolves ACL control tools from trusted System32",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "trusted-icacls");
    const entryPath = join(fixture.workspace, "entry.cjs");
    await writeFile(
      entryPath,
      'process.stdout.write(JSON.stringify({ additionalContext: "trusted-icacls" }));\n',
    );
    // A bare Command::new("icacls.exe") can resolve from the broker cwd before System32.
    // A renamed Node executable is enough to make that unsafe lookup fail deterministically.
    await copyFile(process.execPath, join(fixture.workspace, "icacls.exe"));
    const handler = {
      type: "command",
      command: process.execPath,
      args: [entryPath],
    } as const satisfies CommandHookHandler;
    const executor = createHookExecutor(fixture);
    context.after(async () => await executor.dispose());

    const output = await executeStopHook(executor, fixture, handler, "windows-trusted-icacls");
    assert.equal(output.additionalContext, "trusted-icacls", JSON.stringify(output));
  },
);

test(
  "Windows command timeout waits until the entire child process tree is terminated",
  { skip: WINDOWS_ONLY, timeout: 30_000 },
  async (context) => {
    const processFixture = await createProcessTreeFixture(context, "timeout", 8_000);
    const started = Date.now();
    const execution = executeStopHook(
      processFixture.executor,
      processFixture.fixture,
      processFixture.handler,
      "windows-process-tree-timeout",
    );

    const tree = await waitForProcessTree(
      processFixture.treePath,
      processFixture.heartbeatPath,
      execution,
    );
    const output = await execution;

    assert.equal(output.decision, "allow");
    assert.ok(
      output.diagnostics?.some((diagnostic) => /timeout|timed out/iu.test(diagnostic.message)),
    );
    assert.ok(Date.now() - started < 15_000, "executor did not honor the taskkill barrier");
    assert.equal(isProcessRunning(tree.parent), false);
    assert.equal(isProcessRunning(tree.child), false);
  },
);

test(
  "Windows command Hooks accept valid output when the child closes stdin early",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "stdin-closed");
    const entryPath = join(fixture.workspace, "close-stdin.cjs");
    await writeFile(
      entryPath,
      [
        'const fs = require("node:fs");',
        "fs.closeSync(0);",
        'process.stdout.write(JSON.stringify({ additionalContext: "stdin-closed" }));',
        "setTimeout(() => undefined, 100);",
        "",
      ].join("\n"),
    );
    const handler = {
      type: "command",
      command: process.execPath,
      args: ["./close-stdin.cjs"],
    } as const satisfies CommandHookHandler;
    const executor = createHookExecutor(fixture);
    context.after(async () => await executor.dispose());

    const output = await executor.execute(
      {
        id: "windows-stdin-closed",
        event: "Stop",
        source: fixture.source,
        order: 0,
        handler,
        trusted: true,
      },
      {
        session_id: "windows-stdin-closed",
        cwd: fixture.workspace,
        hook_event_name: "Stop",
        payload: { reason: "x".repeat(2 * 1024 * 1024) },
      },
      {},
    );

    assert.equal(output.additionalContext, "stdin-closed", JSON.stringify(output));
  },
);

test(
  "Windows command cancellation waits until the entire child process tree is terminated",
  { skip: WINDOWS_ONLY, timeout: 20_000 },
  async (context) => {
    const processFixture = await createProcessTreeFixture(context, "cancellation", 30_000);
    const controller = new AbortController();
    const execution = executeStopHook(
      processFixture.executor,
      processFixture.fixture,
      processFixture.handler,
      "windows-process-tree-cancellation",
      controller.signal,
    );

    const tree = await waitForProcessTree(
      processFixture.treePath,
      processFixture.heartbeatPath,
      execution,
    );
    assert.equal(isProcessRunning(tree.parent), true);
    assert.equal(isProcessRunning(tree.child), true);

    const abortStarted = Date.now();
    controller.abort(new Error("windows-hook-cancelled"));
    await assert.rejects(execution, /windows-hook-cancelled/u);

    assert.ok(Date.now() - abortStarted < 5_000, "executor did not honor the taskkill barrier");
    assert.equal(isProcessRunning(tree.parent), false);
    assert.equal(isProcessRunning(tree.child), false);
  },
);

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly source: {
    readonly kind: "project";
    readonly path: string;
    readonly version: number;
  };
}

interface ProcessTree {
  readonly parent: number;
  readonly child: number;
}

interface ProcessTreeFixture {
  readonly fixture: Fixture;
  readonly executor: DefaultHookExecutor;
  readonly handler: CommandHookHandler;
  readonly treePath: string;
  readonly heartbeatPath: string;
}

async function createFixture(context: TestContext, label: string): Promise<Fixture> {
  const fixture = await createFixtureRoot(label);
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  return fixture;
}

async function createFixtureRoot(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-windows-hook-${label}-`));
  const workspace = join(root, "workspace");
  const sourcePath = join(workspace, ".pico", "hooks.json");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await writeFile(sourcePath, "{}\n");
  return {
    root,
    workspace,
    source: {
      kind: "project",
      path: sourcePath,
      version: 1,
    },
  };
}

async function createProcessTreeFixture(
  context: TestContext,
  label: string,
  timeoutMs: number,
): Promise<ProcessTreeFixture> {
  const fixture = await createFixtureRoot(label);
  const parentPath = join(fixture.workspace, "parent.cjs");
  const descendantPath = join(fixture.workspace, "descendant.cjs");
  const treePath = join(fixture.workspace, "tree.json");
  const heartbeatPath = join(fixture.workspace, "descendant-heartbeat.txt");
  const executor = createHookExecutor(fixture);
  context.after(async () => {
    try {
      const tree = await readProcessTree(treePath);
      if (tree && isProcessRunning(tree.parent)) terminateProcessTree(tree.parent);
      if (tree && isProcessRunning(tree.child)) terminateProcessTree(tree.child);
    } finally {
      await executor.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await writeFile(
    parentPath,
    [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const [descendantPath, treePath, heartbeatPath] = process.argv.slice(2);",
      "const descendant = spawn(process.execPath, [descendantPath, heartbeatPath], {",
      '  stdio: "ignore",',
      "  windowsHide: true,",
      "});",
      'if (descendant.pid === undefined) throw new Error("descendant pid unavailable");',
      "writeFileSync(treePath, JSON.stringify({ parent: process.pid, child: descendant.pid }));",
      "setTimeout(() => process.exit(3), 60_000);",
      "",
    ].join("\n"),
  );
  await writeFile(
    descendantPath,
    [
      'const { appendFileSync } = require("node:fs");',
      "const heartbeatPath = process.argv[2];",
      'appendFileSync(heartbeatPath, "started\\n");',
      'setInterval(() => appendFileSync(heartbeatPath, "tick\\n"), 50);',
      "setTimeout(() => process.exit(3), 60_000);",
      "",
    ].join("\n"),
  );
  const handler = {
    type: "command",
    command: process.execPath,
    args: [parentPath, descendantPath, treePath, heartbeatPath],
    timeoutMs,
  } as const satisfies CommandHookHandler;
  return { fixture, executor, handler, treePath, heartbeatPath };
}

function createHookExecutor(
  fixture: Fixture,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  profile: "workspace-write" | "danger-full-access" = "workspace-write",
  authorizeCommandExecution?: HookHandlerExecutorOptions["authorizeCommandExecution"],
): DefaultHookExecutor {
  return new DefaultHookExecutor({
    workDir: fixture.workspace,
    env,
    ...(authorizeCommandExecution ? { authorizeCommandExecution } : {}),
    processSandbox: createSandboxPolicy({
      profile,
      workspaceRoots: [fixture.workspace],
      scratchRoot: join(fixture.root, "sandbox-scratch"),
    }),
  });
}

function withoutExecutionPath(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name.toUpperCase() !== "PATH" && name.toUpperCase() !== "PATHEXT",
    ),
  );
}

async function executeStopHook(
  executor: DefaultHookExecutor,
  fixture: Fixture,
  handler: CommandHookHandler,
  id: string,
  signal?: AbortSignal,
) {
  return await executor.execute(
    {
      id,
      event: "Stop",
      source: fixture.source,
      order: 0,
      handler,
      trusted: true,
    },
    {
      session_id: id,
      cwd: fixture.workspace,
      hook_event_name: "Stop",
      payload: { reason: "test" },
    },
    signal ? { signal } : {},
  );
}

async function waitForProcessTree(
  treePath: string,
  heartbeatPath: string,
  execution: Promise<HookOutput>,
): Promise<ProcessTree> {
  let completion:
    | { readonly status: "fulfilled"; readonly output: HookOutput }
    | { readonly status: "rejected"; readonly reason: unknown }
    | undefined;
  void execution.then(
    (output) => {
      completion = { status: "fulfilled", output };
    },
    (reason: unknown) => {
      completion = { status: "rejected", reason };
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tree = await readProcessTree(treePath);
    const heartbeatExists = await exists(heartbeatPath);
    if (tree && heartbeatExists) return tree;
    const completed = completion;
    if (completed?.status === "fulfilled") {
      throw new Error(
        `Windows Hook completed before process tree became ready (tree=${String(Boolean(tree))}, heartbeat=${String(heartbeatExists)}): ${JSON.stringify(completed.output)}`,
      );
    }
    if (completed?.status === "rejected") {
      throw completed.reason instanceof Error
        ? completed.reason
        : new Error(
            `Windows Hook rejected before process tree became ready: ${String(completed.reason)}`,
          );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Windows Hook process tree did not become ready within 5000ms (tree=${String(Boolean(await readProcessTree(treePath)))}, heartbeat=${String(await exists(heartbeatPath))})`,
  );
}

async function readProcessTree(path: string): Promise<ProcessTree | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProcessTree>;
    if (Number.isInteger(parsed.parent) && Number.isInteger(parsed.child)) {
      return { parent: parsed.parent!, child: parsed.child! };
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

function isProcessRunning(pid: number): boolean {
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`tasklist failed with exit code ${String(result.status)}`);
  return result.stdout.includes(`"${pid}"`);
}

function terminateProcessTree(pid: number): void {
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
