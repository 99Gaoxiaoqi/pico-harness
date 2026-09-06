// Compatibility entry point; request encoding and response parsing are owned by AI SDK.
import { AiSdkProvider } from "./ai-sdk-provider.js";
import type { ProviderConfig } from "./config.js";
import type { ProviderProfile } from "./profile.js";
export class ClaudeProvider extends AiSdkProvider {
  constructor(config: ProviderConfig, profile?: ProviderProfile) {
    super("claude", config, profile);
  }
}
