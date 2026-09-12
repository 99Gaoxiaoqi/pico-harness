import type { SessionManager } from "../engine/session-manager.js";
import type { SessionOptions } from "../engine/session.js";
import type {
  PersistedSessionSettings,
  PersistedSessionSettingsWrite,
} from "../engine/session-runtime.js";
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
  /** Production-only current settings, resolved from the immutable Operator profile. */
  readonly createChildSettings?: (input: {
    readonly permissionMode: "ask" | "full-access";
  }) => PersistedSessionSettingsWrite;
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
    const childSession = childLease.session;
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

    const snapshot = childSession.getRuntimeStateSnapshot();
    const existing = snapshot.boundary;
    const existingSettings = snapshot.settings;
    if (
      input.createChildSettings &&
      (existing === undefined) !== (existingSettings === undefined)
    ) {
      throw new Error("Graph Operator Session has an incomplete current runtime state");
    }

    let aligned = ceiling;
    let boundaryChanged = existing === undefined;
    if (existing) {
      if (parent.kind === "bypass") {
        if (existing.kind === "external") {
          throw new Error("Graph Operator cannot replace an external execution boundary");
        }
        if (existing.kind === "bypass") {
          aligned = existing;
          boundaryChanged = false;
        } else {
          boundaryChanged = true;
        }
      } else {
        if (existing.kind !== "managed") {
          throw new Error(`Graph Operator cannot run with a ${existing.kind} execution boundary`);
        }
        if (!executionBoundaryContainsForChildWorkspace(ceiling, existing, input.childWorkDir)) {
          throw new Error("Graph Operator execution boundary exceeds its parent boundary");
        }
        aligned = existing;
        boundaryChanged = false;
      }
    }

    const permissionMode = aligned.kind === "bypass" ? "full-access" : "ask";
    const initializedSettings = input.createChildSettings?.({ permissionMode });
    if (initializedSettings) {
      if (
        initializedSettings.collaborationMode !== "agent" ||
        initializedSettings.orchestrationMode !== "default"
      ) {
        throw new Error("Graph Operator settings must use agent/default execution axes");
      }
      if (initializedSettings.permissionMode !== permissionMode) {
        throw new Error("Graph Operator settings exceed its inherited execution boundary");
      }
    }
    let settingsToCommit: PersistedSessionSettingsWrite | undefined;
    if (initializedSettings) {
      if (existingSettings) {
        assertOperatorSettingsMatchProfile(existingSettings, initializedSettings);
        const existingPermissionMode = existing!.kind === "bypass" ? "full-access" : "ask";
        if (existingSettings.permissionMode !== existingPermissionMode) {
          throw new Error("Graph Operator settings disagree with its durable execution boundary");
        }
        if (existingSettings.permissionMode !== permissionMode) {
          settingsToCommit = { ...existingSettings, permissionMode };
        }
      } else {
        settingsToCommit = initializedSettings;
      }
    }

    if (boundaryChanged || settingsToCommit) {
      childSession.updateRuntimeState({
        ...(boundaryChanged ? { boundary: aligned } : {}),
        ...(settingsToCommit ? { settings: settingsToCommit } : {}),
      });
      await childSession.flushPersistence();
    }

    const committed = childSession.getRuntimeStateSnapshot();
    if (
      !committed.boundary ||
      committed.boundary.kind !== aligned.kind ||
      !executionBoundaryContainsForChildWorkspace(ceiling, committed.boundary, input.childWorkDir)
    ) {
      throw new Error("Graph Operator execution boundary was not durably inherited");
    }
    if (initializedSettings) {
      if (!committed.settings) {
        throw new Error("Graph Operator settings were not durably initialized");
      }
      assertOperatorSettingsMatchProfile(committed.settings, initializedSettings);
      if (committed.settings.permissionMode !== permissionMode) {
        throw new Error("Graph Operator settings and execution boundary did not commit atomically");
      }
    }
    return { parent: structuredClone(parent), child: structuredClone(committed.boundary) };
  } finally {
    childLease?.release();
    rootLease.release();
  }
}

function assertOperatorSettingsMatchProfile(
  actual: PersistedSessionSettings,
  expected: PersistedSessionSettingsWrite,
): void {
  if (
    actual.provider !== expected.provider ||
    actual.model !== expected.model ||
    actual.modelRouteId !== expected.modelRouteId ||
    actual.collaborationMode !== "agent" ||
    actual.orchestrationMode !== "default" ||
    actual.thinkingEffort !== expected.thinkingEffort ||
    actual.thinkingEffortExplicit !== expected.thinkingEffortExplicit ||
    actual.additionalDirectories.length !== expected.additionalDirectories.length ||
    actual.additionalDirectories.some(
      (directory, index) => directory !== expected.additionalDirectories[index],
    )
  ) {
    throw new Error("Graph Operator persisted settings no longer match its frozen profile");
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
