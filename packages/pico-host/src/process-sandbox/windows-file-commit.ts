import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scheduleDeadline } from "@pico/runtime/deadline";
import type { AtomicWorkspaceFileWrite } from "../atomic-workspace-file.js";
import { isWithinRoot } from "./policy.js";
import { isVerifiedBundledExecutable, resolveBundledSandboxExecutable } from "./backend.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const COMMIT_TIMEOUT_MS = 60_000;

export interface WindowsFileCommitInput extends AtomicWorkspaceFileWrite {
  readonly scratchRoot: string;
  readonly expectedSourceDigest?: string;
  /** All roots that the restricted worker or model-controlled shell may write. */
  readonly writableRoots: readonly string[];
}

export class WindowsFileCommitError extends Error {
  override readonly name = "WindowsFileCommitError";

  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The trusted broker forks a fixed helper with a clean environment. The helper uses Pico's
 * existing Windows atomic writer, including DACL/ADS preservation and uncertain-state recovery.
 * A dispatched failure is never safe for the caller to retry automatically.
 */
export async function commitWindowsFile(input: WindowsFileCommitInput): Promise<void> {
  if (process.platform !== "win32") {
    throw new WindowsFileCommitError("Windows 文件提交只支持 win32", false);
  }
  if (!isAbsolute(input.targetPath)) {
    throw new WindowsFileCommitError("Windows 文件提交目标必须是绝对路径", false);
  }
  const broker = resolveBundledSandboxExecutable("win32", process.arch);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const helper = resourcesPath
    ? resolve(resourcesPath, "file-worker", "windows-file-commit-entry.mjs")
    : fileURLToPath(
        new URL("../../../../resources/file-worker/windows-file-commit-entry.mjs", import.meta.url),
      );
  const node = process.execPath;
  if (!isVerifiedBundledExecutable(broker, "win32")) {
    throw new WindowsFileCommitError("Windows Broker 完整性校验失败", false);
  }
  const helperInfo = await lstat(helper).catch(() => {
    throw new WindowsFileCommitError("Windows 文件提交资源不存在", false);
  });
  if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) {
    throw new WindowsFileCommitError("Windows 文件提交资源不是受信普通文件", false);
  }
  const expectedDigest = (
    await readFile(`${helper}.sha256`).catch(() => {
      throw new WindowsFileCommitError("Windows 文件提交摘要不存在", false);
    })
  )
    .toString("utf8")
    .trim()
    .split(/\s/u)[0];
  const actualDigest = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex");
  if (!expectedDigest || expectedDigest !== actualDigest) {
    throw new WindowsFileCommitError("Windows 文件提交资源摘要不匹配", false);
  }
  const trustedPaths = await Promise.all(
    [broker, helper, node, `${helper}.sha256`].map(async (path) => {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new WindowsFileCommitError(`受信执行文件不是普通文件: ${path}`, false);
      }
      return await realpath(path);
    }),
  );
  const writableRoots = await Promise.all(
    [...input.writableRoots, input.scratchRoot].map(async (root) => await realpath(root)),
  );
  for (const trustedPath of trustedPaths) {
    if (writableRoots.some((root) => isWithinRoot(root, trustedPath))) {
      throw new WindowsFileCommitError(`受信提交程序位于目标进程可写目录: ${trustedPath}`, false);
    }
  }
  await input.revalidateTarget();
  const targetPath = resolve(input.targetPath);
  const boundParent = await realpath(dirname(targetPath));
  const boundParentInfo = await lstat(boundParent, { bigint: true });
  if (!boundParentInfo.isDirectory() || boundParentInfo.isSymbolicLink()) {
    throw new WindowsFileCommitError("Windows 文件父目录不是普通目录", false);
  }
  const request = JSON.stringify(
    {
      targetPath,
      boundParent,
      boundParentIdentity: {
        dev: boundParentInfo.dev,
        ino: boundParentInfo.ino,
      },
      content: input.content,
      precondition: input.precondition,
      ...(input.expectedSourceDigest ? { expectedSourceDigest: input.expectedSourceDigest } : {}),
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
    throw new WindowsFileCommitError("Windows 文件提交请求超过 64 MiB", false);
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      trustedPaths[0]!,
      [
        "--commit-file",
        "--node",
        trustedPaths[2]!,
        "--helper",
        trustedPaths[1]!,
        "--target",
        targetPath,
      ],
      {
        cwd: dirname(trustedPaths[0]!),
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let dispatched = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = scheduleDeadline(() => {
      child.kill("SIGKILL");
      finish(new WindowsFileCommitError("Windows Broker 文件提交超时，结果未知", true));
    }, COMMIT_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      timeout.cancel();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.once("error", (error) => {
      finish(
        new WindowsFileCommitError("Windows Broker 无法启动文件提交", dispatched, { cause: error }),
      );
    });
    child.once("close", (code) => {
      if (code === 0 && stdout.trim() === "OK") {
        finish();
      } else {
        finish(
          new WindowsFileCommitError(
            `Windows Broker 文件提交失败，结果未知 (exit=${String(code)}; ${stderr.trim()})`,
            dispatched,
          ),
        );
      }
    });
    child.stdin?.once("error", (error) => {
      finish(
        new WindowsFileCommitError("Windows Broker 请求传输失败，结果未知", true, { cause: error }),
      );
    });
    dispatched = true;
    child.stdin?.end(request);
  });
}
