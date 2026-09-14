/**
 * Platform-independent permission profile and execution-boundary model.
 *
 * This module is deliberately pure. Callers must canonicalize real paths and
 * resolve symlinks before passing paths into these helpers.
 */

export const FILE_SYSTEM_ACCESS_MODES = ["read", "write", "deny"] as const;
export type FileSystemAccessMode = (typeof FILE_SYSTEM_ACCESS_MODES)[number];

export const FILE_SYSTEM_PATH_MATCHES = ["exact", "subtree"] as const;
export type FileSystemPathMatch = (typeof FILE_SYSTEM_PATH_MATCHES)[number];

export const FILE_SYSTEM_SPECIAL_PATHS = [
  ":root",
  ":workspace_roots",
  ":tmpdir",
  ":slash_tmp",
  ":minimal",
] as const;
export type FileSystemSpecialPath = (typeof FILE_SYSTEM_SPECIAL_PATHS)[number];

export type FileSystemSandboxEntry =
  | {
      readonly kind: "path";
      readonly access: FileSystemAccessMode;
      readonly path: string;
      /** Defaults to subtree for profile roots. */
      readonly match?: FileSystemPathMatch;
    }
  | {
      readonly kind: "special";
      readonly access: FileSystemAccessMode;
      readonly special: FileSystemSpecialPath;
    };

export const PROTECTED_METADATA_NAMES = [".git", ".agents", ".codex"] as const;

export interface FileSystemSandboxPolicy {
  readonly kind: "restricted" | "unrestricted";
  readonly entries: readonly FileSystemSandboxEntry[];
  readonly protectedMetadata?: {
    readonly access: "deny_write";
    readonly names: readonly string[];
  };
}

export interface ManagedPermissionProfile {
  readonly type: "managed";
  readonly name: "read-only" | "workspace-write" | "danger-full-access" | "custom";
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly network: { readonly kind: "restricted" | "enabled" };
}

export interface PermissionProfileMatchContext {
  readonly root?: string;
  readonly workspaceRoots?: readonly string[];
  readonly tmpdir?: string;
  readonly slashTmp?: string;
  readonly minimalRoots?: readonly string[];
}

export type ExecutionBoundary =
  | {
      readonly kind: "managed";
      readonly profile: ManagedPermissionProfile;
      readonly revision: number;
    }
  | { readonly kind: "bypass"; readonly revision: number }
  | { readonly kind: "external"; readonly revision: number };

export type RuntimePermissionMode = "ask" | "auto" | "full-access";
export type RuntimeCollaborationMode = "agent" | "plan";

export interface CompileRuntimePermissionProfileInput {
  readonly permissionMode: RuntimePermissionMode;
  readonly collaborationMode: RuntimeCollaborationMode;
  readonly revision?: number;
}

export const SANDBOX_BOUNDARY_ACCESS_MODES = ["read", "write"] as const;
export type SandboxBoundaryAccess = (typeof SANDBOX_BOUNDARY_ACCESS_MODES)[number];

export const SANDBOX_BOUNDARY_SCOPES = ["exact", "subtree"] as const;
export type SandboxBoundaryScope = (typeof SANDBOX_BOUNDARY_SCOPES)[number];

export interface SandboxBoundaryFilesystemEntry {
  readonly path: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
}

export interface SandboxBoundaryExpansion {
  readonly filesystem?: {
    readonly entries: readonly SandboxBoundaryFilesystemEntry[];
  };
  readonly network?: { readonly enabled: true };
}

export const MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES = 32;
export const MAX_SANDBOX_BOUNDARY_PATH_CHARS = 4096;
export const MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES = 64 * 1024;
export const MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES = 1024 * 1024;

export type SandboxBoundaryExpansionValidationFailureReason =
  | "invalid_expansion"
  | "empty_expansion"
  | "too_many_entries"
  | "invalid_entry"
  | "invalid_path"
  | "path_too_long"
  | "payload_too_large";

