import {
  SkillLoader as HostSkillLoader,
  SkillViewTool as HostSkillViewTool,
  parseSkillMD as parseHostSkillMarkdown,
  type Skill as HostSkill,
  type SkillCatalogSnapshot as HostSkillCatalogSnapshot,
  type SkillLoaderOptions as HostSkillLoaderOptions,
} from "@pico/pico-host/skill-catalog";
import type { HookTrustAuthority } from "@pico/pico-host/hooks/trust/store";
import { logger } from "../observability/logger.js";

export type Skill = HostSkill<HookTrustAuthority>;
export type SkillSummary = { name: string; description: string };
export type SkillLoaderOptions = Omit<HostSkillLoaderOptions<HookTrustAuthority>, "logger">;
export type SkillCatalogSnapshot = HostSkillCatalogSnapshot<HookTrustAuthority>;
export type { SkillCatalogLogger } from "@pico/pico-host/skill-catalog";

/** @deprecated Skill 文件扫描和来源优先级已移至 @pico/pico-host。 */
export class SkillLoader extends HostSkillLoader<HookTrustAuthority> {
  constructor(workDir: string, options: SkillLoaderOptions = {}) {
    super(workDir, { ...options, logger });
  }
}

/** @deprecated Skill 工具实现已移至 @pico/pico-host。 */
export class SkillViewTool extends HostSkillViewTool<HookTrustAuthority> {
  constructor(loader: SkillLoader, onActivateHooks?: (skill: Skill) => void | Promise<void>) {
    super(loader, onActivateHooks);
  }
}

/** @deprecated SKILL.md 的结构化解析已移至 @pico/pico-host。 */
export function parseSkillMD(content: string, fallbackName = "Unknown Skill"): Skill {
  return parseHostSkillMarkdown<HookTrustAuthority>(content, fallbackName);
}
