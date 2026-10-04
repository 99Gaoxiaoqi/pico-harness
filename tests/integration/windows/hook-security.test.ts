import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  sanitizeCommandHookEnvironment,
  resolveHookShell,
} from "@pico/pico-host/hooks/config/command-shell";
import {
  DefaultHookExecutor,
  HookProcessTreeTerminationError,
  type HookHandlerExecutorOptions,
} from "@pico/pico-host/hooks/executors/executor";
import { HookTrustStore } from "@pico/pico-host/hooks/trust/store";
import type { CommandHookHandler, HookOutput } from "@pico/pico-host/hooks/types";
import {
  createSandboxPolicy,
  WINDOWS_RESTRICTED_NODE_OPTIONS,
} from "@pico/pico-host/process-sandbox";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { createCodeModeTool } from "@pico/pico-host/code-mode-tool";
import type { BaseTool } from "@pico/pico-host/tool-registry-contract";
import { ToolAccesses } from "@pico/runtime/tool-access";
import { HookService, emptyHookSnapshot } from "@pico/pico-host/hooks/service";
import { createTerminationFixture } from "./hook-termination-fixture.js";

for (const scenario of [
  { mode: "nonzero_exit", cancelled: false, beforeStart: false },
  { mode: "nonzero_exit", cancelled: true, beforeStart: false },
  { mode: "nonzero_exit", cancelled: true, beforeStart: true },
  { mode: "timeout", cancelled: false, beforeStart: false },
] as const) {
  test(
    `HookService preserves failed Windows tree proof (${scenario.mode}, parent cancel=${scenario.cancelled}, before start=${scenario.beforeStart})`,
    { timeout: 15_000 },
    async (context) => {
      const controller = new AbortController();
      const cancelled = new Error("parent cancelled owned Hook");
      const fixture = await createTerminationFixture(
        context,
        scenario.mode,
        "Stop",
        30_000,
        scenario.beforeStart ? () => controller.abort(cancelled) : undefined,
      );
      const unhandled: unknown[] = [];
      const observeUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", observeUnhandled);
      context.after(() => process.removeListener("unhandledRejection", observeUnhandled));
      const execution = fixture.service.dispatch(
        "Stop",
        { reason: "proof failure" },
        { signal: controller.signal },
      );
      void execution.catch(() => undefined);
      const root = await fixture.ready();
      if (scenario.cancelled && !scenario.beforeStart) controller.abort(cancelled);
      if (!scenario.cancelled) fixture.overflow(root);
      const killer = await fixture.terminationAttempt();
      assert.equal(root.exitCode, null, "failed taskkill must leave the real owned root alive");
      assert.equal(root.signalCode, null);
      assert.deepEqual(unhandled, [], "the rejected barrier must be observed before child close");
      fixture.release(root);
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error instanceof HookProcessTreeTerminationError);
        const [reason, proof]: unknown[] = error.errors;
        assert.ok(reason instanceof Error);
        if (scenario.cancelled) assert.equal(reason, cancelled);
        else assert.match(reason.message, /输出超过/u);
        assert.ok(proof instanceof Error);
        const diagnostic: unknown = JSON.parse(
          proof.message.slice(proof.message.indexOf(": ") + 2),
        );
        assert.ok(diagnostic && typeof diagnostic === "object");
        assert.ok("reason" in diagnostic && "rootPid" in diagnostic && "taskkillPid" in diagnostic);
        assert.equal(diagnostic.reason, scenario.mode);
        assert.equal(diagnostic.rootPid, root.pid);
        assert.equal(diagnostic.taskkillPid, killer.pid);
        assert.ok("rootExitCode" in diagnostic && "rootSignalCode" in diagnostic);
        assert.equal(diagnostic.rootExitCode, null);
        assert.equal(diagnostic.rootSignalCode, null);
        assert.ok("stderr" in diagnostic && typeof diagnostic.stderr === "string");
        assert.match(diagnostic.stderr, /^taskkill-denied:/u);
        assert.equal(diagnostic.stderr.length, 4_096);
        assert.ok("stderrTruncated" in diagnostic);
        assert.equal(diagnostic.stderrTruncated, true);
        if (scenario.mode === "nonzero_exit") {
          assert.ok("exitCode" in diagnostic);
          assert.equal(diagnostic.exitCode, 7);
        } else {
          assert.ok("elapsedMs" in diagnostic && typeof diagnostic.elapsedMs === "number");
          assert.ok(diagnostic.elapsedMs >= 900 && diagnostic.elapsedMs < 5_000);
        }
        return true;
      });
      assert.deepEqual(unhandled, []);
    },
  );
}

