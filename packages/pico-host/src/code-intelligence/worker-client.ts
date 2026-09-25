import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { scheduleUnrefDeadline, type ScheduledDeadline } from "@pico/runtime/deadline";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  managedProcessLauncher,
  SandboxViolationError,
  type SandboxLease,
} from "../process-sandbox/index.js";
import { REPO_MAP_MAX_FILES, type RepoMapSnapshot } from "./repo-map.js";
import type {
  CodeCall,
  CodeDiagnostic,
  CodeIntelligenceQueryOptions,
  CodeIntelligenceService,
  CodeLocation,
  CodeSymbol,
  PositionQuery,
  SymbolQuery,
} from "./types.js";
import type {
  CodeIntelligenceWorkerCall,
  CodeIntelligenceWorkerResponse,
  WorkerDocument,
} from "./worker-protocol.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

export interface ReadOnlyCodeWorkerSandbox {
  readonly generation: number;
  readonly rootDir: string;
  readonly workspaceRoots: readonly string[];
  readonly readRoots?: readonly string[];
  readonly readFiles?: readonly string[];
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ScheduledDeadline;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/** One OS-isolated, network-denied process owns all Repo Map state for a session generation. */
export class ReadOnlyCodeWorker implements CodeIntelligenceService {
  readonly backend = "repo-map" as const;
  private child: ChildProcess | undefined;
  private lease: SandboxLease | undefined;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private unavailable: Error | undefined;
  private stderrTail = "";
  private closed = false;
  private attested = false;
  private readonly scratchRoot: string;

  constructor(private readonly sandbox: ReadOnlyCodeWorkerSandbox) {
    const defaultRoot = defaultSandboxScratchRoot(sandbox.rootDir);
    this.scratchRoot = resolve(
      realpathSync.native(tmpdir()),
      relative(tmpdir(), defaultRoot),
      "code-intelligence-worker",
      randomUUID(),
    );
  }

  generation(): number {
    return this.sandbox.generation;
  }

