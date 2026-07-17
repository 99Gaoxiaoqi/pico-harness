import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  resolveCommandHookExecution,
  sanitizeCommandHookEnvironment,
} from "../../../src/hooks/config/referenced-scripts.js";
import { DefaultHookExecutor } from "../../../src/hooks/executors/executor.js";
import type { CommandHookHandler } from "../../../src/hooks/types.js";

const WINDOWS_ONLY =
  process.platform === "win32" ? false : "requires Windows executable and process-tree semantics";

test(
  "Windows command Hooks execute direct .exe entries and reject shell-owned extensions",
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

    const invocation = await resolveCommandHookExecution(handler, fixture.workspace);
    assert.match(invocation.command, /\.exe$/iu);

    const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
    context.after(async () => await executor.dispose());
    const output = await executeStopHook(executor, fixture, handler, "windows-direct-exe");
    assert.equal(output.additionalContext, "windows-exe");

    const blockedCommand = join(fixture.workspace, "blocked.cmd");
    await writeFile(blockedCommand, "@exit /b 0\r\n");
    await assert.rejects(
      resolveCommandHookExecution(
        { type: "command", command: blockedCommand, args: [] },
        fixture.workspace,
      ),
      /Windows command Hook 仅允许.*\.exe/u,
    );
  },
);

test(
  "Windows resolves and spawns bare .exe commands with mixed-case Path and PathExt keys",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "mixed-case-path");
    const entryPath = join(fixture.workspace, "entry.cjs");
    await writeFile(
      entryPath,
      "process.stdout.write(JSON.stringify({ additionalContext: `${process.env.PATH}|${process.env.PATHEXT}` }));\n",
    );
    const environment = withoutExecutionPath(process.env);
    environment.pAtH = dirname(process.execPath);
    environment.pAtHeXt = ".CMD;.EXE";
    const handler = {
      type: "command",
      command: basename(process.execPath, extname(process.execPath)),
      args: ["./entry.cjs"],
    } as const satisfies CommandHookHandler;

    const invocation = await resolveCommandHookExecution(handler, fixture.workspace, environment);
    assert.match(invocation.command, /\.exe$/iu);
    assert.equal(await realpath(invocation.command), await realpath(process.execPath));
    assert.equal(invocation.env.pAtH, environment.pAtH);
    assert.equal(invocation.env.pAtHeXt, environment.pAtHeXt);

    for (const name of ["path", "PaThExT"] as const) {
      assert.throws(
        () =>
          sanitizeCommandHookEnvironment(
            { type: "command", command: process.execPath, args: [], env: { [name]: "injected" } },
            environment,
          ),
        new RegExp(`不允许覆盖 ${name}`, "u"),
      );
    }

    const executor = new DefaultHookExecutor({ workDir: fixture.workspace, env: environment });
    context.after(async () => await executor.dispose());
    const output = await executeStopHook(executor, fixture, handler, "windows-mixed-case-path");
    assert.equal(output.additionalContext, `${environment.pAtH}|${environment.pAtHeXt}`);
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

    const tree = await waitForProcessTree(processFixture.treePath, processFixture.heartbeatPath);
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
    const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
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
        payload: { content: "x".repeat(2 * 1024 * 1024) },
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

    const tree = await waitForProcessTree(processFixture.treePath, processFixture.heartbeatPath);
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
  await mkdir(join(workspace, ".pico"), { recursive: true });
  return {
    root,
    workspace,
    source: {
      kind: "project",
      path: join(workspace, ".pico", "hooks.json"),
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
  const treePath = join(fixture.root, "tree.json");
  const heartbeatPath = join(fixture.root, "descendant-heartbeat.txt");
  const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
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

async function waitForProcessTree(treePath: string, heartbeatPath: string): Promise<ProcessTree> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tree = await readProcessTree(treePath);
    if (tree && (await exists(heartbeatPath))) return tree;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Windows Hook process tree did not become ready within 5000ms");
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
