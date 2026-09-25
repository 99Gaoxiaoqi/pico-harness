/** One request per OS-sandboxed process. No host authority, archive or artifact handle enters here. */
import { lstat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { ReadFileTool } from "./read-file-tool.js";
import { GlobTool } from "./glob-tool.js";
import { GrepTool } from "./grep-tool.js";
import { ExploreRepoTool } from "./explore-repo-tool.js";
import { formatEditResult, prepareEditContent } from "./edit-file-tool.js";
import { readBoundedFileSnapshot } from "./atomic-workspace-file.js";
import { READ_FILE_MAX_BYTES } from "./file-tool-helpers.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import type {
  FileTargetIdentity,
  FileWorkerRequest,
  FileWorkerResponse,
} from "./file-worker-protocol.js";
import { sameFileTargetIdentity } from "./file-worker-protocol.js";

async function identity(path: string): Promise<FileTargetIdentity> {
  try {
    const info = await lstat(path, { bigint: true });
    return {
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "missing",
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

async function execute(request: FileWorkerRequest): Promise<FileWorkerResponse> {
  if (!/^[a-f0-9-]{36}$/u.test(request.operationId)) throw new Error("无效的 File Worker 操作 ID");
  if (!Number.isSafeInteger(request.boundaryRevision) || request.boundaryRevision < 0) {
    throw new Error("无效的任务边界版本");
  }
  for (const target of request.targets) {
    if (!sameFileTargetIdentity(target.identity, await identity(target.path))) {
      throw new Error(`File Worker 目标身份已变化: ${target.path}`);
    }
  }
  const roots = WorkspaceRoots.createSync(request.workDir);
  roots.replaceBoundaryEntries(
    request.targets.map((target) => ({
      path: target.path,
      access:
        request.operation === "write_file" || request.operation === "edit_file" ? "write" : "read",
      scope: target.identity.kind === "directory" ? "subtree" : "exact",
    })),
  );
  const input = JSON.parse(request.args) as Record<string, unknown>;
  const single = request.targets[0];
  if (request.operation !== "explore_repo" && single) {
    const requested = typeof input.path === "string" ? input.path : ".";
    if (roots.resolveUnchecked(requested) !== single.path) {
      throw new Error("File Worker 请求目标与授权目标不一致");
    }
  }
  let result: string;
  let preparedContent: string | undefined;
  switch (request.operation) {
    case "read_file":
      result = await new ReadFileTool(roots).execute(request.args);
      break;
    case "glob":
      result = await new GlobTool(roots).execute(request.args);
      break;
    case "grep":
      result = await new GrepTool(roots, {
        excludeSensitiveFiles: request.excludeSensitiveFiles,
      }).execute(request.args);
      break;
    case "explore_repo": {
      const requestedRoots = Array.isArray(input.roots) ? input.roots.slice(0, 5) : ["."];
      if (requestedRoots.length !== request.targets.length) {
        throw new Error("File Worker 搜索根与授权目标不一致");
      }
      for (let i = 0; i < requestedRoots.length; i++) {
        if (roots.resolveUnchecked(String(requestedRoots[i])) !== request.targets[i]?.path) {
          throw new Error("File Worker 搜索根与授权目标不一致");
        }
      }
      result = await new ExploreRepoTool(request.workDir, undefined).execute(request.args);
      break;
    }
    case "write_file": {
      if (typeof input.content !== "string") throw new Error("content 必须是字符串");
      preparedContent = input.content;
      result = "prepared";
      break;
    }
    case "edit_file": {
      if (single?.identity.kind !== "file") throw new Error("编辑目标不是已有普通文件");
      const oldText = String(input.old_text ?? "");
      const newText = String(input.new_text ?? "");
      const snapshot = await readBoundedFileSnapshot(single.path, READ_FILE_MAX_BYTES, single.path);
      const prepared = prepareEditContent(
        snapshot.content,
        oldText,
        newText,
        input.replace_all === true,
      );
      preparedContent = prepared.content;
      result = formatEditResult(
        String(input.path ?? ""),
        prepared.level,
        oldText,
        newText,
        input.replace_all === true,
      );
      break;
    }
  }
  if (preparedContent !== undefined) {
    await writeFile(request.stagePath, preparedContent, { flag: "wx", mode: 0o600 });
  }
  return {
    operationId: request.operationId,
    boundaryRevision: request.boundaryRevision,
    ok: true,
    result,
    ...(preparedContent !== undefined
      ? {
          preparedDigest: createHash("sha256").update(preparedContent).digest("hex"),
          preparedBytes: Buffer.byteLength(preparedContent),
        }
      : {}),
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let received = false;
for await (const line of lines) {
  if (received) break;
  received = true;
  let request: FileWorkerRequest | undefined;
  let response: FileWorkerResponse;
  try {
    request = JSON.parse(line) as FileWorkerRequest;
    response = await execute(request);
  } catch (error) {
    response = {
      operationId: request?.operationId ?? "",
      boundaryRevision: request?.boundaryRevision ?? -1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
