import type { HookTrustAuthority } from "../hooks/trust/store.js";

export type ResourceCatalogScope = "project" | "user" | "builtin" | "external";

export type ResourceCatalogFormat =
  | "pico-native"
  | "pico-legacy"
  | "claude-compat"
  | "builtin"
  | "external";

export interface ResourceCatalogSource {
  readonly id: string;
  readonly scope: ResourceCatalogScope;
  readonly format: ResourceCatalogFormat;
  readonly root: string;
  readonly priority: number;
  readonly namespace?: string;
  /** Host-only authority attached to immutable managed Plugin sources. */
  readonly hookTrustAuthority?: HookTrustAuthority;
}

/**
 * Plugin 贡献等外部来源只需提供已经边界验证的资源根。
 * Catalog 不会自行发现、启用或信任 Plugin runtime。
 */
export interface ExternalResourceCatalogSource extends ResourceCatalogSource {
  readonly scope: "external";
  /** 外部来源仍保留内容方言，便于在 Catalog 边界完成兼容转换。 */
  readonly format: "external" | "pico-native" | "claude-compat";
}

export interface ResourceCatalogCandidate<T> {
  readonly name: string;
  readonly source: ResourceCatalogSource;
  readonly sourcePath: string;
  readonly value?: T;
  /** 高优先级声明无效时阻止同名低优先级条目回落。 */
  readonly tombstone?: boolean;
}

export interface ResourceCatalogConflict {
  readonly name: string;
  readonly keptSourcePath: string;
  readonly ignoredSourcePath: string;
  readonly priority: number;
}

export interface ResolvedResourceCatalog<T> {
  readonly entries: readonly T[];
  readonly conflicts: readonly ResourceCatalogConflict[];
}

/** 所有用户可见资源名称共用同一大小写不敏感键。 */
export function canonicalResourceName(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * 按整条资源选择最高优先级候选，禁止跨来源拼接字段。
 * 同级冲突保留输入中第一条，并返回可观测诊断。
 */
export function resolveResourceCatalog<T>(
  candidates: readonly ResourceCatalogCandidate<T>[],
): ResolvedResourceCatalog<T> {
  const selected = new Map<string, ResourceCatalogCandidate<T>>();
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

  const entries = [...selected.values()]
    .filter(
      (candidate): candidate is ResourceCatalogCandidate<T> & { readonly value: T } =>
        candidate.tombstone !== true && candidate.value !== undefined,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((candidate) => candidate.value);

  return { entries, conflicts };
}
