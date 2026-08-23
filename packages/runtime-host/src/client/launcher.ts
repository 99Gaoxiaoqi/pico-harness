import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  candidateStartupFailureForExitCode,
  type CandidateStartupFailure,
} from "../candidate-startup-failure.js";

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  operationDeadlineMs?: number;
  executable?: string;
  entrypoint?: string | URL;
  env?: NodeJS.ProcessEnv;
  /**
   * Directory receiving the candidate's combined stdout/stderr log. Candidates
   * are detached with no controlling terminal, so without this their crash
   * evidence (unhandled rejection stacks, V8 fatal output) vanishes. Log setup
   * is best-effort: any failure falls back to a silent stdio and never fails
   * the launch itself.
   */
  logDirectory?: string;
}

export interface DetachedCandidateAttempt {
  pid: number;
  /**
   * Stable capability for this exact child. Tests use it to own teardown without
   * turning the diagnostic PID into a long-lived signalling capability.
   */
  process?: DetachedCandidateProcess;
  /** Log file the candidate's output was redirected to, when logging was set up. */
  logFile?: string;
  /**
   * Startup-failure report decoded from the candidate's exit code (fast-fail
   * protocol). Resolves undefined for protocol-external exits (flock loser,
   * V8 crash codes, signals) and when spawn itself errors. detached child 句柄
   * 在本进程 event loop 存续期间仍能收到 exit 事件，unref 不影响。
   */
  startupFailure?: Promise<CandidateStartupFailure | undefined>;
}

export interface DetachedCandidateProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Exact spawned-child capability; unlike a raw PID it cannot be rebound after exit. */
export interface DetachedCandidateProcess {
  readonly pid: number;
  readonly exited: boolean;
  readonly closed: Promise<DetachedCandidateProcessExit>;
  terminate(signal: "SIGTERM" | "SIGKILL"): boolean;
}

export interface DetachedCandidateLaunch {
  spawned: Promise<DetachedCandidateAttempt>;
}

const CANDIDATE_LOG_KEEP_COUNT = 20;
const CANDIDATE_LOG_PREFIX = "candidate-";

export type CandidateLauncher = (input: DetachedCandidateInput) => DetachedCandidateLaunch;

/**
 * Resolve the default candidate entrypoint for the current runtime form.
 *
 * - Compiled (dist): `candidate-main.js` sits next to the compiled client and is
 *   run directly by node.
 * - Source (tsx): only `candidate-main.ts` exists. The candidate is a detached
 *   `node` process, so it needs the tsx ESM loader registered via `--import`.
 *   The loader is resolved to an absolute path from this module's own location
 *   (createRequire) so the spawn does not depend on the child's cwd being able
 *   to resolve the bare `tsx` specifier. Without the loader the spawned child
 *   dies with ERR_MODULE_NOT_FOUND and the election loop only ever sees a bare
 *   `startup_timeout`.
 */
function resolveDefaultEntrypoint(): { path: string; tsxLoaderPath?: string } {
  const compiledPath = fileURLToPath(new URL("../candidate-main.js", import.meta.url));
  if (existsSync(compiledPath)) return { path: compiledPath };
  const sourcePath = fileURLToPath(new URL("../candidate-main.ts", import.meta.url));
  if (existsSync(sourcePath)) return { path: sourcePath, tsxLoaderPath: resolveTsxLoaderPath() };
  // Let node surface a clear module-not-found rather than the election loop
  // timing out with no information.
  return { path: compiledPath };
}

function resolveTsxLoaderPath(): string {
  try {
    const resolved = createRequire(import.meta.url).resolve("tsx");
    // node --import 需要 file:// URL（Windows 裸绝对路径会被当作 URL scheme 报
    // ERR_UNSUPPORTED_ESM_URL_SCHEME），故转为 file URL。
    return pathToFileURL(resolved).href;
  } catch {
    // Fall back to the bare specifier; the child then resolves tsx from its own
    // cwd's node_modules (works when spawned from within the workspace).
    return "tsx";
  }
}

