/** @deprecated Desktop catalog enumeration has moved to @pico/pico-host. */
import {
  listDesktopAgents as listHostDesktopAgents,
  listDesktopEffectiveSkills as listHostDesktopEffectiveSkills,
  listDesktopMcpServers as listHostDesktopMcpServers,
  listDesktopSkills as listHostDesktopSkills,
  listDesktopUserSkills as listHostDesktopUserSkills,
  type DesktopResourceCatalogOptions as HostDesktopResourceCatalogOptions,
} from "@pico/pico-host/desktop-resource-catalog";
import { loadPicoProjectConfig } from "../input/pico-config.js";
import { logger } from "../observability/logger.js";

export type {
  DesktopEffectiveSkillCatalog,
  DesktopUserSkillCatalog,
  RuntimeScopedSkill,
} from "@pico/pico-host/desktop-resource-catalog";

export type DesktopResourceCatalogOptions = Omit<
  HostDesktopResourceCatalogOptions,
  "loadPicoProjectConfig" | "logger"
>;

export function listDesktopUserSkills(options: DesktopResourceCatalogOptions) {
  return listHostDesktopUserSkills({ ...options, loadPicoProjectConfig, logger });
}

export function listDesktopEffectiveSkills(
  trustedWorkspacePath: string,
  options: DesktopResourceCatalogOptions,
) {
  return listHostDesktopEffectiveSkills(trustedWorkspacePath, {
    ...options,
    loadPicoProjectConfig,
    logger,
  });
}

export function listDesktopAgents(workspacePath: string, options: DesktopResourceCatalogOptions) {
  return listHostDesktopAgents(workspacePath, { ...options, loadPicoProjectConfig, logger });
}

export function listDesktopSkills(
  workspacePath: string,
  includeUserResources: boolean,
  options: DesktopResourceCatalogOptions,
) {
  return listHostDesktopSkills(workspacePath, includeUserResources, {
    ...options,
    loadPicoProjectConfig,
    logger,
  });
}

export function listDesktopMcpServers(workspacePath: string, options: DesktopResourceCatalogOptions) {
  return listHostDesktopMcpServers(workspacePath, { ...options, loadPicoProjectConfig, logger });
}
