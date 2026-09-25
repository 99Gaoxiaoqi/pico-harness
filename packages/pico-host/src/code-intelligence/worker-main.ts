import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { WorkspaceRoots } from "../workspace-roots.js";
import { RepoMapService } from "./repo-map.js";
import type {
  CodeIntelligenceWorkerCall,
  CodeIntelligenceWorkerRequest,
  CodeIntelligenceWorkerResponse,
  WorkerDocument,
} from "./worker-protocol.js";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "null") as {
    rootDir?: unknown;
    rootIdentity?: unknown;
    roots?: unknown;
    rootIdentities?: unknown;
    generation?: unknown;
  } | null;
  if (
    !config ||
    typeof config.rootDir !== "string" ||
    typeof config.rootIdentity !== "string" ||
    !Array.isArray(config.roots) ||
    !config.roots.every((root) => typeof root === "string") ||
    !Array.isArray(config.rootIdentities) ||
    config.rootIdentities.length !== config.roots.length ||
    !config.rootIdentities.every((value) => typeof value === "string") ||
    !Number.isSafeInteger(config.generation)
  ) {
    throw new Error("代码智能 Worker 初始化参数无效");
  }
  const generation = config.generation as number;
  const preboundPaths = process.platform === "win32";
  const rootDir = preboundPaths ? config.rootDir : await realpath(config.rootDir);
  if (
    path.resolve(config.rootDir) !== rootDir ||
    (await identity(rootDir)) !== config.rootIdentity
  ) {
    throw new Error("代码智能 Worker 工作区真实路径不匹配");
  }
  const boundRoots = (config.roots as string[]).map(
    (root, index) => [root, (config.rootIdentities as string[])[index]!] as const,
  );
  boundRoots.push([rootDir, config.rootIdentity]);
  await assertRoots(boundRoots);
  const roots = preboundPaths
    ? WorkspaceRoots.createPreboundReadOnly(rootDir, config.roots as string[])
    : await WorkspaceRoots.create(rootDir, config.roots as string[]);
  const repoMap = new RepoMapService(rootDir, undefined, roots, preboundPaths);
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("代码智能 Worker 请求过大");
      let request: CodeIntelligenceWorkerRequest;
      try {
        request = JSON.parse(line) as CodeIntelligenceWorkerRequest;
      } catch {
        throw new Error("代码智能 Worker 请求不是 JSON");
      }
      const response = await respond(request, generation, rootDir, boundRoots, repoMap, roots);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    await repoMap.close();
  }
}

async function respond(
  request: CodeIntelligenceWorkerRequest,
  generation: number,
  rootDir: string,
  boundRoots: readonly (readonly [string, string])[],
  repoMap: RepoMapService,
  roots: WorkspaceRoots,
): Promise<CodeIntelligenceWorkerResponse> {
  const base = { id: request.id, generation };
  try {
    if (!Number.isSafeInteger(request.id) || request.id < 1 || request.generation !== generation) {
      throw new Error("代码智能 Worker 请求与任务边界不匹配");
    }
    await assertRoots(boundRoots);
    const result = await execute(request.call, rootDir, repoMap, roots);
    await assertRoots(boundRoots);
    return { ...base, ok: true, result };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function execute(
  call: CodeIntelligenceWorkerCall,
  rootDir: string,
  repoMap: RepoMapService,
  roots: WorkspaceRoots,
): Promise<unknown> {
  switch (call.operation) {
    case "snapshot":
      return repoMap.snapshot({
        ...(call.query ? { query: call.query } : {}),
        ...(call.maxFiles ? { maxFiles: call.maxFiles } : {}),
      });
    case "definitions":
      return repoMap.definitions(call.query);
    case "references":
      return repoMap.references(call.query);
    case "symbols":
      return repoMap.symbols(call.query);
    case "diagnostics":
      return repoMap.diagnostics(call.filePath);
    case "callHierarchy":
      return repoMap.callHierarchy(call.query, call.direction);
    case "readDocument":
      return readDocument(rootDir, roots, call.filePath);
    case "rootEntries":
      return readdir(rootDir);
  }
}

async function readDocument(
  rootDir: string,
  roots: WorkspaceRoots,
  filePath: string,
): Promise<WorkerDocument> {
  const requestedPath = path.resolve(rootDir, filePath);
  if ((await lstat(requestedPath)).isSymbolicLink()) {
    throw new Error("代码智能拒绝读取链接文件");
  }
  const requestedIdentity = await identity(requestedPath);
  const physicalPath = await roots.assertAllowed(filePath);
  const handle = await open(physicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_DOCUMENT_BYTES)) {
      throw new Error(`代码智能只能读取不超过 ${MAX_DOCUMENT_BYTES} 字节的普通文件: ${filePath}`);
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("代码智能文档读取期间目标身份发生变化");
    }
    if (
      (await identity(requestedPath)) !== requestedIdentity ||
      (await roots.assertAllowed(filePath)) !== physicalPath ||
      (await identity(physicalPath)) !== fileIdentity(after)
    ) {
      throw new Error("代码智能文档读取期间路径被替换");
    }
    return { filePath: physicalPath, text };
  } finally {
    await handle.close();
  }
}

function fileIdentity(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function identity(target: string): Promise<string> {
  const info = await lstat(target, { bigint: true });
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
    throw new Error(`代码智能目标不是普通文件或目录: ${target}`);
  }
  return fileIdentity(info);
}

async function assertRoots(roots: readonly (readonly [string, string])[]): Promise<void> {
  for (const [root, expected] of roots) {
    if (
      (await identity(root)) !== expected ||
      (process.platform !== "win32" && (await realpath(root)) !== root)
    ) {
      throw new Error("代码智能 Worker 工作区根身份已变化");
    }
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