export type SandboxBoundaryExpansionValidationResult =
  | { readonly ok: true; readonly expansion: SandboxBoundaryExpansion }
  | {
      readonly ok: false;
      readonly reason: SandboxBoundaryExpansionValidationFailureReason;
      readonly message: string;
    };

export type SandboxBoundaryExpansionAssessment =
  | { readonly outcome: "apply"; readonly profile: ManagedPermissionProfile }
  | { readonly outcome: "noop"; readonly profile: ManagedPermissionProfile }
  | { readonly outcome: "conflict"; readonly reason: "explicit_deny" };

export type ApplyExecutionBoundaryExpansionResult =
  | { readonly outcome: "applied"; readonly boundary: ExecutionBoundary }
  | { readonly outcome: "noop"; readonly boundary: ExecutionBoundary }
  | {
      readonly outcome: "conflict";
      readonly reason: "stale_revision" | "not_managed" | "explicit_deny";
      readonly boundary: ExecutionBoundary;
    };

export function createReadOnlyPermissionProfile(): ManagedPermissionProfile {
  return {
    type: "managed",
    name: "read-only",
    fileSystem: {
      kind: "restricted",
      entries: [{ kind: "special", access: "read", special: ":workspace_roots" }],
    },
    network: { kind: "restricted" },
  };
}

export function createWorkspaceWritePermissionProfile(): ManagedPermissionProfile {
  return {
    type: "managed",
    name: "workspace-write",
    fileSystem: {
      kind: "restricted",
      entries: [
        { kind: "special", access: "write", special: ":workspace_roots" },
        { kind: "special", access: "write", special: ":tmpdir" },
        { kind: "special", access: "write", special: ":slash_tmp" },
      ],
    },
    network: { kind: "restricted" },
  };
}

export function createDangerFullAccessPermissionProfile(): ManagedPermissionProfile {
  return {
    type: "managed",
    name: "danger-full-access",
    fileSystem: { kind: "unrestricted", entries: [] },
    network: { kind: "enabled" },
  };
}

export function createManagedExecutionBoundary(
  profile: ManagedPermissionProfile,
  revision = 0,
): ExecutionBoundary {
  assertRevision(revision);
  return { kind: "managed", profile, revision };
}

export function createBypassExecutionBoundary(revision = 0): ExecutionBoundary {
  assertRevision(revision);
  return { kind: "bypass", revision };
}

export function createExternalExecutionBoundary(revision = 0): ExecutionBoundary {
  assertRevision(revision);
  return { kind: "external", revision };
}

/** Decode a complete durable boundary snapshot without retaining caller-owned objects. */
export function decodeExecutionBoundary(input: unknown): ExecutionBoundary {
  if (!isRecord(input) || !isBoundaryRevision(input.revision)) {
    throw new Error("Invalid execution boundary");
  }

  let boundary: ExecutionBoundary;
  if (input.kind === "bypass" || input.kind === "external") {
    if (hasUnexpectedKeys(input, ["kind", "revision"])) {
      throw new Error("Invalid execution boundary");
    }
    boundary = { kind: input.kind, revision: input.revision };
  } else {
    if (input.kind !== "managed" || hasUnexpectedKeys(input, ["kind", "profile", "revision"])) {
      throw new Error("Invalid execution boundary");
    }
    boundary = {
      kind: "managed",
      profile: decodeManagedPermissionProfile(input.profile),
      revision: input.revision,
    };
  }

  assertExecutionBoundaryCapacity(boundary);
  return boundary;
}

export function assertExecutionBoundaryCapacity(boundary: ExecutionBoundary): void {
  if (serializedByteLength(boundary) > MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES) {
    throw new Error("Execution boundary exceeds the serialized size limit");
  }
}

