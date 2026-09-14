/** @deprecated Resource catalog precedence and projection have moved to @pico/core. */
import type { HookTrustAuthority } from "@pico/pico-host/hooks/trust/store";
import {
  canonicalResourceName as canonicalCoreResourceName,
  projectResourceCatalog as projectCoreResourceCatalog,
  resolveResourceCatalog as resolveCoreResourceCatalog,
} from "@pico/core/resource-catalog";
import type {
  ExternalResourceCatalogSource as CoreExternalResourceCatalogSource,
  ProjectedResourceCatalog as CoreProjectedResourceCatalog,
  ProjectedResourceCatalogEntry as CoreProjectedResourceCatalogEntry,
  ResourceCatalogCandidate as CoreResourceCatalogCandidate,
  ResourceCatalogConflict,
  ResourceCatalogFormat,
  ResourceCatalogScope,
  ResourceCatalogSource as CoreResourceCatalogSource,
  ResolvedResourceCatalog,
} from "@pico/core/resource-catalog";

export type { ResourceCatalogConflict, ResourceCatalogFormat, ResourceCatalogScope };

export type ResourceCatalogSource = CoreResourceCatalogSource<HookTrustAuthority>;
export type ExternalResourceCatalogSource = CoreExternalResourceCatalogSource<HookTrustAuthority>;
export type ResourceCatalogCandidate<Value> = CoreResourceCatalogCandidate<
  Value,
  HookTrustAuthority
>;
export type ProjectedResourceCatalogEntry<Value> = CoreProjectedResourceCatalogEntry<
  Value,
  HookTrustAuthority
>;
export type ProjectedResourceCatalog<Value> = CoreProjectedResourceCatalog<
  Value,
  HookTrustAuthority
>;
export type { ResolvedResourceCatalog };

export const canonicalResourceName = canonicalCoreResourceName;

export function resolveResourceCatalog<Value>(
  candidates: readonly ResourceCatalogCandidate<Value>[],
): ResolvedResourceCatalog<Value> {
  return resolveCoreResourceCatalog(candidates);
}

export function projectResourceCatalog<Value>(
  candidates: readonly ResourceCatalogCandidate<Value>[],
): ProjectedResourceCatalog<Value> {
  return projectCoreResourceCatalog(candidates);
}
