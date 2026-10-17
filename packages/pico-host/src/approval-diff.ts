import { readApprovedWriteFileSnapshot } from "./atomic-workspace-file.js";

export interface ApprovalDiffPathResolver {
  resolve(path: string): string;
  resolveUnchecked?(path: string): string;
}

/** Tool-layer primitives deliberately injected so the Host does not depend on a ToolRegistry. */
export interface ApprovalDiffToolPort {
  generateSimpleDiff(oldText: string, newText: string): string;
  safeResolve(workDir: string, input: string): string;
  readFileSnapshot?: (path: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * Computes a best-effort before/after preview for a human approval surface.
 * It must never make an approval fail: malformed input or filesystem errors return undefined.
 */
export async function computeApprovalDiff(
  toolName: string,
  args: string,
  workDir: string,
  workspaceRoots: ApprovalDiffPathResolver | undefined,
  tools: ApprovalDiffToolPort,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object") return undefined;
    const input = parsed as Record<string, unknown>;
    if (toolName === "edit_file") return computeEditFileDiff(input, tools, signal);
    if (toolName === "write_file")
      return await computeWriteFileDiff(input, workDir, workspaceRoots, tools, signal);
    if (toolName === "bash")
      return await computeBashDiff(input, workDir, workspaceRoots, tools, signal);
    return undefined;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return undefined;
  }
}

async function readFileOrEmpty(
  path: string,
  tools: ApprovalDiffToolPort,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const content = tools.readFileSnapshot
      ? await tools.readFileSnapshot(path, signal)
      : (await readApprovedWriteFileSnapshot(path, signal ? { signal } : {})).content;
    signal?.throwIfAborted();
    return content ?? "";
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function computeEditFileDiff(
  input: Record<string, unknown>,
  tools: ApprovalDiffToolPort,
  signal?: AbortSignal,
): string | undefined {
  const oldText = input["old_text"];
  const newText = input["new_text"];
  if (!isString(oldText) || !isString(newText)) return undefined;
  const diff = tools.generateSimpleDiff(oldText, newText);
  signal?.throwIfAborted();
  return diff;
}

async function computeWriteFileDiff(
  input: Record<string, unknown>,
  workDir: string,
  workspaceRoots: ApprovalDiffPathResolver | undefined,
  tools: ApprovalDiffToolPort,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const path = input["path"];
  const content = input["content"];
  if (!isString(path) || !isString(content)) return undefined;
  const absolutePath =
    workspaceRoots?.resolveUnchecked?.(path) ??
    workspaceRoots?.resolve(path) ??
    tools.safeResolve(workDir, path);
  const diff = tools.generateSimpleDiff(
    await readFileOrEmpty(absolutePath, tools, signal),
    content,
  );
  signal?.throwIfAborted();
  return diff;
}

async function computeBashDiff(
  input: Record<string, unknown>,
  workDir: string,
  workspaceRoots: ApprovalDiffPathResolver | undefined,
  tools: ApprovalDiffToolPort,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const command = input["command"];
  if (!isString(command)) return undefined;
  const match = command.match(/(?:>>|>)\s*([^\s|;&]+)\s*$/);
  if (!match) return undefined;
  const rawTarget = match[1];
  if (!rawTarget) return undefined;
  const target = rawTarget.replace(/^(?:"([^"]*)"|'([^']*)')$/u, "$1$2");
  const sourceCommand = command.slice(0, match.index).trim();
  const absoluteTarget =
    workspaceRoots?.resolveUnchecked?.(target) ??
    workspaceRoots?.resolve(target) ??
    tools.safeResolve(workDir, target);
  const diff = tools.generateSimpleDiff(
    await readFileOrEmpty(absoluteTarget, tools, signal),
    sourceCommand,
  );
  signal?.throwIfAborted();
  return diff;
}