export function launchDetachedRuntimeHostCandidate(
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const executable = input.executable ?? process.execPath;
  const usesDefaultEntrypoint = input.entrypoint === undefined;
  // Vite may rewrite import.meta.url in a bundled caller. Do not touch the
  // default resolver when the host supplied an explicit candidate artifact;
  // apart from avoiding unnecessary I/O, this keeps that bundled path viable.
  // When the default is needed, resolve its path and loader together to avoid a
  // TOCTOU between the two existsSync checks.
  const resolvedDefault = usesDefaultEntrypoint ? resolveDefaultEntrypoint() : undefined;
  const entrypointPath =
    input.entrypoint === undefined
      ? resolvedDefault!.path
      : typeof input.entrypoint === "string"
        ? // file:// href 字符串是常见的传参形态；转换为路径而非当作字面脚本路径。
          input.entrypoint.startsWith("file://")
          ? fileURLToPath(input.entrypoint)
          : input.entrypoint
        : fileURLToPath(input.entrypoint);
  // 自定义 entrypoint 若是 TypeScript 源文件（如 pico daemon main.ts），同样需要
  // tsx ESM loader——detached node 子进程没有别的 TS 装载途径。
  const tsxLoaderPath = usesDefaultEntrypoint
    ? resolvedDefault!.tsxLoaderPath
    : entrypointPath.endsWith(".ts")
      ? resolveTsxLoaderPath()
      : undefined;
  const args = [
    // 源码模式下为 detached node 子进程注册 tsx ESM loader（绝对路径，不依赖子进程 cwd）。
    ...(tsxLoaderPath ? ["--import", tsxLoaderPath] : []),
    entrypointPath,
    "--root",
    input.rootPath,
    "--expected-root-id",
    input.expectedRootId,
  ];
  appendArgument(args, "--idle-grace-ms", input.idleGraceMs);
  appendArgument(args, "--handshake-timeout-ms", input.handshakeTimeoutMs);
  appendArgument(args, "--operation-deadline-ms", input.operationDeadlineMs);
  appendArgument(args, "--legacy-configuration-root", input.legacyConfigurationRoot);

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const logSink = prepareCandidateLogSink(input);
  let stdio: "ignore" | ["ignore", number, number] = "ignore";
  if (logSink) {
    // Header precedes any child output: an empty log still proves a launch happened
    // and records what was launched.
    writeSync(logSink.fd, logSink.header);
    stdio = ["ignore", logSink.fd, logSink.fd];
  }
  const child = (() => {
    try {
      return spawn(executable, args, {
        cwd: tsxLoaderPath
          ? process.cwd()
          : dirname(isAbsolute(executable) ? executable : process.execPath),
        detached: true,
        stdio,
        windowsHide: true,
        env: {
          ...process.env,
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          ...input.env,
        },
      });
    } finally {
      // uv_spawn duplicates the stdio handles into the child synchronously; the
      // parent's copy is redundant from here on regardless of the spawn outcome.
      if (logSink) closeSync(logSink.fd);
    }
  })();
  const logFile = logSink?.path;
  const startupFailure = readStartupFailure(child);
  const spawned = new Promise<DetachedCandidateAttempt>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("Runtime Host candidate did not receive a process id"));
        return;
      }
      const candidateProcess = captureDetachedCandidateProcess(child, pid);
      child.unref();
      resolve(
        logFile === undefined
          ? { pid, process: candidateProcess, startupFailure }
          : { pid, process: candidateProcess, logFile, startupFailure },
      );
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
  if (logSink) void pruneCandidateLogs(logSink.directory);
  return { spawned };
}

function captureDetachedCandidateProcess(
  child: ChildProcess,
  pid: number,
): DetachedCandidateProcess {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const closed = new Promise<DetachedCandidateProcessExit>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  return {
    pid,
    get exited() {
      return exited;
    },
    closed,
    terminate(signal) {
      if (exited) return false;
      return child.kill(signal);
    },
  };
}

/**
 * 退出码协议的桥：监听 detached child 的 exit，把协议内退出码���查回失败对象。
 * 协议外退出码（loser 2、崩溃随机码、信号 null）与 spawn error 一律 undefined
 * ——选举循环对它们维持既有轮询语义。
 */
function readStartupFailure(
  child: ReturnType<typeof spawn>,
): Promise<CandidateStartupFailure | undefined> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(candidateStartupFailureForExitCode(code)));
    child.once("error", () => resolve(undefined));
  });
}

interface CandidateLogSink {
  fd: number;
  path: string;
  directory: string;
  header: string;
}

/**
 * Best-effort log sink for one candidate launch. Never throws: a candidate that
 * cannot be logged must still be launched (an election lost to logging would be
 * strictly worse than one lost silently).
 */
function prepareCandidateLogSink(input: DetachedCandidateInput): CandidateLogSink | undefined {
  if (!input.logDirectory) return undefined;
  try {
    mkdirSync(input.logDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const path = join(
      input.logDirectory,
      `${CANDIDATE_LOG_PREFIX}${stamp}-${randomBytes(3).toString("hex")}.log`,
    );
    const fd = openSync(path, "a", 0o600);
    const header =
      `# candidate launch ${new Date().toISOString()}\n` +
      `# root=${input.rootPath}\n` +
      `# entrypoint=${typeof input.entrypoint === "string" ? input.entrypoint : "default"}\n`;
    return { fd, path, directory: input.logDirectory, header };
  } catch {
    return undefined;
  }
}

/** Keep only the newest candidate logs; older ones are stale crash evidence at best. */
async function pruneCandidateLogs(directory: string): Promise<void> {
  try {
    const entries = readdirSync(directory)
      .filter((name) => name.startsWith(CANDIDATE_LOG_PREFIX) && name.endsWith(".log"))
      .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    for (const stale of entries.slice(CANDIDATE_LOG_KEEP_COUNT)) {
      try {
        unlinkSync(join(directory, stale.name));
      } catch {
        // Racing a concurrent prune or a locked file is fine; the next pass retries.
      }
    }
  } catch {
    // Retention is opportunistic; nothing here may disturb the caller.
  }
}

function appendArgument(args: string[], key: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(key, String(value));
}
