# Provider Profile 优化记录

## 当前 pico 实现思路

优化前的 Provider 逻辑分散在 `factory.ts`、`openai.ts`、`claude.ts` 中。例如 `glm-5.2` fallback 写在工厂里,OpenAI assistant 空 content 的兼容逻辑写在适配器里,Claude `max_tokens` 也是硬编码。

## Hermes 对应实现思路

Hermes 用 ProviderProfile 描述模型能力、协议格式、fallback、reasoning 字段、prompt cache 支持等 provider quirk。传输层读取 profile,而不是到处写 if-else。

## 优化后设计

- 新增 `src/provider/profile.ts`。
- `resolveProviderProfile(protocol, model)` 返回声明式 profile。
- `OpenAIProvider` 根据 profile 决定 assistant 空 content 是否用 `null`。
- `OpenAIProvider` 解析 `reasoning_content`、`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`。
- `ClaudeProvider` 解析 `cache_creation_input_tokens`、`cache_read_input_tokens`,并从 profile 读取 `maxOutputTokens`。
- `factory.ts` 的 fallback 查询改为读取 profile。

## 取舍说明

借鉴 Hermes 的 profile 思路,但只覆盖当前项目已经支持的 OpenAI-compatible 与 Claude。暂不扩展 Bedrock、Gemini、OpenRouter 等多协议。

## 油耗对比

| 指标 | 优化前 | 优化后 |
|---|---|---|
| `cacheReadTokens` | 丢失 | OpenAI/Claude 均可解析 |
| `cacheWriteTokens` | 丢失 | Claude 可解析 |
| `reasoningTokens` | 丢失 | OpenAI-compatible 可解析 |
| `costCNY` | cache/reasoning 混入总 input/output | 可由 pricing 按五桶估算 |

## 验证记录

- `tests/provider.test.ts`: 覆盖 OpenAI cache/reasoning、Claude cache usage、ProviderProfile fallback。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