for (const cancelled of [true, false]) {
  test(
    `HookService drains started parallel Hooks without dequeuing after proof failure (parent cancel=${cancelled})`,
    { timeout: 15_000 },
    async (context) => {
      const normal = await createTerminationFixture(context, "success", "Stop", 30_000);
      const failed = await createTerminationFixture(context, "nonzero_exit", "Stop", 30_000);
      let queuedStarts = 0;
      const entries = [
        {
          ...normal.entry,
          id: "normal",
          handler: { type: "command" as const, command: "normal", timeoutMs: 30_000 },
        },
        {
          ...failed.entry,
          id: "failed",
          handler: {
            type: "command" as const,
            command: "failed",
            timeoutMs: 30_000,
          },
        },
        {
          ...normal.entry,
          id: "queued",
          handler: { type: "command" as const, command: "queued", timeoutMs: 30_000 },
        },
      ];
      const empty = emptyHookSnapshot();
      const service = new HookService({
        workDir: normal.workDir,
        sessionId: "parallel-proof",
        concurrency: 2,
        executor: {
          execute: async (entry, input, context) => {
            if (entry.id === "queued") queuedStarts++;
            return await (entry.id === "failed" ? failed.executor : normal.executor).execute(
              entry,
              input,
              context,
            );
          },
        },
        snapshot: {
          ...empty,
          handlers: new Proxy(empty.handlers, {
            get: (target, key) => (key === "Stop" ? entries : Reflect.get(target, key)),
          }),
        },
      });
      const controller = new AbortController();
      const reason = new Error("parallel parent cancellation");
      const execution = service.dispatch(
        "Stop",
        { reason: "parallel proof" },
        { signal: controller.signal },
      );
      let settled = false;
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const [normalRoot, failedRoot] = await Promise.all([normal.ready(), failed.ready()]);
      if (cancelled) {
        const normalClosed = new Promise<void>((resolve) =>
          normalRoot.once("close", () => resolve()),
        );
        controller.abort(reason);
        await normalClosed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          settled,
          false,
          "a normal abort must wait for the other started Hook to settle",
        );
        assert.equal(failedRoot.exitCode, null);
        await failed.terminationAttempt();
        failed.release(failedRoot);
      } else {
        failed.overflow(failedRoot);
        await failed.terminationAttempt();
        const failedClosed = new Promise<void>((resolve) =>
          failedRoot.once("close", () => resolve()),
        );
        failed.release(failedRoot);
        await failedClosed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "a proof failure must drain the other already started Hook");
        normal.release(normalRoot);
      }
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error instanceof HookProcessTreeTerminationError);
        if (cancelled) assert.equal(error.errors[0], reason);
        return true;
      });
      assert.equal(queuedStarts, 0, "a proof failure must stop new queued command launches");
    },
  );
}

for (const cancelled of [false, true]) {
  test(
    `HookService keeps normal Windows timeout/cancellation semantics (parent cancel=${cancelled})`,
    { timeout: 15_000 },
    async (context) => {
      const fixture = await createTerminationFixture(
        context,
        "success",
        "Stop",
        cancelled ? 30_000 : 8_000,
      );
      const controller = new AbortController();
      const reason = new Error("parent cancellation is preserved");
      const execution = fixture.service.dispatch(
        "Stop",
        { reason: "normal proof" },
        { signal: controller.signal },
      );
      void execution.catch(() => undefined);
      const root = await fixture.ready();
      if (cancelled) controller.abort(reason);
      if (cancelled) await assert.rejects(execution, (error) => error === reason);
      else {
        const output = await execution;
        assert.equal(output.decision, "allow");
        assert.ok(
          output.diagnostics?.some((diagnostic) => /timeout|timed out/iu.test(diagnostic.message)),
        );
      }
      assert.ok(root.exitCode !== null || root.signalCode !== null);
    },
  );
}

test(
  "HookService tree-proof failure escapes Registry and a CodeMode cell catch without later side effects",
  { timeout: 20_000 },
  async (context) => {
    const fixture = await createTerminationFixture(context, "nonzero_exit", "PreToolUse");
    const registry = new ToolRegistry();
    const executions: string[] = [];
    const readableTool = (name: string): BaseTool => ({
      name: () => name,
      nesting: "nestable",
      readOnly: true,
      accesses: () => ToolAccesses.none(),
      definition: () => ({
        name,
        description: "Observe physical dispatch",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
      execute: async () => {
        executions.push(name);
        return name;
      },
    });
    registry.register(readableTool("lookup"));
    registry.register(readableTool("probe"));
    registry.register(createCodeModeTool({ registry }));
    registry.setHookService(fixture.service);
    let failCleanup = false;
    let cleanupAttempts = 0;
    const cleanupError = new Error("execution middleware cleanup failed");
    const cleanup = async () => {
      cleanupAttempts++;
      throw cleanupError;
    };
    registry.useExecution(async (call, next) => {
      try {
        return await next(call);
      } finally {
        if (call.name === "exec" && failCleanup) await cleanup();
      }
    });
    for (const { codeMode, cancelled, cleanupFailure } of [
      { codeMode: false, cancelled: false, cleanupFailure: false },
      { codeMode: true, cancelled: false, cleanupFailure: false },
      { codeMode: true, cancelled: true, cleanupFailure: false },
      { codeMode: true, cancelled: false, cleanupFailure: true },
      { codeMode: true, cancelled: true, cleanupFailure: true },
    ]) {
      fixture.reset();
      failCleanup = cleanupFailure;
      const previousCleanupAttempts = cleanupAttempts;
      const controller = new AbortController();
      const reason = new Error("parent cancelled CodeMode");
      const step = registry.captureStep(`proof:${codeMode}:${cancelled}`, [
        "lookup",
        "probe",
        "exec",
      ]);
      const execution = registry.execute(
        {
          id: `proof:${codeMode}`,
          name: codeMode ? "exec" : "lookup",
          arguments: codeMode
            ? JSON.stringify({
                code: 'try { await tools.lookup({}); } catch {} await tools.probe({}); return "ignored";',
              })
            : "{}",
        },
        { step, signal: controller.signal },
      );
      void execution.catch(() => undefined);
      const root = await fixture.ready();
      if (cancelled) controller.abort(reason);
      else fixture.overflow(root);
      await fixture.terminationAttempt();
      fixture.release(root);
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error instanceof HookProcessTreeTerminationError);
        if (cancelled) assert.equal(error.errors[0], reason);
        return true;
      });
      assert.deepEqual(
        executions,
        [],
        "unproven termination cannot dispatch lookup or later probe",
      );
      assert.equal(cleanupAttempts - previousCleanupAttempts, cleanupFailure ? 1 : 0);
    }
    const ordinary = await registry.execute(
      {
        id: "ordinary-cleanup",
        name: "exec",
        arguments: JSON.stringify({ code: "return await tools.probe({});" }),
      },
      { step: registry.captureStep("ordinary-cleanup", ["probe", "exec"]) },
    );
    assert.equal(ordinary.isError, true, "ordinary middleware cleanup remains a ToolResult error");
    assert.match(ordinary.output, /execution middleware cleanup failed/u);
    assert.deepEqual(executions, ["probe"]);
  },
);

