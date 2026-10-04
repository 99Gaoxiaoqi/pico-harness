import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import {
  HookProcessTreeTerminationError,
  type DefaultHookExecutor,
} from "@pico/pico-host/hooks/executors/executor";
import { HookService, emptyHookSnapshot } from "@pico/pico-host/hooks/service";
import { createSandboxPolicy } from "@pico/pico-host/process-sandbox";
import type { HookEvent, ResolvedHookHandler } from "@pico/pico-host/hooks/types";

type TerminationMode = "success" | "nonzero_exit" | "timeout";
type ExecutorModule = typeof import("@pico/pico-host/hooks/executors/executor");

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** Only Windows OS launch ports are replaced; the executor, service and tree-proof logic are real. */
export async function createTerminationFixture(
  context: TestContext,
  mode: TerminationMode,
  event: HookEvent = "Stop",
  timeoutMs = 30_000,
  beforeLaunch?: () => void,
) {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-tree-proof-"));
  const owned: ChildProcess[] = [];
  let nextCommand = deferred<ChildProcess>();
  let nextTaskkill = deferred<ChildProcess>();
  let command: ChildProcess | undefined;
  const launch = () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "process.stdin.resume();",
          "process.on('message', message => { if (message === 'close') process.exit(0); if (message === 'overflow') process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 120)); });",
          "setInterval(() => undefined, 1000);",
          "process.send('ready');",
        ].join("\n"),
      ],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] },
    );
    owned.push(child);
    command = child;
    nextCommand.resolve(child);
    return { child };
  };
  const taskkill = (name: string, args: readonly string[]) => {
    assert.equal(name, "taskkill");
    assert.ok(command?.pid);
    assert.deepEqual(Array.from(args), ["/pid", String(command.pid), "/T", "/F"]);
    const script =
      mode === "success"
        ? `process.kill(${command.pid}, 'SIGTERM');`
        : [
            "process.stdout.write('taskkill-output:' + 'x'.repeat(5000));",
            "process.stderr.write('taskkill-denied:' + 'y'.repeat(5000));",
            mode === "nonzero_exit"
              ? "process.exitCode = 7;"
              : "setInterval(() => undefined, 1000);",
          ].join("\n");
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    owned.push(child);
    child.once("close", () => nextTaskkill.resolve(child));
    return child;
  };
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const bundled = await build({
    entryPoints: [join(sourceRoot, "packages/pico-host/src/hooks/executors/executor.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "controlled-windows-launch-ports",
        setup(builder) {
          builder.onResolve(
            { filter: /^@pico\/runtime\/(process-tree|deadline)$/ },
            ({ path }) => ({
              path: join(sourceRoot, `packages/runtime/src/${path.split("/").at(-1)}.ts`),
            }),
          );
          builder.onResolve({ filter: /host-shell\.js$/ }, () => ({
            path: "windows",
            namespace: "ports",
          }));
          builder.onResolve({ filter: /termination-error\.js$/ }, () => ({
            path: "error",
            namespace: "ports",
          }));
          builder.onResolve({ filter: /process-sandbox\/index\.js$/ }, () => ({
            path: "launcher",
            namespace: "ports",
          }));
          builder.onResolve({ filter: /command-shell\.js$/ }, () => ({
            path: "shell",
            namespace: "ports",
          }));
          builder.onResolve({ filter: /^@pico\/runtime-host\/mcp-protocol$/ }, () => ({
            path: "mcp",
            namespace: "ports",
          }));
          builder.onLoad({ filter: /.*/, namespace: "ports" }, ({ path }) => ({
            contents: {
              windows: "export const isWindows = true;",
              error: "export const HookProcessTreeTerminationError = hookPorts.error;",
              launcher:
                "export const managedProcessLauncher = { launch: hookPorts.launch }; export class SandboxViolationError extends Error {} export const normalizeRoots = x => x; export const runtimeReadRoots = () => []; export const shellRuntimeReadRoots = () => [];",
              shell:
                "export const resolveHookShell = () => ({ kind: 'powershell', path: 'controlled', argsPrefix: [] }); export const resolveCommandHookExecution = () => { throw new Error('fixture requires trusted invocation'); };",
              mcp: "export const mcpResultToText = () => { throw new Error('unused MCP port'); };",
            }[path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = { exports: {} as Record<string, unknown> };
  const windowsProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(windowsProcess, "platform", { value: "win32" });
  runInNewContext(bundled.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier === "node:child_process") return { spawn: taskkill };
      if (specifier === "node:crypto") return { randomUUID: () => "controlled-hook" };
      throw new Error(`Unexpected fixture dependency ${specifier}`);
    },
    hookPorts: { launch, error: HookProcessTreeTerminationError },
    process: windowsProcess,
    Promise,
    Error,
    AggregateError,
    DOMException,
    Buffer,
    AbortController,
    AbortSignal,
    performance,
    setTimeout,
    clearTimeout,
    console,
  });
  const Executor = module.exports.DefaultHookExecutor as ExecutorModule["DefaultHookExecutor"];
  const executor: DefaultHookExecutor = new Executor({
    workDir: root,
    processSandbox: createSandboxPolicy({
      profile: "danger-full-access",
      workspaceRoots: [root],
      scratchRoot: join(root, "scratch"),
    }),
    authorizeCommandExecution: async (_handler, shell) => {
      beforeLaunch?.();
      return {
        shell,
        command: process.execPath,
        args: [],
        commandString: "controlled",
        env: {},
        explicitEnvKeys: [],
      };
    },
  });
  const entry: ResolvedHookHandler = {
    id: "owned-tree",
    event,
    order: 0,
    trusted: true,
    ...(event === "PreToolUse" ? { matcher: "lookup" } : {}),
    source: { kind: "project", path: join(root, "hooks.json"), version: 1 },
    handler: { type: "command", command: "controlled", timeoutMs },
  };
  const empty = emptyHookSnapshot();
  const service = new HookService({
    workDir: root,
    sessionId: "owned-tree",
    executor,
    snapshot: {
      ...empty,
      handlers: new Proxy(empty.handlers, {
        get: (target, key) => (key === event ? [entry] : Reflect.get(target, key)),
      }),
    },
  });
  context.after(async () => {
    for (const child of owned) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error("owned fixture cleanup timed out")), 5_000);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await executor.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    service,
    executor,
    entry,
    workDir: root,
    async ready() {
      const child = await nextCommand.promise;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.removeListener("message", onReady);
          child.removeListener("error", onError);
          child.removeListener("close", onClose);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(
            new Error(
              `owned Hook closed before IPC readiness: ${child.exitCode}/${child.signalCode}`,
            ),
          );
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("owned Hook IPC readiness exceeded 10s"));
        }, 10_000);
        child.once("message", onReady);
        child.once("error", onError);
        child.once("close", onClose);
        if (child.exitCode !== null || child.signalCode !== null) onClose();
      });
      return child;
    },
    async terminationAttempt() {
      const child = await nextTaskkill.promise;
      // The close listener runs before the production deadline/barrier continuation settles.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return child;
    },
    release(child: ChildProcess) {
      child.send("close");
    },
    overflow(child: ChildProcess) {
      child.send("overflow");
    },
    reset() {
      nextCommand = deferred<ChildProcess>();
      nextTaskkill = deferred<ChildProcess>();
    },
  };
}
