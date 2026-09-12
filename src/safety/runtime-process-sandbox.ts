import { tmpdir } from "node:os";
import {
  compileRuntimePermissionProfile,
  type ExecutionBoundary,
  type ManagedPermissionProfile,
  type RuntimeCollaborationMode,
} from "./permission-profile.js";
import {
  SandboxViolationError,
  type SandboxConfig,
  type SandboxProfile,
} from "./process-sandbox/index.js";

export interface RuntimeProcessSandboxDescriptor {
  readonly profile: SandboxProfile;
  readonly config?: Partial<SandboxConfig>;
  readonly scratchRoot: string;
  /** Changes whenever roots or the effective profile/network boundary changes. */
  readonly generation: number;
  /** Deny/protected-metadata restrictions are not yet expressible by the OS process policy. */
  readonly hasUnsupportedDenyEntries?: boolean;
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  readonly readFiles?: readonly string[];
  readonly writeFiles?: readonly string[];
}

interface RuntimeProcessSandboxInputBase {
  readonly workspaceGeneration: number;
  readonly scratchRoot: string;
}

export interface CompileForegroundRuntimeProcessSandboxInput extends RuntimeProcessSandboxInputBase {
  readonly collaborationMode: RuntimeCollaborationMode;
  /** Approved managed-boundary expansion. Ignored by Plan and full-access. */
  readonly networkEnabled?: boolean;
  /** Durable authority required for every foreground subprocess. */
  readonly executionBoundary: ExecutionBoundary;
  readonly backgroundNetworkPolicy?: never;
}

export interface CompileBackgroundRuntimeProcessSandboxInput extends RuntimeProcessSandboxInputBase {
  readonly backgroundNetworkPolicy: "disabled" | "allowlist" | "allow";
  readonly collaborationMode?: never;
  readonly networkEnabled?: never;
  readonly executionBoundary?: never;
}

export type CompileRuntimeProcessSandboxInput =
  | CompileForegroundRuntimeProcessSandboxInput
  | CompileBackgroundRuntimeProcessSandboxInput;

/**
 * Compile every local subprocess origin from the same permission profile.
 * Plan is deliberately stronger than full-access; background jobs retain their
 * separately frozen policy and never inherit a foreground boundary.
 */
export function compileRuntimeProcessSandbox(
  input: CompileRuntimeProcessSandboxInput,
): RuntimeProcessSandboxDescriptor {
  if (!Number.isSafeInteger(input.workspaceGeneration) || input.workspaceGeneration < 0) {
    throw new Error("workspaceGeneration must be a non-negative safe integer");
  }

  if (input.backgroundNetworkPolicy !== undefined) {
    const network = input.backgroundNetworkPolicy === "allow" ? "allow" : "deny";
    return {
      profile: "workspace-write",
      config: { network },
      scratchRoot: input.scratchRoot,
      generation: generationFor(input.workspaceGeneration, network === "allow" ? 5 : 4),
    };
  }

  const configuredBoundary = input.executionBoundary;
  const boundary =
    input.collaborationMode === "plan"
      ? compileRuntimePermissionProfile({
          collaborationMode: "plan",
          permissionMode: "ask",
          revision: configuredBoundary.revision,
        })
      : configuredBoundary;
  const managedNetworkEnabled =
    input.collaborationMode !== "plan" &&
    boundary.kind === "managed" &&
    (boundary.profile.network.kind === "enabled" || input.networkEnabled === true);
  const profileTag =
    input.collaborationMode === "plan"
      ? 1
      : boundary.kind === "bypass"
        ? 3
        : managedNetworkEnabled
          ? 6
          : 2;
  const generation = generationFor(
    input.workspaceGeneration,
    profileTag,
    input.executionBoundary.revision,
  );
  if (boundary.kind === "bypass") {
    return {
      profile: "danger-full-access",
      scratchRoot: input.scratchRoot,
      generation,
    };
  }
  if (boundary.kind !== "managed") {
    throw new Error("External execution boundaries cannot launch Host-managed subprocesses");
  }
  const profile = compileManagedSandboxProfile(boundary.profile);
  const paths = processPathsForProfile(boundary.profile);
  return {
    profile,
    config: {
      network:
        managedNetworkEnabled || boundary.profile.network.kind === "enabled" ? "allow" : "deny",
    },
    scratchRoot: input.scratchRoot,
    generation,
    ...(paths.readRoots.length > 0 ? { readRoots: paths.readRoots } : {}),
    ...(paths.writeRoots.length > 0 ? { writeRoots: paths.writeRoots } : {}),
    ...(paths.readFiles.length > 0 ? { readFiles: paths.readFiles } : {}),
    ...(paths.writeFiles.length > 0 ? { writeFiles: paths.writeFiles } : {}),
  };
}

