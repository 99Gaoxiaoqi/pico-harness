import type { ModelRoute } from "../provider/model-router.js";
import type { ModelOption } from "./model-selector.js";

export function buildModelOptions(routes: readonly ModelRoute[] = []): ModelOption[] {
  return routes.map((route) => ({
    id: route.id,
    name: route.model,
    description: `${route.providerId} · ${route.provider}`,
  }));
}

export function modelSelectionToCommand(modelId: string): string {
  return `/model ${modelId}`;
}