/** Compile runtime settings into the authoritative initial execution boundary. */
export function compileRuntimePermissionProfile(
  input: CompileRuntimePermissionProfileInput,
): ExecutionBoundary {
  const revision = input.revision ?? 0;
  assertRevision(revision);

  // Collaboration mode is the stronger axis: planning never inherits an
  // otherwise unrestricted foreground permission mode.
  if (input.collaborationMode === "plan") {
    return createManagedExecutionBoundary(createReadOnlyPermissionProfile(), revision);
  }
  if (input.permissionMode === "full-access") {
    return createBypassExecutionBoundary(revision);
  }
  return createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), revision);
}

export function isReadOnlyPermissionProfile(profile: ManagedPermissionProfile): boolean {
  return (
    profile.fileSystem.kind === "restricted" &&
    profile.network.kind === "restricted" &&
    !profile.fileSystem.entries.some((entry) => entry.access === "write")
  );
}

export function canReadPath(
  profile: ManagedPermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  if (isDeniedPath(profile, path, context)) return false;
  if (profile.fileSystem.kind === "unrestricted") return true;
  return profile.fileSystem.entries.some(
    (entry) =>
      (entry.access === "read" || entry.access === "write") &&
      entryMatchesPath(entry, path, context),
  );
}

export function canWritePath(
  profile: ManagedPermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  if (isDeniedPath(profile, path, context)) return false;
  if (isProtectedWritePath(profile, path, context)) return false;
  if (profile.fileSystem.kind === "unrestricted") return true;
  return profile.fileSystem.entries.some(
    (entry) => entry.access === "write" && entryMatchesPath(entry, path, context),
  );
}

/**
 * A policy-level write denial that an ordinary one-shot workspace grant must
 * never override. A specific path write in the same profile is the only
 * supported exception to protected-metadata inheritance.
 */
export function isProtectedWritePath(
  profile: ManagedPermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  const protectedNames = profile.fileSystem.protectedMetadata?.names;
  return (
    protectedNames !== undefined &&
    isProtectedMetadataPath(path, context.workspaceRoots ?? [], protectedNames) &&
    !hasExplicitPathWrite(profile.fileSystem, path, context)
  );
}

export function isDeniedPath(
  profile: ManagedPermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  return profile.fileSystem.entries.some(
    (entry) => entry.access === "deny" && entryMatchesPath(entry, path, context),
  );
}