const WINDOWS_ONLY =
  process.platform === "win32" ? false : "requires Windows executable and process-tree semantics";

test(
  "Windows command Hooks execute .exe entries and accept shell-owned extensions (.cmd)",
  { skip: WINDOWS_ONLY },
  async (context) => {
    const fixture = await createFixture(context, "direct-exe");
    const entryPath = join(fixture.workspace, "entry.cjs");
    await writeFile(join(fixture.workspace, "dependency.cjs"), 'module.exports = "windows-exe";\n');
    await writeFile(
      entryPath,
      [
        'const { readdirSync } = require("node:fs");',
        'const { parse } = require("node:path");',
        "const driveRoot = parse(process.execPath).root;",
        "let rootListed = true;",
        "try { readdirSync(driveRoot); } catch (error) {",
        '  if (!error || !["EACCES", "EPERM"].includes(error.code)) throw error;',
        "  rootListed = false;",
        "}",
        'if (rootListed) throw new Error("drive root unexpectedly listable");',
        `if (process.env.NODE_OPTIONS !== ${JSON.stringify(WINDOWS_RESTRICTED_NODE_OPTIONS)}) throw new Error("unexpected NODE_OPTIONS");`,
        'process.stdout.write(JSON.stringify({ additionalContext: require("./dependency.cjs") }));',
        "",
      ].join("\n"),
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
    const restrictedShell = resolveHookShell(process.env, {
      windowsAppContainerCompatible: true,
    });
    assert.equal(restrictedShell.kind, "pwsh", "Windows CI host must provide PowerShell 7");
    // Model nvm's directory alias even on hosts whose Node install is not linked.
    const runtimeDirectory = await realpath(dirname(process.execPath));
    const runtimeAlias = join(fixture.root, "node-toolchain-link");
    await symlink(runtimeDirectory, runtimeAlias, "junction");
    const shellDirectory = await realpath(dirname(restrictedShell.path));
    const restrictedPath = `${runtimeAlias};${shellDirectory};`;
    const environment = withoutExecutionPath(process.env);
    // Keep the AppContainer-compatible shell on the deliberately mixed-case PATH.
    // Removing pwsh here would test the legacy Windows PowerShell fallback instead
    // of case-insensitive bare-command lookup.
    environment.pAtH = restrictedPath;
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
    // PowerShell 7 starts by prepending PSHOME; the remaining entries must be the
    // deliberately controlled mixed-case PATH with no ambient host directories.
    assert.equal(
      output.additionalContext,
      `${shellDirectory};${runtimeDirectory};${shellDirectory};`,
      JSON.stringify(output),
    );
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
    const output = await diagnoseNativeTreeExecution(context, execution, tree);

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
    await assert.rejects(
      diagnoseNativeTreeExecution(context, execution, tree),
      /windows-hook-cancelled/u,
    );

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

async function diagnoseNativeTreeExecution(
  context: TestContext,
  execution: Promise<HookOutput>,
  tree: ProcessTree,
): Promise<HookOutput> {
  try {
    return await execution;
  } catch (error) {
    const errors: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
    context.diagnostic(
      JSON.stringify({
        ownedTree: tree,
        parentAlive: isProcessRunning(tree.parent),
        childAlive: isProcessRunning(tree.child),
        errors: errors.map((entry) =>
          entry instanceof Error ? { name: entry.name, message: entry.message } : String(entry),
        ),
      }),
    );
    throw error;
  }
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
      // Exercise the prepared \\Device\\Null boundary as well as Job Object tree termination.
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
      config: { network: "deny" },
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
