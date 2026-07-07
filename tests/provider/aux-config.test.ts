// 辅助模型配置层 (5.3a) 单测。
// 验证:全变量 → 返回 config;缺一 → undefined;kind 默认 openai,可指定;
// createAuxProvider → 返回 LLMProvider(modelName 正确)。
//
// 注意:测试中保存 / 恢复 process.env,避免相互污染。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuxProvider, loadAuxProviderConfig } from "../../src/provider/aux-config.js";

const AUX_VARS = ["AUX_LLM_BASE_URL", "AUX_LLM_API_KEY", "AUX_LLM_MODEL", "AUX_LLM_PROVIDER"] as const;

describe("aux-config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // 保存相关环境变量
    for (const key of AUX_VARS) savedEnv[key] = process.env[key];
    // 清空,保证每个用例起点干净
    for (const key of AUX_VARS) delete process.env[key];
  });

  afterEach(() => {
    // 恢复
    for (const key of AUX_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("loadAuxProviderConfig", () => {
    it("全部 AUX_LLM_* 就绪 → 返回 config,kind 默认 openai", () => {
      process.env.AUX_LLM_BASE_URL = "https://aux.example.com/v1";
      process.env.AUX_LLM_API_KEY = "sk-aux";
      process.env.AUX_LLM_MODEL = "aux-model";

      const cfg = loadAuxProviderConfig();
      expect(cfg).toEqual({
        baseURL: "https://aux.example.com/v1",
        apiKey: "sk-aux",
        model: "aux-model",
        kind: "openai",
      });
    });

    it("显式指定 kind(如 claude/gemini)→ 透传", () => {
      process.env.AUX_LLM_BASE_URL = "https://api.anthropic.com";
      process.env.AUX_LLM_API_KEY = "sk-claude";
      process.env.AUX_LLM_MODEL = "claude-sonnet";
      process.env.AUX_LLM_PROVIDER = "claude";

      expect(loadAuxProviderConfig()?.kind).toBe("claude");

      process.env.AUX_LLM_PROVIDER = "gemini";
      expect(loadAuxProviderConfig()?.kind).toBe("gemini");
    });

    it("缺 BASE_URL → 返回 undefined", () => {
      process.env.AUX_LLM_API_KEY = "sk-aux";
      process.env.AUX_LLM_MODEL = "aux-model";
      expect(loadAuxProviderConfig()).toBeUndefined();
    });

    it("缺 API_KEY → 返回 undefined", () => {
      process.env.AUX_LLM_BASE_URL = "https://aux.example.com/v1";
      process.env.AUX_LLM_MODEL = "aux-model";
      expect(loadAuxProviderConfig()).toBeUndefined();
    });

    it("缺 MODEL → 返回 undefined", () => {
      process.env.AUX_LLM_BASE_URL = "https://aux.example.com/v1";
      process.env.AUX_LLM_API_KEY = "sk-aux";
      expect(loadAuxProviderConfig()).toBeUndefined();
    });

    it("全部缺失 → 返回 undefined", () => {
      expect(loadAuxProviderConfig()).toBeUndefined();
    });
  });

  describe("createAuxProvider", () => {
    it("返回 LLMProvider,modelName 正确", () => {
      const provider = createAuxProvider({
        baseURL: "https://aux.example.com/v1",
        apiKey: "sk-aux",
        model: "aux-model",
      });
      expect(provider.modelName).toBe("aux-model");
      expect(typeof provider.generate).toBe("function");
    });

    it("kind 默认 openai(无 fallback profile 时直接 OpenAIProvider)", () => {
      const provider = createAuxProvider({
        baseURL: "https://aux.example.com/v1",
        apiKey: "sk-aux",
        model: "gpt-4o-mini",
      });
      expect(provider.modelName).toBe("gpt-4o-mini");
    });

    it("显式 claude → 创建 ClaudeProvider", () => {
      const provider = createAuxProvider({
        baseURL: "https://api.anthropic.com",
        apiKey: "sk-claude",
        model: "claude-sonnet-4",
        kind: "claude",
      });
      expect(provider.modelName).toBe("claude-sonnet-4");
    });

    it("显式 gemini → 创建 GeminiProvider", () => {
      const provider = createAuxProvider({
        baseURL: "https://generativelanguage.googleapis.com",
        apiKey: "sk-gemini",
        model: "gemini-2.5-pro",
        kind: "gemini",
      });
      expect(provider.modelName).toBe("gemini-2.5-pro");
    });
  });
});
