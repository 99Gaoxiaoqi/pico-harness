import type { SessionManager } from "../engine/session-manager.js";
import type { SessionOptions } from "../engine/session.js";
import { tmpdir } from "node:os";
import {
  assessSandboxBoundaryExpansion,
  executionBoundaryContains,
  type ExecutionBoundary,
  type FileSystemSandboxEntry,
  type ManagedPermissionProfile,
  type SandboxBoundaryFilesystemEntry,
} from "../safety/permission-profile.js";

export interface BindAgentGraphOperatorExecutionBoundaryInput {
  readonly sessionManager: SessionManager;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly parentWorkDir: string;
  readonly childWorkDir: string;
  readonly workspacePolicy: "shared" | "isolated-worktree";
  readonly sessionOptions?: SessionOptions;
}

/** Bind or verify the child authority before exact-run admission. */
export async function bindAgentGraphOperatorExecutionBoundary(
  input: BindAgentGraphOperatorExecutionBoundaryInput,
): Promise<{ readonly parent: ExecutionBoundary; readonly child: ExecutionBoundary }> {
  if (input.childSessionId === input.rootSessionId) {
    throw new Error("Graph Operator Session must differ from its root Session");
  }
  if (input.workspacePolicy === "shared" && input.childWorkDir !== input.parentWorkDir) {
    throw new Error(
      "Graph Operator workDir differs from its parent execution boundary; containment cannot be proven",
    );
  }

  const rootLease = await input.sessionManager.getOrCreatePinned(
    input.rootSessionId,
    input.parentWorkDir,
    input.sessionOptions,
  );
  let childLease: Awaited<ReturnType<SessionManager["getOrCreatePinned"]>> | undefined;
  try {
    childLease = await input.sessionManager.getOrCreatePinned(
      input.childSessionId,
      input.childWorkDir,
      input.sessionOptions,
    );
    const parent = rootLease.session.getRuntimeStateSnapshot().boundary;
    if (!parent) throw new Error("Graph root Session has no durable execution boundary");
    if (parent.kind === "external") {
      throw new Error("Graph Operator cannot inherit an external execution boundary");
    }
    const ceiling =
      parent.kind === "managed"
        ? structuredClone(parent)
        : {
            kind: "bypass" as const,
            revision: parent.revision,
          };

    const existing = childLease.session.getRuntimeStateSnapshot().boundary;
    if (existing) {
      if (parent.kind === "bypass") {
        if (existing.kind === "external") {
          throw new Error("Graph Operator cannot replace an external execution boundary");
        }
        if (existing.kind === "bypass") {
          return { parent: structuredClone(parent), child: structuredClone(existing) };
        }
        childLease.session.updateRuntimeState({ boundary: ceiling });
        await childLease.session.flushPersistence();
        const persisted = childLease.session.getRuntimeStateSnapshot().boundary;
        if (!persisted || persisted.kind !== "bypass") {
          throw new Error("Graph Operator full-access boundary was not durably inherited");
        }
        return { parent: structuredClone(parent), child: structuredClone(persisted) };
      }
      if (existing.kind !== "managed") {
        throw new Error(`Graph Operator cannot run with a ${existing.kind} execution boundary`);
      }
      if (!executionBoundaryContainsForChildWorkspace(ceiling, existing, input.childWorkDir)) {
        throw new Error("Graph Operator execution boundary exceeds its parent boundary");
      }
      return { parent: structuredClone(parent), child: structuredClone(existing) };
    }

    childLease.session.updateRuntimeState({ boundary: ceiling });
    await childLease.session.flushPersistence();
    const persisted = childLease.session.getRuntimeStateSnapshot().boundary;
    if (
      !persisted ||
      persisted.kind !== ceiling.kind ||
      !executionBoundaryContainsForChildWorkspace(ceiling, persisted, input.childWorkDir)
    ) {
      throw new Error("Graph Operator execution boundary was not durably inherited");
    }
    return { parent: structuredClone(parent), child: structuredClone(persisted) };
  } finally {
    childLease?.release();
    rootLease.release();
  }
}

/** Compare symbolic roots in the child workspace's context, not the parent's workDir. */
function executionBoundaryContainsForChildWorkspace(
  ceiling: ExecutionBoundary,
  child: ExecutionBoundary,
  childWorkDir: string,
): boolean {
  if (executionBoundaryContains(ceiling, child)) return true;
  if (ceiling.kind !== "managed" || child.kind !== "managed") return false;
  if (child.profile.network.kind === "enabled" && ceiling.profile.network.kind !== "enabled") {
    return false;
  }
  if (
    child.profile.fileSystem.kind === "unrestricted" &&
    ceiling.profile.fileSystem.kind !== "unrestricted"
  ) {
    return false;
  }
  if (!restrictionsContain(ceiling.profile, child.profile)) return false;

  const context = {
    root: childWorkDir,
    workspaceRoots: [childWorkDir],
    tmpdir: tmpdir(),
    slashTmp: "/tmp",
  };
  return child.profile.fileSystem.entries
    .filter((entry) => entry.access !== "deny")
    .every((entry) => {
      const expansions = childEntryExpansions(entry, childWorkDir);
      return (
        expansions !== undefined &&
        expansions.every(
          (expansion) =>
            assessSandboxBoundaryExpansion(
              ceiling.profile,
              { filesystem: { entries: [expansion] } },
              context,
            ).outcome === "noop",
        )
      );
    });
}

function restrictionsContain(
  ceiling: ManagedPermissionProfile,
  child: ManagedPermissionProfile,
): boolean {
  const onlyRestrictions = (profile: ManagedPermissionProfile): ExecutionBoundary => ({
    kind: "managed",
    revision: 0,
    profile: {
      ...profile,
      network: { kind: "restricted" },
      fileSystem: {
        kind: "restricted",
        entries: profile.fileSystem.entries.filter((entry) => entry.access === "deny"),
        ...(profile.fileSystem.protectedMetadata
          ? { protectedMetadata: profile.fileSystem.protectedMetadata }
          : {}),
      },
    },
  });
  return executionBoundaryContains(onlyRestrictions(ceiling), onlyRestrictions(child));
}

function childEntryExpansions(
  entry: FileSystemSandboxEntry,
  childWorkDir: string,
): readonly SandboxBoundaryFilesystemEntry[] | undefined {
  if (entry.access === "deny") return undefined;
  if (entry.kind === "path") {
    return [{ path: entry.path, access: entry.access, scope: entry.match ?? "subtree" }];
  }
  const path =
    entry.special === ":root" || entry.special === ":workspace_roots"
      ? childWorkDir
      : entry.special === ":tmpdir"
        ? tmpdir()
        : entry.special === ":slash_tmp"
          ? "/tmp"
          : undefined;
  // :minimal is host-specific. Only the direct symbolic comparison above can prove it safe.
  return path ? [{ path, access: entry.access, scope: "subtree" }] : undefined;
}
