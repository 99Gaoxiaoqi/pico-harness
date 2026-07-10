// Keep every OpenAI-compatible historical E2E suite on the same public opt-in
// and credential contract. Provider-specific Claude/Gemini protocol suites are
// intentionally outside this acceptance lane.
process.env.PICO_OPENAI_E2E_BASE_URL ??= process.env.LLM_BASE_URL;
process.env.PICO_OPENAI_E2E_API_KEY ??= process.env.LLM_API_KEY;
process.env.PICO_OPENAI_E2E_MODEL ??= process.env.LLM_MODEL;
