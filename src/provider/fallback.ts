import { resolveProviderProfile } from "./profile.js";

export const GLM_52_MODEL = "glm-5.2";
export const GLM_52_FALLBACK_MODEL = "kimi-k2.5";

export function fallbackModelFor(model: string): string | undefined {
  return resolveProviderProfile("openai", model).fallbackModel;
}

export function isModelUnavailableError(error: unknown, model: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const normalizedModel = model.toLowerCase();

  if (!lower.includes("model") && !lower.includes("模型") && !lower.includes(normalizedModel)) {
    return false;
  }

  return [
    "unavailable",
    "not found",
    "does not exist",
    "not exist",
    "unsupported",
    "quota",
    "rate limit",
    "ratelimit",
    "throttling",
    "429",
    "不可用",
    "不存在",
    "未找到",
    "不支持",
  ].some((keyword) => lower.includes(keyword));
}
