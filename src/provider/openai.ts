// Compatibility entry point; request encoding and response parsing are owned by AI SDK.
import { AiSdkProvider } from "./ai-sdk-provider.js";
import type { ProviderConfig } from "./config.js";
import type { ProviderProfile } from "./profile.js";
export class OpenAIProvider extends AiSdkProvider {
  constructor(config: ProviderConfig, profile?: ProviderProfile) {
    super("openai", config, profile);
  }
}
