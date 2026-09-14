import {
  findAgentProfile,
  loadAgentCatalog as loadHostAgentCatalog,
  summarizeAgentProfiles,
  type AgentCatalogSource,
  type AgentExternalCatalogSource as HostAgentExternalCatalogSource,
  type AgentProfileSummary,
  type CatalogAgentProfile as HostCatalogAgentProfile,
  type LoadAgentCatalogOptions as HostLoadAgentCatalogOptions,
} from "@pico/pico-host/agent-catalog";
import type { HookTrustAuthority } from "@pico/pico-host/hooks/trust/store";
import { logger } from "../observability/logger.js";

export { findAgentProfile, summarizeAgentProfiles };
export type { AgentCatalogSource, AgentProfileSummary };
export type CatalogAgentProfile = HostCatalogAgentProfile<HookTrustAuthority>;
export type AgentExternalCatalogSource = HostAgentExternalCatalogSource<HookTrustAuthority>;
export type LoadAgentCatalogOptions = Omit<
  HostLoadAgentCatalogOptions<HookTrustAuthority>,
  "logger"
>;

/** @deprecated Agent Catalog 已迁至 Pico Host；此入口仅注入旧宿主日志与信任类型。 */
export function loadAgentCatalog(
  options: LoadAgentCatalogOptions,
): Promise<CatalogAgentProfile[]> {
  return loadHostAgentCatalog<HookTrustAuthority>({ ...options, logger });
}
