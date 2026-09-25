import { createHash, randomUUID } from "node:crypto";
import { lstat, access, constants, readFile, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolResultArchiveRef } from "@pico/runtime/tool-result-archive";
import { ToolAccesses } from "@pico/runtime/tool-access";
import { scheduleDeadline } from "@pico/runtime/deadline";
import type { BaseTool, ToolExecutionContext } from "./tool-registry-contract.js";
import { NO_FILE_SIDE_EFFECTS } from "./tool-registry-contract.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import {
  captureAtomicFilePrecondition,
  readBoundedFileSnapshot,
  writeAtomicWorkspaceFile,
  type AtomicWorkspaceFileWrite,
} from "./atomic-workspace-file.js";
import { assertSameResolvedTarget, READ_FILE_MAX_BYTES } from "./file-tool-helpers.js";
import {
  publishWrittenArtifact,
  type BoundSessionArtifactAuthority,
} from "./session-artifact-writer.js";
import {
  createSandboxPolicy,
  defaultSandboxScratchRoot,
  managedProcessLauncher,
  SandboxViolationError,
  type SandboxProfile,
} from "./process-sandbox/index.js";
import type {
  FileTargetIdentity,
  FileWorkerOperation,
  FileWorkerRequest,
  FileWorkerResponse,
} from "./file-worker-protocol.js";
import { sameFileTargetIdentity } from "./file-worker-protocol.js";

export interface FileWorkerSandboxDescriptor {
  readonly profile: SandboxProfile;
  readonly bypass?: boolean;
  readonly generation?: number;
  readonly hasUnsupportedDenyEntries?: boolean;
  readonly writeRoots?: readonly string[];
}

export interface FileWorkerToolOptions {
  readonly roots: WorkspaceRoots;
  readonly workDir: string;
  readonly resolveSandbox: () => FileWorkerSandboxDescriptor;
  readonly artifacts?: BoundSessionArtifactAuthority;
  readonly excludeSensitiveFiles?: boolean;
  readonly timeoutMs?: number;
}

// This module is supplied by the Windows Broker integration branch. Keeping the
// loading conditional makes an unavailable trusted commit backend fail closed.
const WINDOWS_FILE_COMMIT_MODULE = "./process-sandbox/windows-file-commit.js";

/** Keeps the public tool contract while routing managed invocations through one isolated process. */
export class FileWorkerTool implements BaseTool {
  readonly nesting?: NonNullable<BaseTool["nesting"]>;
  readonly readOnly?: boolean;
  readonly permissionCategory?: NonNullable<BaseTool["permissionCategory"]>;
  readonly recoveryMode?: NonNullable<BaseTool["recoveryMode"]>;
  readonly recoveryKey?: string;
  readonly readsToolResultArchives;
  readonly fileSideEffects;

  constructor(
    private readonly delegate: BaseTool,
    private readonly options: FileWorkerToolOptions,
  ) {
    if (delegate.nesting !== undefined) this.nesting = delegate.nesting;
    if (delegate.readOnly !== undefined) this.readOnly = delegate.readOnly;
    if (delegate.permissionCategory !== undefined)
      this.permissionCategory = delegate.permissionCategory;
    if (delegate.recoveryMode !== undefined) this.recoveryMode = delegate.recoveryMode;
    if (delegate.recoveryKey !== undefined) this.recoveryKey = delegate.recoveryKey;
    this.readsToolResultArchives = delegate.readsToolResultArchives ?? false;
    this.fileSideEffects =
      typeof delegate.fileSideEffects === "function"
        ? delegate.fileSideEffects.bind(delegate)
        : (delegate.fileSideEffects ?? NO_FILE_SIDE_EFFECTS);
  }

