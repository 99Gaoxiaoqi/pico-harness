import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const snapshotPath = new URL("./model-pricing/snapshot.json", import.meta.url);
const target = new URL("../src/observability/model-pricing.generated.ts", import.meta.url);
let snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const defaults = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.com/v2",
};
if (process.argv.includes("--refresh")) {
  const response = await fetch("https://models.dev/api.json", {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const data = await response.json();
  const rows = [];
  for (const [provider, facts] of Object.entries(data)) {
    for (const [model, info] of Object.entries(facts.models ?? {})) {
      const cost = info.cost;
      if (!cost || cost.input === undefined || cost.output === undefined) continue;
      rows.push({
        provider,
        name: facts.name ?? provider,
        model,
        api: facts.api ?? defaults[provider] ?? "",
        inputPerMillion: cost.input,
        outputPerMillion: cost.output,
        cacheReadPerMillion: cost.cache_read ?? null,
        cacheWritePerMillion: cost.cache_write ?? null,
      });
    }
  }
  snapshot = {
    source: "https://models.dev/api.json",
    provenance: `Refreshed ${new Date().toISOString()}`,
    rows,
  };
}
if (!Array.isArray(snapshot.rows) || snapshot.rows.length === 0)
  throw new Error("Empty pricing snapshot");
const keys = new Set();
for (const row of snapshot.rows) {
  if (
    ![row.provider, row.model, row.name].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    typeof row.api !== "string"
  )
    throw new Error("Invalid pricing identity");
  const key = JSON.stringify([row.provider, row.model]);
  if (keys.has(key)) throw new Error(`Duplicate ${key}`);
  keys.add(key);
  for (const field of [
    "inputPerMillion",
    "outputPerMillion",
    "cacheReadPerMillion",
    "cacheWritePerMillion",
  ]) {
    const value = row[field];
    if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0))
      throw new Error(`Invalid price ${key}/${field}`);
  }
}
const payload = JSON.stringify(snapshot.rows);
const hash = createHash("sha256").update(payload).digest("hex");
const output = `// Generated from models.dev MIT data; Copyright (c) 2025 models.dev.\n// See resources/licenses/models-dev.txt. SHA-256: ${hash}\n// Regenerate: node scripts/sync-model-pricing.mjs (offline); add --refresh to update.\nexport const MODEL_PRICING = ${JSON.stringify(snapshot.rows, null, 2)};\n`;
if (process.argv.includes("--refresh"))
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n");
await writeFile(target, output);
console.log(`Generated ${snapshot.rows.length} model prices`);