function compileManagedSandboxProfile(profile: ManagedPermissionProfile): SandboxProfile {
  if (
    profile.fileSystem.protectedMetadata !== undefined ||
    profile.fileSystem.entries.some((entry) => entry.access === "deny")
  ) {
    throw new SandboxViolationError(
      "policy_compilation_failed",
      "Managed profile 含显式 deny 或 protectedMetadata deny_write，当前 OS 进程沙箱无法完整表达，已 fail-closed。",
    );
  }
  if (profile.fileSystem.kind === "unrestricted") {
    if (profile.network.kind !== "enabled") {
      throw new SandboxViolationError(
        "policy_compilation_failed",
        "Unrestricted filesystem + restricted network 暂无可证明等价的跨平台 OS 进程沙箱表示，已 fail-closed。",
      );
    }
    return "danger-full-access";
  }

  const grantsWorkspaceRead = profile.fileSystem.entries.some(
    (entry) =>
      entry.kind === "special" &&
      (entry.special === ":workspace_roots" || entry.special === ":root") &&
      (entry.access === "read" || entry.access === "write"),
  );
  if (!grantsWorkspaceRead) {
    throw new SandboxViolationError(
      "policy_compilation_failed",
      "Managed profile 未授权读取 workspace roots，而当前进程 policy 会固定注入该读权，已拒绝静默放宽。",
    );
  }
  const writesWorkspace = profile.fileSystem.entries.some(
    (entry) =>
      entry.kind === "special" && entry.special === ":workspace_roots" && entry.access === "write",
  );
  return writesWorkspace ? "workspace-write" : "read-only";
}

function processPathsForProfile(profile: ManagedPermissionProfile): {
  readRoots: string[];
  writeRoots: string[];
  readFiles: string[];
  writeFiles: string[];
} {
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  const readFiles: string[] = [];
  const writeFiles: string[] = [];
  for (const entry of profile.fileSystem.entries) {
    if (entry.access === "deny") continue;
    if (entry.kind === "special") {
      const specialRoots =
        entry.special === ":tmpdir"
          ? [tmpdir()]
          : entry.special === ":slash_tmp"
            ? ["/tmp"]
            : entry.special === ":root"
              ? ["/"]
              : [];
      (entry.access === "write" ? writeRoots : readRoots).push(...specialRoots);
      continue;
    }
    const target =
      entry.match === "exact"
        ? entry.access === "write"
          ? writeFiles
          : readFiles
        : entry.access === "write"
          ? writeRoots
          : readRoots;
    target.push(entry.path);
  }
  return {
    readRoots: [...new Set(readRoots)],
    writeRoots: [...new Set(writeRoots)],
    readFiles: [...new Set(readFiles)],
    writeFiles: [...new Set(writeFiles)],
  };
}

function generationFor(
  workspaceGeneration: number,
  profileTag: number,
  boundaryRevision = 0,
): number {
  const generation = workspaceGeneration * 8 + profileTag + boundaryRevision * 1_000_000;
  if (!Number.isSafeInteger(generation)) throw new Error("Sandbox generation exceeds safe range");
  return generation;
}