  isReady(): boolean {
    return this.attested && !this.closed && !this.unavailable && this.child?.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("代码智能 Worker 已关闭");
    if (this.unavailable) throw this.unavailable;
    if (this.child) return;
    const rootDir = await realpath(this.sandbox.rootDir);
    const workspaceRoots = await Promise.all(
      this.sandbox.workspaceRoots.map((root) => realpath(root)),
    );
    const rootIdentity = await directoryIdentity(rootDir);
    const rootIdentities = await Promise.all(workspaceRoots.map(directoryIdentity));
    if (workspaceRoots.some((root) => within(root, this.scratchRoot))) {
      throw new SandboxViolationError(
        "sandbox_unavailable",
        "代码智能 Worker 暂存目录落在可写工作区内",
      );
    }
    const { entry, args, codeRoots, electron } = await resolveWorkerEntry();
    await rejectWritableCodeOverlap(codeRoots, entry, workspaceRoots);
    if (this.closed) throw new Error("代码智能 Worker 已关闭");
    const policy = createSandboxPolicy({
      profile: "read-only",
      workspaceRoots,
      scratchRoot: this.scratchRoot,
      readRoots: [...codeRoots, ...(this.sandbox.readRoots ?? [])],
      ...(this.sandbox.readFiles ? { readFiles: this.sandbox.readFiles } : {}),
      config: { network: "deny" },
      generation: this.sandbox.generation,
    });
    const launched = managedProcessLauncher.launch(
      {
        command: process.execPath,
        args: [
          ...args,
          JSON.stringify({
            rootDir,
            rootIdentity,
            roots: workspaceRoots,
            rootIdentities,
            generation: this.sandbox.generation,
          }),
        ],
        cwd: this.sandbox.rootDir,
        origin: "file-worker",
        policy,
        ...(electron
          ? {
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              explicitEnvKeys: ["ELECTRON_RUN_AS_NODE"],
            }
          : {}),
      },
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = launched.child;
    this.lease = launched.lease;
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2048);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) =>
      this.fail(new Error(`代码智能 Worker 退出 ${code}: ${this.stderrTail.trim()}`)),
    );
    // A round trip proves the entry is running under the policy before tools use it.
    try {
      await this.call({ operation: "rootEntries" });
      this.attested = true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async rootEntries(): Promise<readonly string[]> {
    return (await this.call({ operation: "rootEntries" })) as string[];
  }

  async readDocument(filePath: string, signal?: AbortSignal): Promise<WorkerDocument> {
    return (await this.call({ operation: "readDocument", filePath }, signal)) as WorkerDocument;
  }

  async snapshot(
    options: {
      readonly query?: string;
      readonly maxFiles?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RepoMapSnapshot> {
    return (await this.call(
      {
        operation: "snapshot",
        ...(options.query ? { query: options.query } : {}),
        ...(options.maxFiles ? { maxFiles: Math.min(options.maxFiles, REPO_MAP_MAX_FILES) } : {}),
      },
      options.signal,
    )) as RepoMapSnapshot;
  }

  async definitions(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    return (await this.call({ operation: "definitions", query }, options.signal)) as CodeLocation[];
  }

  async references(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    return (await this.call({ operation: "references", query }, options.signal)) as CodeLocation[];
  }

  async symbols(
    query: SymbolQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeSymbol[]> {
    return (await this.call({ operation: "symbols", query }, options.signal)) as CodeSymbol[];
  }

  async diagnostics(
    filePath: string,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeDiagnostic[]> {
    return (await this.call(
      { operation: "diagnostics", filePath },
      options.signal,
    )) as CodeDiagnostic[];
  }

  async callHierarchy(
    query: PositionQuery,
    direction: "incoming" | "outgoing",
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeCall[]> {
    return (await this.call(
      { operation: "callHierarchy", query, direction },
      options.signal,
    )) as CodeCall[];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("代码智能 Worker 已关闭"));
    await this.lease?.terminate().catch(() => undefined);
    await rm(this.scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  private call(call: CodeIntelligenceWorkerCall, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.unavailable)
      return Promise.reject(this.unavailable ?? new Error("代码智能 Worker 已关闭"));
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("代码智能 Worker 不可用"));
    signal?.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = signal ? () => this.fail(new Error("代码智能 Worker 调用已取消")) : undefined;
      const timer = scheduleUnrefDeadline(
        () => this.fail(new Error("代码智能 Worker 请求超时")),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
        ...(onAbort ? { onAbort } : {}),
      });
      if (onAbort) signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin!.write(
        `${JSON.stringify({ id, generation: this.sandbox.generation, call })}\n`,
        (error) => {
          if (error) this.fail(error);
        },
      );
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) {
      this.fail(new Error("代码智能 Worker 响应过大"));
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let response: CodeIntelligenceWorkerResponse;
      try {
        response = JSON.parse(line) as CodeIntelligenceWorkerResponse;
      } catch {
        this.fail(new Error("代码智能 Worker 响应不是 JSON"));
        return;
      }
      const pending = this.pending.get(response.id);
      if (
        !pending ||
        response.generation !== this.sandbox.generation ||
        typeof response.ok !== "boolean"
      ) {
        this.fail(new Error("代码智能 Worker 响应与任务边界不匹配"));
        return;
      }
      this.pending.delete(response.id);
      pending.timer.cancel();
      if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? "代码智能 Worker 执行失败"));
    }
  }

  private fail(error: Error): void {
    if (this.unavailable) return;
    this.unavailable = error;
    this.attested = false;
    for (const pending of this.pending.values()) {
      pending.timer.cancel();
      if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}

async function directoryIdentity(target: string): Promise<string> {
  const info = await lstat(target, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SandboxViolationError(
      "sandbox_unavailable",
      `代码智能 Worker 根不是普通目录: ${target}`,
    );
  }
  return `${info.dev}:${info.ino}`;
}

async function resolveWorkerEntry(): Promise<{
  entry: string;
  args: string[];
  codeRoots: string[];
  bundled: boolean;
  electron: boolean;
}> {
  const electron = Boolean(process.versions.electron);
  const bundled = electron || process.platform === "win32";
  let entry: string;
  let args: string[];
  let codeDirectories: string[];
  if (electron) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath)
      throw new SandboxViolationError("sandbox_unavailable", "桌面代码智能 Worker 资源目录不存在");
    entry = resolve(resourcesPath, "code-intelligence-worker", "worker.mjs");
    const executableRoot =
      process.platform === "darwin"
        ? dirname(dirname(dirname(process.execPath)))
        : dirname(process.execPath);
    codeDirectories = [dirname(entry), executableRoot];
    args = [entry];
  } else if (process.platform === "win32") {
    const candidates = [
      "../../../../resources/code-intelligence-worker/worker.mjs",
      "../../../../../resources/code-intelligence-worker/worker.mjs",
    ].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));
    entry = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
    codeDirectories = [dirname(entry)];
    args = [entry];
  } else {
    const sourceUrl = new URL(import.meta.url);
    const suffix = sourceUrl.pathname.endsWith(".ts") ? ".ts" : ".js";
    entry = fileURLToPath(new URL(`./worker-main${suffix}`, sourceUrl));
    const moduleDir = dirname(fileURLToPath(sourceUrl));
    const packageRoot = resolve(moduleDir, "../..");
    const runtimeRoot = resolve(
      dirname(fileURLToPath(import.meta.resolve("@pico/runtime/tool-access"))),
      "..",
    );
    const coreRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@pico/core"))), "..");
    const localModules = resolve(packageRoot, "../../node_modules");
    const nodeModulesRoot = existsSync(localModules) ? localModules : resolve(packageRoot, "../..");
    codeDirectories = [packageRoot, runtimeRoot, coreRoot, nodeModulesRoot];
    args =
      suffix === ".ts" ? ["--import", fileURLToPath(import.meta.resolve("tsx")), entry] : [entry];
  }
  for (const target of [entry, ...(bundled ? [`${entry}.sha256`] : [])]) {
    const info = await lstat(target).catch(() => {
      throw new SandboxViolationError(
        "sandbox_unavailable",
        `代码智能 Worker 资源不存在: ${target}`,
      );
    });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SandboxViolationError(
        "sandbox_unavailable",
        "代码智能 Worker 资源不是受信普通文件",
      );
    }
  }
  if (bundled) {
    const expected = (await readFile(`${entry}.sha256`, "utf8")).trim().split(/\s/u)[0];
    const actual = createHash("sha256")
      .update(await readFile(entry))
      .digest("hex");
    if (!expected || expected !== actual) {
      throw new SandboxViolationError("sandbox_unavailable", "代码智能 Worker 资源摘要不匹配");
    }
  }
  const codeRoots = await Promise.all(codeDirectories.map((directory) => realpath(directory)));
  return { entry, args, codeRoots, bundled, electron };
}

async function rejectWritableCodeOverlap(
  codeRoots: readonly string[],
  entry: string,
  workspaceRoots: readonly string[],
): Promise<void> {
  const trusted = [...codeRoots, await realpath(entry), await realpath(process.execPath)];
  if (
    trusted.some((target) =>
      workspaceRoots.some((root) => within(root, target) || within(target, root)),
    )
  ) {
    throw new SandboxViolationError(
      "sandbox_unavailable",
      "代码智能 Worker 受信代码或运行时与可写工作区重叠",
    );
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
