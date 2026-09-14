import {
  PromptCachePrewarmCoordinator as RuntimePromptCachePrewarmCoordinator,
  withPromptCachePrewarm as withRuntimePromptCachePrewarm,
} from "@pico/runtime/provider/prompt-cache-prewarm";
import { logger } from "../observability/logger.js";

/** @deprecated Runtime owns prewarm; this entry only supplies legacy diagnostics. */
export class PromptCachePrewarmCoordinator extends RuntimePromptCachePrewarmCoordinator {
  constructor(now: () => number = Date.now) {
    super(now, logger);
  }

  static override shared(scope: string): RuntimePromptCachePrewarmCoordinator {
    return RuntimePromptCachePrewarmCoordinator.shared(scope, logger);
  }
}

export function withPromptCachePrewarm(
  ...[kind, provider, config, coordinator]: Parameters<typeof withRuntimePromptCachePrewarm>
) {
  return withRuntimePromptCachePrewarm(kind, provider, config, coordinator, logger);
}
