export interface ArchitectureBoundaryViolation {
  readonly rule: string;
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
}

export interface ArchitectureBoundaryScanOptions {
  readonly repositoryRoot?: string;
}

export interface ArchitectureBoundaryEvaluation {
  readonly known: readonly ArchitectureBoundaryViolation[];
  readonly unexpected: readonly ArchitectureBoundaryViolation[];
}

export function scanArchitectureBoundaries(
  options?: ArchitectureBoundaryScanOptions,
): ArchitectureBoundaryViolation[];

export function scanTypeScriptValueImportCycles(
  options?: ArchitectureBoundaryScanOptions,
): ArchitectureBoundaryViolation[];

export function scanCrossCuttingDefinitions(
  options?: ArchitectureBoundaryScanOptions,
): ArchitectureBoundaryViolation[];

export function scanHandwrittenTimeoutPrimitives(
  options?: ArchitectureBoundaryScanOptions,
): ArchitectureBoundaryViolation[];

export function scanCanonicalPrimitiveRedefinitions(
  options?: ArchitectureBoundaryScanOptions,
): ArchitectureBoundaryViolation[];

export function evaluateArchitectureBoundaries(
  violations: readonly ArchitectureBoundaryViolation[],
  baseline?: ReadonlyMap<string, unknown>,
): ArchitectureBoundaryEvaluation;
