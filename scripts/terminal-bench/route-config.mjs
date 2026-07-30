const benchmarkOutputTokensByRoute = new Map([["codex-oauth/gpt-5.4", 8_192]]);

export function buildBenchmarkRouteConfig({
  modelRouteId,
  providerId,
  model,
  provider,
  pricing,
  pricingSha256,
  maxRunCostCNY,
  thinkingEffort,
}) {
  if (modelRouteId !== `${providerId}/${model}`) {
    throw new Error("Benchmark route identity is inconsistent");
  }
  return {
    schemaVersion: 1,
    modelRouteId,
    providerId,
    provider: applyBenchmarkRouteContract(provider, { providerId, model }),
    pricing,
    pricingSha256,
    runBudget: {
      currency: "CNY",
      maxCostMicroCNY: maxRunCostCNY * 1_000_000,
    },
    ...(thinkingEffort ? { thinkingEffort } : {}),
  };
}

export function applyBenchmarkRouteContract(provider, { providerId, model }) {
  const prepared = structuredClone(provider);
  const outputTokens = benchmarkOutputTokensByRoute.get(`${providerId}/${model}`);
  if (outputTokens === undefined) {
    return prepared;
  }
  if (prepared.protocol !== "openai") {
    throw new Error(`${providerId}/${model} benchmark route requires the OpenAI protocol`);
  }
  const capabilities = prepared.modelCapabilities;
  if (
    capabilities !== undefined &&
    (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities))
  ) {
    throw new Error("Benchmark provider modelCapabilities must be an object");
  }
  const modelCapability = capabilities?.[model];
  if (
    modelCapability !== undefined &&
    (modelCapability === null ||
      typeof modelCapability !== "object" ||
      Array.isArray(modelCapability))
  ) {
    throw new Error(`Benchmark model capability for ${model} must be an object`);
  }
  prepared.modelCapabilities = {
    ...capabilities,
    [model]: {
      ...modelCapability,
      output: outputTokens,
      outputTokenField: "max_completion_tokens",
    },
  };
  return prepared;
}
