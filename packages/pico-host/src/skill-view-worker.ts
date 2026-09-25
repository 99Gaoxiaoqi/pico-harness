import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SandboxViolationError } from "./process-sandbox/index.js";
import {
  canonicalizePossiblyMissing,
  fileTargetIdentity,
  runFileWorker,
} from "./file-worker-tool.js";
import {
  sameFileTargetIdentity,
  type FileTargetIdentity,
  type FileWorkerRequest,
} from "./file-worker-protocol.js";

/** Captured while the trusted Host builds its skill catalog, never from model arguments. */
export interface DiscoveredSkillSource {
  readonly sourcePath: string;
  readonly sourceRoot: string;
  readonly physicalPath: string;
  readonly physicalRoot: string;
  readonly fileIdentity: FileTargetIdentity;
  readonly rootIdentity: FileTargetIdentity;
  readonly contentDigest: string;
}

export async function captureDiscoveredSkillSource(
  sourcePath: string,
  sourceRoot: string,
): Promise<Omit<DiscoveredSkillSource, "contentDigest">> {
  const [physicalPath, physicalRoot] = await Promise.all([
    realpath(sourcePath),
    realpath(sourceRoot),
  ]);
  if (!within(physicalRoot, physicalPath)) {
    throw new SandboxViolationError("sandbox_boundary_required", "技能来源超出已解析的技能目录。");
  }
  const [fileIdentity, rootIdentity] = await Promise.all([
    fileTargetIdentity(physicalPath),
    fileTargetIdentity(physicalRoot),
  ]);
  if (fileIdentity.kind !== "file" || rootIdentity.kind === "missing") {
    throw new SandboxViolationError("sandbox_boundary_required", "技能来源不是受信普通文件。");
  }
  return {
    sourcePath,
    sourceRoot,
    physicalPath,
    physicalRoot,
    fileIdentity,
    rootIdentity,
  };
}

/** Metadata-only Host check; the contents are read only inside File Worker. */
export async function verifyDiscoveredSkillSource(source: DiscoveredSkillSource): Promise<void> {
  const [path, root] = await Promise.all([
    realpath(source.sourcePath),
    realpath(source.sourceRoot),
  ]);
  const [fileIdentity, rootIdentity] = await Promise.all([
    fileTargetIdentity(source.physicalPath),
    fileTargetIdentity(source.physicalRoot),
  ]);
  if (
    path !== source.physicalPath ||
    root !== source.physicalRoot ||
    !within(root, path) ||
    !sameFileTargetIdentity(source.fileIdentity, fileIdentity) ||
    !sameFileTargetIdentity(source.rootIdentity, rootIdentity)
  ) {
    throw new SandboxViolationError(
      "sandbox_boundary_required",
      "技能来源身份已变化，请刷新技能目录。",
    );
  }
}

export interface SkillWorkerReadOptions {
  readonly workDir: string;
  readonly boundaryRevision: number;
  readonly writablePaths: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function readDiscoveredSkillViaWorker(
  source: DiscoveredSkillSource,
  options: SkillWorkerReadOptions,
): Promise<string> {
  if (!Number.isSafeInteger(options.boundaryRevision) || options.boundaryRevision < 0) {
    throw new SandboxViolationError(
      "sandbox_boundary_required",
      "技能读取缺少有效的任务边界版本。",
    );
  }
  await verifyDiscoveredSkillSource(source);
  const operationId = randomUUID();
  const scratchRoot = await mkdtemp(resolve(tmpdir(), "pico-skill-worker-"));
  try {
    // A private cwd lets an exact-file grant work without exposing the workspace directory.
    const workDir = await realpath(scratchRoot);
    const canonicalWritable = await Promise.all(
      options.writablePaths.map(canonicalizePossiblyMissing),
    );
    if (canonicalWritable.some((path) => within(path, workDir) || within(workDir, path))) {
      throw new SandboxViolationError(
        "sandbox_unavailable",
        "技能 Worker 私有目录与任务可写目录重叠。",
      );
    }
    const workDirIdentity = await fileTargetIdentity(workDir);
    if (workDirIdentity.kind !== "directory") {
      throw new SandboxViolationError("sandbox_unavailable", "技能 Worker 工作目录不可用。");
    }
    const request: FileWorkerRequest = {
      operationId,
      boundaryRevision: options.boundaryRevision,
      operation: "skill_view",
      args: JSON.stringify({ path: source.physicalPath }),
      workDir,
      workDirIdentity,
      ...(process.platform === "linux" ? { syntheticCwd: true } : {}),
      stagePath: resolve(scratchRoot, "prepared"),
      targets: [{ path: source.physicalPath, identity: source.fileIdentity }],
      excludeSensitiveFiles: false,
    };
    const response = await runFileWorker(
      request,
      options.writablePaths,
      options.signal,
      options.timeoutMs,
    );
    if (
      response.operationId !== operationId ||
      response.boundaryRevision !== options.boundaryRevision ||
      !response.ok ||
      typeof response.result !== "string"
    ) {
      throw new SandboxViolationError(
        "sandbox_boundary_required",
        response.error ?? "技能 Worker 响应无效。",
      );
    }
    await verifyDiscoveredSkillSource(source);
    if (createHash("sha256").update(response.result).digest("hex") !== source.contentDigest) {
      throw new SandboxViolationError(
        "sandbox_boundary_required",
        "技能正文与已解析目录不一致，请刷新技能目录。",
      );
    }
    return response.result;
  } finally {
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
