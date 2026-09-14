import {
  AgentProfileLoader as HostAgentProfileLoader,
  type AgentProfile as HostAgentProfile,
  type AgentProfileLoaderOptions as HostAgentProfileLoaderOptions,
  type AgentProfileLoadResult as HostAgentProfileLoadResult,
} from "@pico/pico-host/agent-profile-loader";
import type { HookTrustAuthority } from "@pico/pico-host/hooks/trust/store";
import { logger } from "../observability/logger.js";

export { KNOWN_TOOL_NAMES } from "@pico/pico-host/agent-profile-loader";
export type AgentProfile = HostAgentProfile<HookTrustAuthority>;
export type AgentProfileLoadResult = HostAgentProfileLoadResult<HookTrustAuthority>;
export type AgentProfileLoaderOptions = Omit<HostAgentProfileLoaderOptions, "logger">;

/** @deprecated Agent Profile 文件加载已迁至 Pico Host；此类仅注入旧宿主日志。 */
export class AgentProfileLoader extends HostAgentProfileLoader<HookTrustAuthority> {
  constructor(workDir: string, options: AgentProfileLoaderOptions = {}) {
    super(workDir, { ...options, logger });
  }
}
