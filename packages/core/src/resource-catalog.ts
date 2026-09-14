export type ResourceCatalogScope = "project" | "user" | "builtin" | "external";

export type ResourceCatalogFormat = "pico-native" | "claude-compat" | "builtin" | "external";

export interface ResourceCatalogSource<TrustAuthority = unknown> {
  readonly id: string;
  readonly scope: ResourceCatalogScope;
  readonly format: ResourceCatalogFormat;
  readonly root: string;
  readonly priority: number;
  readonly namespace?: string;
  /** Opaque outer authority attached to immutable managed Plugin sources. */
  readonly hookTrustAuthority?: TrustAuthority;
}

/** External sources are pre-validated by the Host; Core only resolves their precedence. */
export interface ExternalResourceCatalogSource<
  TrustAuthority = unknown,
> extends ResourceCatalogSource<TrustAuthority> {
  readonly scope: "external";
  readonly format: "external" | "pico-native" | "claude-compat";
}

export interface ResourceCatalogCandidate<Value, TrustAuthority = unknown> {
  readonly name: string;
  readonly source: ResourceCatalogSource<TrustAuthority>;
  readonly sourcePath: string;
  readonly value?: Value;
  /** A malformed higher-priority declaration prevents same-name fallback. */
  readonly tombstone?: boolean;
}

export interface ResourceCatalogConflict {
  readonly name: string;
  readonly keptSourcePath: string;
  readonly ignoredSourcePath: string;
  readonly priority: number;
}

export interface ResolvedResourceCatalog<Value> {
  readonly entries: readonly Value[];
  readonly conflicts: readonly ResourceCatalogConflict[];
}

export interface ProjectedResourceCatalogEntry<Value, TrustAuthority = unknown> {
  readonly candidate: ResourceCatalogCandidate<Value, TrustAuthority> & { readonly value: Value };
  readonly effective: boolean;
  readonly shadowedBy?: string;
}

export interface ProjectedResourceCatalog<Value, TrustAuthority = unknown> {
  readonly entries: readonly ProjectedResourceCatalogEntry<Value, TrustAuthority>[];
  readonly conflicts: readonly ResourceCatalogConflict[];
}

/** Every user-visible resource name shares one case-insensitive key. */
export function canonicalResourceName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/** Select whole resources by priority; fields from different sources never merge. */
export function resolveResourceCatalog<Value, TrustAuthority>(
  candidates: readonly ResourceCatalogCandidate<Value, TrustAuthority>[],
): ResolvedResourceCatalog<Value> {
  const { selected, conflicts } = selectResourceCatalogCandidates(candidates);
  const entries = [...selected.values()]
    .filter(
      (
        candidate,
      ): candidate is ResourceCatalogCandidate<Value, TrustAuthority> & {
        readonly value: Value;
      } => candidate.tombstone !== true && candidate.value !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((candidate) => candidate.value);
  return { entries, conflicts };
}

/** Preserve every displayable candidate while reusing the canonical precedence decision. */
export function projectResourceCatalog<Value, TrustAuthority>(
  candidates: readonly ResourceCatalogCandidate<Value, TrustAuthority>[],
): ProjectedResourceCatalog<Value, TrustAuthority> {
  const { selected, conflicts } = selectResourceCatalogCandidates(candidates);
  const entries = candidates
    .filter(
      (
        candidate,
      ): candidate is ResourceCatalogCandidate<Value, TrustAuthority> & {
        readonly value: Value;
      } => candidate.tombstone !== true && candidate.value !== undefined,
    )
    .map((candidate) => {
      const winner = selected.get(canonicalResourceName(candidate.name));
      const effective = winner === candidate && winner.tombstone !== true;
      return {
        candidate,
        effective,
        ...(effective || !winner ? {} : { shadowedBy: winner.source.id }),
      };
    })
    .sort(
      (left, right) =>
        left.candidate.name.localeCompare(right.candidate.name) ||
        Number(right.effective) - Number(left.effective) ||
        right.candidate.source.priority - left.candidate.source.priority ||
        left.candidate.sourcePath.localeCompare(right.candidate.sourcePath),
    );
  return { entries, conflicts };
}

function selectResourceCatalogCandidates<Value, TrustAuthority>(
  candidates: readonly ResourceCatalogCandidate<Value, TrustAuthority>[],
): {
  readonly selected: ReadonlyMap<string, ResourceCatalogCandidate<Value, TrustAuthority>>;
  readonly conflicts: readonly ResourceCatalogConflict[];
} {
  const selected = new Map<string, ResourceCatalogCandidate<Value, TrustAuthority>>();
  const conflicts: ResourceCatalogConflict[] = [];
  for (const candidate of candidates) {
    const key = canonicalResourceName(candidate.name);
    if (!key) continue;
    const current = selected.get(key);
    if (!current || candidate.source.priority > current.source.priority) {
      selected.set(key, candidate);
      continue;
    }
    if (candidate.source.priority === current.source.priority) {
      conflicts.push({
        name: candidate.name,
        keptSourcePath: current.sourcePath,
        ignoredSourcePath: candidate.sourcePath,
        priority: candidate.source.priority,
      });
    }
  }
  return { selected, conflicts };
}
