const REQUIRED_ENV = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;

export default async function setupRealLlmGate(): Promise<void> {
  if (process.env.RUN_LLM_E2E !== "1") {
    throw new Error(
      "Real LLM E2E is fail-closed. Set RUN_LLM_E2E=1 and provide LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL.",
    );
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Real LLM E2E is missing required configuration: ${missing.join(", ")}`);
  }

  const baseURL = process.env.LLM_BASE_URL!.replace(/\/+$/u, "");
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LLM_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL!,
      messages: [{ role: "user", content: "Reply exactly PICO_LLM_GATE_OK" }],
      // Thinking models may spend the first tokens on reasoning_content and
      // leave message.content empty when this probe is too small.
      max_tokens: 256,
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new Error(`Real LLM endpoint probe failed: ${formatError(error)}`);
  });

  if (!response.ok) {
    const diagnostic = (await response.text()).slice(0, 300).replace(/\s+/gu, " ");
    throw new Error(
      `Real LLM endpoint probe failed with HTTP ${response.status}: ${diagnostic || response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.includes("PICO_LLM_GATE_OK")) {
    throw new Error("Real LLM endpoint probe did not return the expected assistant marker");
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
