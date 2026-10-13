import { basename, resolve, relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { readBoundedFileSnapshot } from "./atomic-workspace-file.js";
import { isSensitiveCredentialPath } from "./session-permissions.js";
import { currentExecutionRunner } from "./execution-learning-runner.js";
import type { ExecutionAcceptanceClaim } from "@pico/core";
import type { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import {
  resolveExecutionLearningTarget,
  type ExecutionEvidenceIO,
} from "./execution-learning-evidence.js";

export function createExecutionLearningIO(
  workDir: string,
  scratchRoot?: string,
  authorize?: (path: string) => Promise<string>,
): ExecutionEvidenceIO {
  const contained = (root: string, path: string) => {
    const p = relative(resolve(root), resolve(path));
    return p === "" || (!p.startsWith("..") && !isAbsolute(p));
  };
  const workspaceRoot = realpath(workDir).catch(() => undefined);
  const scratchPhysical = scratchRoot
    ? realpath(scratchRoot).catch(() => undefined)
    : Promise.resolve(undefined);
  const canonical = async (path: string) => {
    const resolved = resolve(path);
    const workspace = await workspaceRoot,
      scratch = await scratchPhysical;
    if (
      !workspace ||
      isSensitiveCredentialPath(resolved) ||
      (!contained(workDir, resolved) &&
        !contained(workspace, resolved) &&
        !(scratchRoot && contained(scratchRoot, resolved)) &&
        !(scratch && contained(scratch, resolved)))
    )
      return undefined;
    const physical = await realpath(resolved);
    if (
      isSensitiveCredentialPath(physical) ||
      (!contained(workspace, physical) && !(scratch && contained(scratch, physical)))
    )
      return undefined;
    if (authorize && !(scratch && contained(scratch, physical))) await authorize(physical);
    return physical;
  };
  return {
    realpath: async (path) => {
      try {
        return await canonical(path);
      } catch {
        return undefined;
      }
    },
    readFile: async (path, maxBytes) => {
      try {
        const physical = await canonical(path);
        return physical
          ? (await readBoundedFileSnapshot(physical, maxBytes, physical)).content
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** A concrete entry/test identity must match before a verified operation can become context. */
export async function executionLearningRecallTargets(
  store: SqliteMemoryItemStore,
  workspaceKey: string,
  io: ExecutionEvidenceIO,
  query: string | undefined,
  executionTargetId?: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly { targetId: string; scopeHash: string }[]> {
  const result: { targetId: string; scopeHash: string }[] = [];
  for (const candidate of await store.executionLearning.listExecutionLearningCandidates(
    workspaceKey,
  )) {
    if (candidate.state !== "saved") continue;
    if (await executionClaimMatches(candidate.claim, io, query, executionTargetId, env))
      result.push({
        targetId: candidate.claim.target.targetId,
        scopeHash: candidate.claim.target.scopeHash,
      });
    if (result.length >= 1) break;
  }
  return result;
}

/** Shared scope guard for historical native memories and reviewed native attachments. */
export async function executionClaimMatches(
  claim: ExecutionAcceptanceClaim,
  io: ExecutionEvidenceIO,
  query: string | undefined,
  executionTargetId?: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<boolean> {
  const target = claim.target;
  const names = [
    target.label,
    ...target.entryFiles.map((f) => basename(f.path)),
    ...claim.failedTestIds.flatMap((id) => {
      try {
        const parts: unknown = JSON.parse(id);
        return Array.isArray(parts) && typeof parts.at(-1) === "string"
          ? [String(parts.at(-1))]
          : [];
      } catch {
        return [];
      }
    }),
  ].filter((name) => name.length >= 4);
  if (
    executionTargetId
      ? executionTargetId !== target.targetId
      : !query || !names.some((name) => query.includes(name))
  )
    return false;
  if (claim.predicateId === "test-target-pass.v1") {
    const recorded = claim.runner;
    if (!recorded?.fingerprint) return false;
    const currentRunner = await currentExecutionRunner(target.argv[0]!, target.cwd, env);
    if (
      currentRunner?.execPath !== recorded.execPath ||
      currentRunner.fingerprint !== recorded.fingerprint
    )
      return false;
  }
  const current = await resolveExecutionLearningTarget(target.command, target.cwd, io);
  return current?.scopeHash === target.scopeHash;
}
