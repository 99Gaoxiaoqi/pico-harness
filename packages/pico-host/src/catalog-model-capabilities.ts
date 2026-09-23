import { MODEL_CAPABILITY_CATALOG } from "./model-capabilities.generated.js";

type CatalogRow = (typeof MODEL_CAPABILITY_CATALOG)[number];
const byEndpointAndModel = new Map<string, CatalogRow | null>();

for (const row of MODEL_CAPABILITY_CATALOG) {
  const key = JSON.stringify([row.api, row.model]);
  const previous = byEndpointAndModel.get(key);
  if (previous === undefined) byEndpointAndModel.set(key, row);
  else if (previous && JSON.stringify(previous) !== JSON.stringify(row))
    byEndpointAndModel.set(key, null);
}

/** Exact endpoint and model match only: another gateway may serve the same ID differently. */
export function catalogModelCapabilities(baseURL: string, model: string): CatalogRow | undefined {
  try {
    const url = new URL(baseURL);
    const endpoint = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    return byEndpointAndModel.get(JSON.stringify([endpoint, model])) ?? undefined;
  } catch {
    return undefined;
  }
}
