import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const response = await fetch("https://models.dev/api.json", {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
const catalog = await response.json();
const rows = [];
for (const provider of Object.values(catalog)) {
  if (typeof provider.api !== "string" || !provider.api) continue;
  for (const [model, info] of Object.entries(provider.models ?? {})) {
    if (!info || typeof info !== "object") continue;
    const input = info.modalities?.input;
    rows.push({
      api: provider.api.replace(/\/+$/u, ""),
      model,
      ...(typeof info.name === "string" ? { name: info.name } : {}),
      ...(Number.isSafeInteger(info.limit?.context) && info.limit.context > 0
        ? { context: info.limit.context }
        : {}),
      ...(Number.isSafeInteger(info.limit?.output) && info.limit.output > 0
        ? { output: info.limit.output }
        : {}),
      ...(Array.isArray(input) ? { vision: input.includes("image") } : {}),
      ...(typeof info.reasoning === "boolean" ? { reasoning: info.reasoning } : {}),
      ...(typeof info.tool_call === "boolean" ? { toolCall: info.tool_call } : {}),
    });
  }
}
if (rows.length < 1000) throw new Error("Capability catalog is unexpectedly small");
rows.sort((left, right) =>
  left.api.localeCompare(right.api) || left.model.localeCompare(right.model),
);
const payload = JSON.stringify(rows);
const hash = createHash("sha256").update(payload).digest("hex");
const source = `// Generated from models.dev MIT data; Copyright (c) 2025 models.dev.
// See resources/licenses/models-dev.txt. SHA-256: ${hash}
// Regenerate: node scripts/sync-model-capabilities.mjs
// prettier-ignore
export const MODEL_CAPABILITY_CATALOG: readonly {
  readonly api: string;
  readonly model: string;
  readonly name?: string;
  readonly context?: number;
  readonly output?: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
}[] = ${payload};
`;
await writeFile(new URL("../packages/pico-host/src/model-capabilities.generated.ts", import.meta.url), source);
console.log(`Generated ${rows.length} model capability records`);
