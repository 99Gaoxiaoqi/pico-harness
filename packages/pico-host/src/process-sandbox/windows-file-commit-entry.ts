import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  writeAtomicWorkspaceFile,
  type AtomicFilePrecondition,
} from "../atomic-workspace-file.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

async function main(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows commit helper only supports win32");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("commit request exceeds 64 MiB");
    chunks.push(bytes);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(request) ||
      typeof request.targetPath !== "string" ||
      typeof request.boundParent !== "string" ||
      typeof request.content !== "string" ||
      !isAbsolute(request.targetPath) ||
      !isAbsolute(request.boundParent)) {
    throw new Error("invalid commit request");
  }
  const targetPath = resolve(request.targetPath);
  const brokerTarget = process.env.PICO_COMMIT_BOUND_TARGET;
  if (!brokerTarget || normalizeWindowsPath(brokerTarget) !== normalizeWindowsPath(targetPath)) {
    throw new Error("commit target differs from Broker-bound target");
  }
  const boundParent = resolve(request.boundParent);
  if (!isRecord(request.boundParentIdentity) ||
      typeof request.boundParentIdentity.dev !== "string" ||
      typeof request.boundParentIdentity.ino !== "string" ||
      !/^\d{1,20}$/u.test(request.boundParentIdentity.dev) ||
      !/^\d{1,20}$/u.test(request.boundParentIdentity.ino)) {
    throw new Error("invalid commit parent identity");
  }
  const boundParentDev = BigInt(request.boundParentIdentity.dev);
  const boundParentIno = BigInt(request.boundParentIdentity.ino);
  const precondition = decodePrecondition(request.precondition);
  const revalidateTarget = async (): Promise<void> => {
    const currentParent = await realpath(dirname(targetPath));
    if (normalizeWindowsPath(currentParent) !== normalizeWindowsPath(boundParent)) {
      throw new Error("Windows commit parent changed");
    }
    const currentParentInfo = await lstat(currentParent, { bigint: true });
    if (!currentParentInfo.isDirectory() || currentParentInfo.isSymbolicLink() ||
        currentParentInfo.dev !== boundParentDev || currentParentInfo.ino !== boundParentIno) {
      throw new Error("Windows commit parent identity changed");
    }
    try {
      const info = await lstat(targetPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Windows commit target is not a regular file");
      }
      const currentTarget = await realpath(targetPath);
      if (normalizeWindowsPath(currentTarget) !== normalizeWindowsPath(targetPath)) {
        throw new Error("Windows commit target resolved elsewhere");
      }
    } catch (error) {
      if (precondition.kind === "missing" && hasErrnoCode(error, "ENOENT")) return;
      throw error;
    }
  };
  await writeAtomicWorkspaceFile({ targetPath, content: request.content, precondition, revalidateTarget });
  stdout.write("OK\n");
}

function decodePrecondition(value: unknown): AtomicFilePrecondition {
  if (!isRecord(value)) throw new Error("invalid commit precondition");
  if (value.kind === "missing") return { kind: "missing" };
  if (value.kind !== "file" || !isRecord(value.version) ||
      typeof value.permissionMode !== "number" ||
      !Number.isInteger(value.permissionMode) ||
      value.permissionMode < 0 || value.permissionMode > 0o777) {
    throw new Error("invalid commit file precondition");
  }
  const version = value.version;
  const parseField = (field: string): bigint => {
    const raw = version[field];
    if (typeof raw !== "string" || !/^\d{1,20}$/u.test(raw)) {
      throw new Error(`invalid commit file precondition: ${field}`);
    }
    return BigInt(raw);
  };
  return {
    kind: "file",
    version: {
      dev: parseField("dev"),
      ino: parseField("ino"),
      mode: parseField("mode"),
      uid: parseField("uid"),
      gid: parseField("gid"),
      size: parseField("size"),
      mtimeNs: parseField("mtimeNs"),
      ctimeNs: parseField("ctimeNs"),
    },
    permissionMode: value.permissionMode,
  };
}

function normalizeWindowsPath(path: string): string {
  return resolve(path)
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\/u, "")
    .toLocaleLowerCase("en-US");
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  process.stderr.write(`pico-windows-file-commit: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