  name() {
    return this.delegate.name();
  }
  definition() {
    return this.delegate.definition();
  }
  accesses(args: string) {
    return this.delegate.accesses?.(args) ?? ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const operation = this.name() as FileWorkerOperation;
    const sandbox = this.options.resolveSandbox();
    if (sandbox.bypass ?? sandbox.profile === "danger-full-access")
      return this.delegate.execute(args, context);
    if (sandbox.hasUnsupportedDenyEntries) {
      throw new SandboxViolationError(
        "policy_compilation_failed",
        "文件权限含 OS 沙箱无法表达的 deny/protectedMetadata 条目，已 fail-closed 拒绝 File Worker。",
      );
    }
    const input = JSON.parse(args) as Record<string, unknown>;
    if (operation === "write_file" && input.artifact === true && !this.options.artifacts) {
      throw new Error("当前宿主未提供会话生成文件登记能力");
    }
    if (
      operation === "read_file" &&
      typeof input.path === "string" &&
      parseToolResultArchiveRef(input.path)
    ) {
      return this.delegate.execute(args, context);
    }
    const paths =
      operation === "explore_repo"
        ? Array.isArray(input.roots)
          ? input.roots.slice(0, 5).map(String)
          : ["."]
        : [typeof input.path === "string" ? input.path : "."];
    const write = operation === "write_file" || operation === "edit_file";
    if (write && sandbox.profile === "read-only") {
      throw new SandboxViolationError("workspace_write_denied", "只读任务不能写入文件。");
    }
    const targets = await Promise.all(
      paths.map(async (path) => {
        const resolved = await this.options.roots.assertAllowed(path, {
          access: write ? "write" : "read",
          consumeAuthorization: false,
        });
        return { path: resolved, identity: await fileTargetIdentity(resolved) };
      }),
    );
    if (operation === "read_file" || operation === "edit_file") {
      if (targets[0]?.identity.kind !== "file") throw new Error(`文件不是普通文件: ${paths[0]}`);
    }
    const operationId = randomUUID();
    const revision = sandbox.generation ?? this.options.roots.generation();
    // macOS may expose the workspace through /var -> /private/var. The
    // per-target Seatbelt grant uses the canonical path, so the worker's cwd
    // and its own workspace identity check must use that same spelling.
    const workDir = await realpath(this.options.workDir);
    const scratchRoot = resolve(
      defaultSandboxScratchRoot(this.options.workDir),
      "file-worker",
      operationId,
    );
    const request: FileWorkerRequest = {
      operationId,
      boundaryRevision: revision,
      operation,
      args,
      workDir,
      stagePath: resolve(scratchRoot, "prepared"),
      targets,
      excludeSensitiveFiles: this.options.excludeSensitiveFiles ?? false,
    };
    try {
      const response = await runFileWorker(
        request,
        [
          ...this.options.roots.list(),
          ...this.options.roots
            .boundarySnapshot()
            .filter((entry) => entry.access === "write")
            .map((entry) => entry.path),
          ...(sandbox.writeRoots ?? []),
        ],
        context?.signal,
        this.options.timeoutMs,
      );
      if (response.operationId !== operationId || response.boundaryRevision !== revision) {
        throw new Error("[file-worker:outcome_unknown] 响应与操作或任务边界不匹配，禁止重试写入");
      }
      if (!response.ok) throw new Error(response.error ?? "File Worker 执行失败");
      if (typeof response.result !== "string") {
        throw new Error("[file-worker:outcome_unknown] Worker 结果缺失");
      }
      const afterSandbox = this.options.resolveSandbox();
      if (
        (afterSandbox.bypass ?? afterSandbox.profile === "danger-full-access") ||
        (afterSandbox.generation ?? this.options.roots.generation()) !== revision
      ) {
        throw new SandboxViolationError(
          "sandbox_boundary_required",
          "执行期间任务边界已变化，请重新提交工具调用。",
        );
      }
      for (const target of targets) {
        if (!sameFileTargetIdentity(target.identity, await fileTargetIdentity(target.path))) {
          throw new Error(`File Worker 目标身份已变化: ${target.path}`);
        }
      }
      if (!write) {
        for (let i = 0; i < targets.length; i++) {
          const confirmed = await this.options.roots.assertAllowed(paths[i]!, { access: "read" });
          if (confirmed !== targets[i]!.path) throw new Error("读取期间目标真实路径发生变化");
        }
        return response.result;
      }
      if (
        !/^[a-f0-9]{64}$/u.test(response.preparedDigest ?? "") ||
        !Number.isSafeInteger(response.preparedBytes) ||
        response.preparedBytes! < 0
      ) {
        throw new Error("[file-worker:outcome_unknown] 写入准备结果缺少摘要或尺寸");
      }
      const stage = await readBoundedFileSnapshot(
        request.stagePath,
        Math.max(Buffer.byteLength(args) * 2, 64 * 1024 * 1024),
        request.stagePath,
      );
      const preparedContent = stage.content;
      if (
        Buffer.byteLength(preparedContent) !== response.preparedBytes ||
        createHash("sha256").update(preparedContent).digest("hex") !== response.preparedDigest
      ) {
        throw new Error("[file-worker:outcome_unknown] 暂存内容摘要与 Worker 响应不一致");
      }
      const target = targets[0]!;
      const originalPath = paths[0]!;
      // The Worker has no parent-directory write grant. The trusted host only publishes
      // its prepared bytes to the pre-bound exact target using the existing atomic helper.
      if (operation === "write_file") {
        if (preparedContent !== input.content) {
          throw new Error("File Worker 写入内容与原请求不一致");
        }
        await assertManagedParentDirectory(this.options.roots, originalPath, target.path);
      }
      const fullPath = await this.options.roots.assertAllowed(originalPath, { access: "write" });
      if (fullPath !== target.path) throw new Error("写入前目标真实路径发生变化");
      const precondition = await captureAtomicFilePrecondition(fullPath);
      if (!sameFileTargetIdentity(target.identity, await fileTargetIdentity(fullPath))) {
        throw new Error("写入前目标身份发生变化");
      }
      if (operation === "edit_file" && precondition.kind !== "file") {
        throw new Error("编辑目标已消失");
      }
      if (operation === "edit_file") {
        const current = await readBoundedFileSnapshot(fullPath, READ_FILE_MAX_BYTES, fullPath);
        if (
          !/^[a-f0-9]{64}$/u.test(response.sourceDigest ?? "") ||
          createHash("sha256").update(current.content).digest("hex") !== response.sourceDigest
        ) {
          throw new Error("编辑期间源文件内容已变化，请重新读取后重试");
        }
      }
      if (precondition.kind === "file") await access(fullPath, constants.W_OK);
      const beforeCommitSandbox = this.options.resolveSandbox();
      if (
        (beforeCommitSandbox.generation ?? this.options.roots.generation()) !== revision ||
        (beforeCommitSandbox.bypass ?? beforeCommitSandbox.profile === "danger-full-access")
      ) {
        throw new SandboxViolationError(
          "sandbox_boundary_required",
          "提交前任务边界已变化，请重新提交工具调用。",
        );
      }
      const commit: AtomicWorkspaceFileWrite = {
        targetPath: fullPath,
        content: preparedContent,
        precondition,
        revalidateTarget: async () => {
          const latest = this.options.resolveSandbox();
          if (
            (latest.generation ?? this.options.roots.generation()) !== revision ||
            (latest.bypass ?? latest.profile === "danger-full-access")
          ) {
            throw new SandboxViolationError(
              "sandbox_boundary_required",
              "提交期间任务边界已变化。",
            );
          }
          await assertSameResolvedTarget(this.options.roots, originalPath, fullPath);
          if (operation === "edit_file") {
            const current = await readBoundedFileSnapshot(fullPath, READ_FILE_MAX_BYTES, fullPath);
            if (
              createHash("sha256").update(current.content).digest("hex") !== response.sourceDigest
            ) {
              throw new Error("编辑期间源文件内容已变化，请重新读取后重试");
            }
          }
        },
      };
      if (process.platform === "win32") {
        const module = (await import(WINDOWS_FILE_COMMIT_MODULE)) as {
          commitWindowsFile(
            input: AtomicWorkspaceFileWrite & {
              scratchRoot: string;
              writableRoots: readonly string[];
              expectedSourceDigest?: string;
            },
          ): Promise<void>;
        };
        await module.commitWindowsFile({
          ...commit,
          ...(operation === "edit_file" ? { expectedSourceDigest: response.sourceDigest } : {}),
          scratchRoot,
          writableRoots: [
            ...this.options.roots.list(),
            ...this.options.roots
              .boundarySnapshot()
              .filter((entry) => entry.access === "write")
              .map((entry) => entry.path),
            ...(sandbox.writeRoots ?? []),
          ].filter((path) => existsSync(path)),
        });
      } else {
        await writeAtomicWorkspaceFile(commit);
      }
      if (operation === "edit_file") return response.result;
      const action = precondition.kind === "missing" ? "新建" : "覆盖";
      let artifactInfo = "";
      const artifact = input.artifact === true;
      if (
        (artifact || [".html", ".htm"].includes(extname(fullPath).toLowerCase())) &&
        this.options.artifacts
      ) {
        try {
          artifactInfo = `\n已登记生成文件: ${publishWrittenArtifact(this.options.artifacts, originalPath, preparedContent)}`;
        } catch (cause) {
          throw new Error(
            `文件已写入 ${originalPath}，但生成文件登记失败: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
      return `✅ ${action}文件: ${originalPath} (${preparedContent.length} 字符)${artifactInfo}`;
    } finally {
      await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Node path-based mkdir cannot exclude a concurrent parent-link swap; fail closed. */
async function assertManagedParentDirectory(
  roots: WorkspaceRoots,
  requestedPath: string,
  expectedPath: string,
): Promise<void> {
  await assertSameResolvedTarget(roots, requestedPath, expectedPath);
  const parent = dirname(expectedPath);
  const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new SandboxViolationError(
        "workspace_write_denied",
        "受限 File Worker 写入要求父目录已存在；请先在授权边界内创建目录。",
      );
    }
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent) {
    throw new Error(`父目录已被替换或不是普通目录: ${parent}`);
  }
  await assertSameResolvedTarget(roots, requestedPath, expectedPath);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function fileTargetIdentity(path: string): Promise<FileTargetIdentity> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() && !info.isDirectory()) throw new Error(`目标不是普通文件或目录: ${path}`);
    return {
      kind: info.isFile() ? "file" : "directory",
      dev: String(info.dev),
      ino: String(info.ino),
      size: String(info.size),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function runFileWorker(
  request: FileWorkerRequest,
  writablePaths: readonly string[],
  signal?: AbortSignal,
  timeoutMs = 90_000,
): Promise<FileWorkerResponse> {
  signal?.throwIfAborted();
  const electron = Boolean(process.versions.electron);
  let entry: string;
  let codeDirectories: string[];
  let args: string[];
  if (electron) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (!resourcesPath) {
      throw new SandboxViolationError("sandbox_unavailable", "桌面 File Worker 资源目录不存在。");
    }
    entry = resolve(resourcesPath, "file-worker", "file-worker.mjs");
    const expected = (await readFile(`${entry}.sha256`, "utf8")).trim().split(/\s/u)[0];
    const actual = createHash("sha256")
      .update(await readFile(entry))
      .digest("hex");
    if (!expected || expected !== actual) {
      throw new SandboxViolationError("sandbox_unavailable", "桌面 File Worker 资源摘要不匹配。");
    }
    const executableRoot =
      process.platform === "darwin"
        ? dirname(dirname(dirname(process.execPath)))
        : dirname(process.execPath);
    // Electron loads its Frameworks and helper libraries from its application
    // installation after dyld starts, so the executable alone is insufficient.
    codeDirectories = [dirname(entry), executableRoot];
    args = [entry];
  } else {
    const sourceUrl = new URL(import.meta.url);
    const suffix = sourceUrl.pathname.endsWith(".ts") ? ".ts" : ".js";
    entry = fileURLToPath(new URL(`./file-worker-main${suffix}`, sourceUrl));
    const moduleDir = dirname(fileURLToPath(sourceUrl));
    const packageRoot = resolve(moduleDir, "..");
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
  const codeRoots = await Promise.all(
    codeDirectories.map(async (path) => {
      const info = await lstat(path);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new SandboxViolationError(
          "sandbox_unavailable",
          `File Worker 受信目录不是目录: ${path}`,
        );
      }
      return realpath(path);
    }),
  );
  for (const path of [entry, ...(electron ? [`${entry}.sha256`] : [])]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SandboxViolationError("sandbox_unavailable", "File Worker 资源不是受信普通文件。");
    }
  }
  const trustedEntries = await Promise.all(
    [entry, ...(electron ? [`${entry}.sha256`] : []), process.execPath].map((path) =>
      realpath(path),
    ),
  );
  const canonicalWritable = await Promise.all(writablePaths.map(canonicalizePossiblyMissing));
  if (
    [...codeRoots, ...trustedEntries].some((trusted) =>
      canonicalWritable.some((writable) => within(writable, trusted) || within(trusted, writable)),
    )
  ) {
    throw new SandboxViolationError(
      "sandbox_unavailable",
      "File Worker 受信代码或运行时与模型可写工作区重叠，已拒绝启动。",
    );
  }
  const targets = request.targets;
  const scratchRoot = dirname(request.stagePath);
  const policy = createSandboxPolicy({
    profile: "read-only",
    workspaceRoots: [],
    scratchRoot,
    readRoots: [
      ...codeRoots,
      ...targets
        .filter((target) => target.identity.kind === "directory")
        .map((target) => target.path),
    ],
    readFiles: targets
      .filter((target) => target.identity.kind !== "directory")
      .map((target) => target.path),
    config: { network: "deny" },
    generation: request.boundaryRevision,
  });
  const { child, lease } = managedProcessLauncher.launch(
    {
      command: process.execPath,
      args,
      cwd: request.workDir,
      origin: "file-worker",
      policy,
      ...(electron
        ? {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            explicitEnvKeys: ["ELECTRON_RUN_AS_NODE"],
          }
        : {}),
    },
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return new Promise<FileWorkerResponse>((resolveResult, rejectResult) => {
    let dispatched = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      void lease
        .terminate()
        .catch(() => undefined)
        .finally(() =>
          rejectResult(
            new Error(`[file-worker:${dispatched ? "outcome_unknown" : "not_executed"}] ${reason}`),
          ),
        );
    };
    const cleanup = () => {
      deadline.cancel();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => fail("操作已取消");
    const deadline = scheduleDeadline(() => fail("Worker 超时"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 32 * 1024 * 1024) fail("Worker 响应过大");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.once("error", (error) => fail(error.message));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail(`Worker 退出 ${code}: ${stderr}`);
      try {
        const lines = stdout.trim().split("\n");
        if (lines.length !== 1) throw new Error("Worker 响应行数不正确");
        const response = JSON.parse(lines[0]!) as FileWorkerResponse;
        settled = true;
        cleanup();
        resolveResult(response);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
    child.stdin?.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) return fail(error.message);
      dispatched = true;
      child.stdin?.end();
    });
  });
}

async function canonicalizePossiblyMissing(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  for (;;) {
    try {
      return resolve(await realpath(ancestor), relative(ancestor, absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