export function isProtectedMetadataPath(
  path: string,
  workspaceRoots: readonly string[],
  names: readonly string[] = PROTECTED_METADATA_NAMES,
): boolean {
  for (const workspaceRoot of workspaceRoots) {
    const segments = relativeSegments(path, workspaceRoot);
    if (!segments) continue;
    const foldCase = isWindowsDrivePath(workspaceRoot);
    if (
      segments.some((segment) =>
        names.some((name) =>
          foldCase ? name.toLowerCase() === segment.toLowerCase() : name === segment,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function validateSandboxBoundaryExpansion(
  input: unknown,
): SandboxBoundaryExpansionValidationResult {
  if (!isRecord(input) || hasUnexpectedKeys(input, ["filesystem", "network"])) {
    return invalid("invalid_expansion", "Sandbox boundary expansion must be a supported object.");
  }

  const filesystem = validateFilesystemExpansion(input.filesystem);
  if (!filesystem.ok) return filesystem;
  const network = validateNetworkExpansion(input.network);
  if (!network.ok) return network;
  if (filesystem.entries.length === 0 && !network.enabled) {
    return invalid("empty_expansion", "Sandbox boundary expansion must contain a permission.");
  }

  const expansion: SandboxBoundaryExpansion = {
    ...(filesystem.entries.length > 0
      ? { filesystem: { entries: compactSandboxBoundaryFilesystemEntries(filesystem.entries) } }
      : {}),
    ...(network.enabled ? { network: { enabled: true as const } } : {}),
  };
  if (serializedByteLength(expansion) > MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES) {
    return invalid("payload_too_large", "Sandbox boundary expansion exceeds the size limit.");
  }
  return { ok: true, expansion };
}

export function compactSandboxBoundaryFilesystemEntries(
  entries: readonly SandboxBoundaryFilesystemEntry[],
): readonly SandboxBoundaryFilesystemEntry[] {
  const sorted = [...entries]
    .map((entry) => ({ ...entry, path: trimTrailingPathSeparators(entry.path) }))
    .sort(compareBoundaryEntries);
  const compacted: SandboxBoundaryFilesystemEntry[] = [];
  for (const entry of sorted) {
    if (compacted.some((existing) => boundaryEntryCovers(existing, entry))) continue;
    for (let index = compacted.length - 1; index >= 0; index -= 1) {
      if (boundaryEntryCovers(entry, compacted[index]!)) compacted.splice(index, 1);
    }
    compacted.push(entry);
  }
  return compacted.sort(compareBoundaryEntries);
}

export function sandboxBoundaryExpansionAllowsPath(
  expansion: SandboxBoundaryExpansion,
  path: string,
  access: SandboxBoundaryAccess,
): boolean {
  return (
    expansion.filesystem?.entries.some(
      (entry) =>
        (access !== "write" || entry.access === "write") &&
        (entry.scope === "exact" ? samePath(path, entry.path) : pathWithinRoot(path, entry.path)),
    ) ?? false
  );
}

export function applySandboxBoundaryExpansion(
  base: ManagedPermissionProfile,
  expansion: SandboxBoundaryExpansion,
): ManagedPermissionProfile {
  const fileSystem =
    base.fileSystem.kind === "unrestricted"
      ? base.fileSystem
      : {
          ...base.fileSystem,
          entries: compactProfileFilesystemEntries([
            ...base.fileSystem.entries,
            ...(expansion.filesystem?.entries ?? []).map((entry) => ({
              kind: "path" as const,
              access: entry.access,
              path: entry.path,
              match: entry.scope,
            })),
          ]),
        };
  return {
    ...base,
    fileSystem,
    network: expansion.network?.enabled ? { kind: "enabled" } : base.network,
  };
}

export function assessSandboxBoundaryExpansion(
  base: ManagedPermissionProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext = {},
): SandboxBoundaryExpansionAssessment {
  if (expansionConflictsWithDeny(base, expansion, context)) {
    return { outcome: "conflict", reason: "explicit_deny" };
  }
  if (profileContainsExpansion(base, expansion, context)) {
    return { outcome: "noop", profile: base };
  }
  return { outcome: "apply", profile: applySandboxBoundaryExpansion(base, expansion) };
}

/** CAS-style pure transition used by a durable host when settling an approval. */
export function applyExecutionBoundaryExpansion(
  boundary: ExecutionBoundary,
  baseRevision: number,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext = {},
): ApplyExecutionBoundaryExpansionResult {
  if (boundary.revision !== baseRevision) {
    return { outcome: "conflict", reason: "stale_revision", boundary };
  }
  if (boundary.kind !== "managed") {
    return { outcome: "conflict", reason: "not_managed", boundary };
  }
  const assessment = assessSandboxBoundaryExpansion(boundary.profile, expansion, context);
  if (assessment.outcome === "conflict") {
    return { outcome: "conflict", reason: assessment.reason, boundary };
  }
  if (assessment.outcome === "noop") return { outcome: "noop", boundary };
  return {
    outcome: "applied",
    boundary: {
      kind: "managed",
      profile: assessment.profile,
      revision: boundary.revision + 1,
    },
  };
}

/** True when every capability of child is no broader than parent. */
export function executionBoundaryContains(
  parent: ExecutionBoundary,
  child: ExecutionBoundary,
): boolean {
  if (parent.kind === "bypass") return true;
  if (parent.kind === "external") return child.kind === "external";
  if (child.kind !== "managed") return false;
  return profileContainsProfile(parent.profile, child.profile);
}

function profileContainsExpansion(
  profile: ManagedPermissionProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext,
): boolean {
  if (expansion.network?.enabled && profile.network.kind !== "enabled") return false;
  if (profile.fileSystem.kind === "unrestricted") return true;
  return (expansion.filesystem?.entries ?? []).every((requested) =>
    profile.fileSystem.entries.some(
      (existing) =>
        existing.access !== "deny" &&
        accessCovers(existing.access, requested.access) &&
        resolvedEntryRoots(existing, context).some((root) =>
          requested.scope === "exact"
            ? pathCoveredByRoot(requested.path, root)
            : root.scope === "subtree" && pathWithinRoot(requested.path, root.path),
        ),
    ),
  );
}

function profileContainsProfile(
  parent: ManagedPermissionProfile,
  child: ManagedPermissionProfile,
): boolean {
  if (child.network.kind === "enabled" && parent.network.kind !== "enabled") return false;
  if (child.fileSystem.kind === "unrestricted" && parent.fileSystem.kind !== "unrestricted") {
    return false;
  }
  if (
    parent.fileSystem.kind !== "unrestricted" &&
    !child.fileSystem.entries
      .filter((entry) => entry.access !== "deny")
      .every((requested) =>
        parent.fileSystem.entries.some(
          (existing) =>
            existing.access !== "deny" && profileEntryContains(existing, requested, false),
        ),
      )
  ) {
    return false;
  }
  if (
    !parent.fileSystem.entries
      .filter((entry) => entry.access === "deny")
      .every((requiredDeny) =>
        child.fileSystem.entries.some(
          (candidate) =>
            candidate.access === "deny" && profileEntryContains(candidate, requiredDeny, true),
        ),
      )
  ) {
    return false;
  }
  const parentProtected = parent.fileSystem.protectedMetadata?.names ?? [];
  const childProtected = new Set(child.fileSystem.protectedMetadata?.names ?? []);
  return parentProtected.every((name) => childProtected.has(name));
}

function profileEntryContains(
  existing: FileSystemSandboxEntry,
  requested: FileSystemSandboxEntry,
  ignoreAccess: boolean,
): boolean {
  if (!ignoreAccess && !accessCovers(existing.access, requested.access)) return false;
  if (existing.kind === "special" || requested.kind === "special") {
    return (
      existing.kind === "special" &&
      requested.kind === "special" &&
      existing.special === requested.special
    );
  }
  const existingMatch = existing.match ?? "subtree";
  const requestedMatch = requested.match ?? "subtree";
  if (existingMatch === "exact") {
    return requestedMatch === "exact" && samePath(existing.path, requested.path);
  }
  return pathWithinRoot(requested.path, existing.path);
}

function expansionConflictsWithDeny(
  profile: ManagedPermissionProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext,
): boolean {
  const deniedRoots = profile.fileSystem.entries
    .filter((entry) => entry.access === "deny")
    .flatMap((entry) => resolvedEntryRoots(entry, context));
  return (expansion.filesystem?.entries ?? []).some(
    (requested) =>
      deniedRoots.some((denied) =>
        requested.scope === "exact"
          ? pathCoveredByRoot(requested.path, denied)
          : pathWithinRoot(denied.path, requested.path) ||
            pathCoveredByRoot(requested.path, denied),
      ) || expansionWeakensProtectedMetadata(profile, requested, context),
  );
}

function expansionWeakensProtectedMetadata(
  profile: ManagedPermissionProfile,
  requested: SandboxBoundaryFilesystemEntry,
  context: PermissionProfileMatchContext,
): boolean {
  const protectedMetadata = profile.fileSystem.protectedMetadata;
  if (protectedMetadata?.access !== "deny_write" || requested.access !== "write") return false;
  const workspaceRoots = context.workspaceRoots ?? [];
  if (requested.scope === "exact") {
    return isProtectedMetadataPath(requested.path, workspaceRoots, protectedMetadata.names);
  }
  return workspaceRoots.some(
    (workspaceRoot) =>
      pathWithinRoot(requested.path, workspaceRoot) ||
      pathWithinRoot(workspaceRoot, requested.path),
  );
}

function compactProfileFilesystemEntries(
  entries: readonly FileSystemSandboxEntry[],
): readonly FileSystemSandboxEntry[] {
  const explicitAllows: SandboxBoundaryFilesystemEntry[] = entries.flatMap((entry) =>
    entry.kind === "path" && entry.access !== "deny"
      ? [{ path: entry.path, access: entry.access, scope: entry.match ?? "subtree" }]
      : [],
  );
  const preserved = entries.filter((entry) => entry.kind !== "path" || entry.access === "deny");
  const compacted = compactSandboxBoundaryFilesystemEntries(explicitAllows).map((entry) => ({
    kind: "path" as const,
    access: entry.access,
    path: entry.path,
    match: entry.scope,
  }));
  return [...preserved, ...compacted];
}

function validateFilesystemExpansion(
  input: unknown,
):
  | { readonly ok: true; readonly entries: SandboxBoundaryFilesystemEntry[] }
  | Extract<SandboxBoundaryExpansionValidationResult, { readonly ok: false }> {
  if (input === undefined) return { ok: true, entries: [] };
  if (!isRecord(input) || hasUnexpectedKeys(input, ["entries"]) || !Array.isArray(input.entries)) {
    return invalid("invalid_expansion", "filesystem must contain an entries array.");
  }
  if (input.entries.length > MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES) {
    return invalid("too_many_entries", "Sandbox boundary contains too many filesystem entries.");
  }
  const entries: SandboxBoundaryFilesystemEntry[] = [];
  for (const candidate of input.entries) {
    if (!isRecord(candidate) || hasUnexpectedKeys(candidate, ["path", "access", "scope"])) {
      return invalid("invalid_entry", "Sandbox boundary entry contains unsupported fields.");
    }
    if (
      typeof candidate.path !== "string" ||
      !SANDBOX_BOUNDARY_ACCESS_MODES.includes(candidate.access as SandboxBoundaryAccess) ||
      !SANDBOX_BOUNDARY_SCOPES.includes(candidate.scope as SandboxBoundaryScope)
    ) {
      return invalid("invalid_entry", "Sandbox boundary entry requires path, access, and scope.");
    }
    if (!isNormalizedAbsolutePath(candidate.path)) {
      return invalid("invalid_path", "Sandbox boundary path must be normalized and absolute.");
    }
    if (candidate.path.length > MAX_SANDBOX_BOUNDARY_PATH_CHARS) {
      return invalid("path_too_long", "Sandbox boundary path exceeds the length limit.");
    }
    entries.push({
      path: trimTrailingPathSeparators(candidate.path),
      access: candidate.access as SandboxBoundaryAccess,
      scope: candidate.scope as SandboxBoundaryScope,
    });
  }
  return { ok: true, entries };
}

function validateNetworkExpansion(
  input: unknown,
):
  | { readonly ok: true; readonly enabled: boolean }
  | Extract<SandboxBoundaryExpansionValidationResult, { readonly ok: false }> {
  if (input === undefined) return { ok: true, enabled: false };
  if (!isRecord(input) || hasUnexpectedKeys(input, ["enabled"]) || input.enabled !== true) {
    return invalid("invalid_expansion", "Network expansion only supports enabled: true.");
  }
  return { ok: true, enabled: true };
}

function decodeManagedPermissionProfile(input: unknown): ManagedPermissionProfile {
  if (
    !isRecord(input) ||
    input.type !== "managed" ||
    !isManagedPermissionProfileName(input.name) ||
    hasUnexpectedKeys(input, ["type", "name", "fileSystem", "network"]) ||
    !isRecord(input.fileSystem) ||
    hasUnexpectedKeys(input.fileSystem, ["kind", "entries", "protectedMetadata"]) ||
    (input.fileSystem.kind !== "restricted" && input.fileSystem.kind !== "unrestricted") ||
    !Array.isArray(input.fileSystem.entries) ||
    (input.fileSystem.protectedMetadata !== undefined &&
      (!isRecord(input.fileSystem.protectedMetadata) ||
        hasUnexpectedKeys(input.fileSystem.protectedMetadata, ["access", "names"]) ||
        input.fileSystem.protectedMetadata.access !== "deny_write" ||
        !Array.isArray(input.fileSystem.protectedMetadata.names) ||
        !input.fileSystem.protectedMetadata.names.every(
          (name): name is string => typeof name === "string",
        ))) ||
    !isRecord(input.network) ||
    hasUnexpectedKeys(input.network, ["kind"]) ||
    (input.network.kind !== "restricted" && input.network.kind !== "enabled")
  ) {
    throw new Error("Invalid managed permission profile");
  }

  const entries: FileSystemSandboxEntry[] = input.fileSystem.entries.map((entry) => {
    if (!isRecord(entry) || !FILE_SYSTEM_ACCESS_MODES.includes(entry.access as never)) {
      throw new Error("Invalid managed permission filesystem entry");
    }
    if (
      entry.kind === "path" &&
      !hasUnexpectedKeys(entry, ["kind", "access", "path", "match"]) &&
      typeof entry.path === "string" &&
      isNormalizedAbsolutePath(entry.path) &&
      (entry.match === undefined || FILE_SYSTEM_PATH_MATCHES.includes(entry.match as never))
    ) {
      return {
        kind: "path",
        access: entry.access as FileSystemAccessMode,
        path: entry.path,
        ...(entry.match === undefined ? {} : { match: entry.match as FileSystemPathMatch }),
      };
    }
    if (
      entry.kind === "special" &&
      !hasUnexpectedKeys(entry, ["kind", "access", "special"]) &&
      FILE_SYSTEM_SPECIAL_PATHS.includes(entry.special as never)
    ) {
      return {
        kind: "special",
        access: entry.access as FileSystemAccessMode,
        special: entry.special as FileSystemSpecialPath,
      };
    }
    throw new Error("Invalid managed permission filesystem entry");
  });

  const protectedMetadata = input.fileSystem.protectedMetadata;
  return {
    type: "managed",
    name: input.name,
    fileSystem: {
      kind: input.fileSystem.kind,
      entries,
      ...(protectedMetadata === undefined
        ? {}
        : {
            protectedMetadata: {
              access: "deny_write" as const,
              names: [...(protectedMetadata.names as string[])],
            },
          }),
    },
    network: { kind: input.network.kind },
  };
}

function entryMatchesPath(
  entry: FileSystemSandboxEntry,
  path: string,
  context: PermissionProfileMatchContext,
): boolean {
  if (entry.kind === "path" && entry.match === "exact") return samePath(path, entry.path);
  return resolvedEntryRoots(entry, context).some((root) => pathWithinRoot(path, root.path));
}

function hasExplicitPathWrite(
  policy: FileSystemSandboxPolicy,
  path: string,
  context: PermissionProfileMatchContext,
): boolean {
  return policy.entries.some(
    (entry) =>
      entry.kind === "path" && entry.access === "write" && entryMatchesPath(entry, path, context),
  );
}

function resolvedEntryRoots(
  entry: FileSystemSandboxEntry,
  context: PermissionProfileMatchContext,
): readonly { readonly path: string; readonly scope: SandboxBoundaryScope }[] {
  if (entry.kind === "path") return [{ path: entry.path, scope: entry.match ?? "subtree" }];
  switch (entry.special) {
    case ":root":
      return [{ path: context.root ?? "/", scope: "subtree" }];
    case ":workspace_roots":
      return (context.workspaceRoots ?? []).map((path) => ({ path, scope: "subtree" }));
    case ":tmpdir":
      return context.tmpdir ? [{ path: context.tmpdir, scope: "subtree" }] : [];
    case ":slash_tmp":
      return [{ path: context.slashTmp ?? "/tmp", scope: "subtree" }];
    case ":minimal":
      return (context.minimalRoots ?? []).map((path) => ({ path, scope: "subtree" }));
  }
}

function accessCovers(existing: FileSystemAccessMode, requested: FileSystemAccessMode): boolean {
  if (requested === "deny") return existing === "deny";
  return existing === "write" || (existing === "read" && requested === "read");
}

function boundaryEntryCovers(
  existing: SandboxBoundaryFilesystemEntry,
  candidate: SandboxBoundaryFilesystemEntry,
): boolean {
  if (candidate.access === "write" && existing.access !== "write") return false;
  if (existing.scope === "exact") {
    return candidate.scope === "exact" && samePath(existing.path, candidate.path);
  }
  return pathWithinRoot(candidate.path, existing.path);
}

function pathCoveredByRoot(
  path: string,
  root: { readonly path: string; readonly scope: SandboxBoundaryScope },
): boolean {
  return root.scope === "exact" ? samePath(path, root.path) : pathWithinRoot(path, root.path);
}

function compareBoundaryEntries(
  left: SandboxBoundaryFilesystemEntry,
  right: SandboxBoundaryFilesystemEntry,
): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.scope === right.scope ? 0 : left.scope === "subtree" ? -1 : 1) ||
    (left.access === right.access ? 0 : left.access === "write" ? -1 : 1)
  );
}

export function isNormalizedAbsolutePath(path: string): boolean {
  if (!path || path.includes("\0")) return false;
  if (isWindowsDrivePath(path)) {
    if (path.includes(":", 2) || path.includes("/") || (path.length > 3 && path.endsWith("\\"))) {
      return false;
    }
    if (path.length === 3) return true;
    return !path
      .slice(3)
      .split("\\")
      .some((segment) => segment === "" || segment === "." || segment === "..");
  }
  if (!path.startsWith("/") || path.includes("\\") || (path.length > 1 && path.endsWith("/"))) {
    return false;
  }
  return !path
    .split("/")
    .some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."));
}

export function pathWithinRoot(path: string, root: string): boolean {
  if (!isNormalizedAbsolutePath(path) || !isNormalizedAbsolutePath(root)) return false;
  if (isWindowsDrivePath(path) !== isWindowsDrivePath(root)) return false;
  const normalizedPath = comparablePath(path);
  const normalizedRoot = comparablePath(root);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  const separator = isWindowsDrivePath(root) ? "\\" : "/";
  return (
    normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${separator}`)
  );
}

export function samePath(left: string, right: string): boolean {
  if (isWindowsDrivePath(left) !== isWindowsDrivePath(right)) return false;
  return comparablePath(left) === comparablePath(right);
}

function relativeSegments(path: string, root: string): readonly string[] | undefined {
  if (!pathWithinRoot(path, root)) return undefined;
  const normalizedPath = trimTrailingPathSeparators(path);
  const normalizedRoot = trimTrailingPathSeparators(root);
  if (samePath(normalizedPath, normalizedRoot)) return [];
  const separator = isWindowsDrivePath(root) ? "\\" : "/";
  const relative =
    normalizedRoot === "/"
      ? normalizedPath.slice(1)
      : normalizedPath.slice(normalizedRoot.length + 1);
  return relative.split(separator).filter(Boolean);
}

function trimTrailingPathSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:\\$/u.test(value)) return value;
  return isWindowsDrivePath(value) ? value.replace(/\\+$/gu, "") : value.replace(/\/+$/gu, "");
}

function comparablePath(value: string): string {
  const trimmed = trimTrailingPathSeparators(value);
  return isWindowsDrivePath(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:\\/u.test(path);
}

function invalid(
  reason: SandboxBoundaryExpansionValidationFailureReason,
  message: string,
): Extract<SandboxBoundaryExpansionValidationResult, { readonly ok: false }> {
  return { ok: false, reason, message };
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).some((key) => !allowedKeys.has(key));
}

function isBoundaryRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManagedPermissionProfileName(value: unknown): value is ManagedPermissionProfile["name"] {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access" ||
    value === "custom"
  );
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Execution boundary revision must be a non-negative safe integer");
  }
}
