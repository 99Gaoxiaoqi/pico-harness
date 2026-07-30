import { createHash } from "node:crypto";
import type { Message, ToolDefinition } from "../schema/message.js";

/**
 * Serialize JSON-shaped provider inputs deterministically.  Prompt-cache
 * matching is byte-sensitive for several providers, so object insertion order
 * must never leak from dynamically assembled JSON schemas.  Array order stays
 * significant by design (for example enum values and required tool order).
 */
export function stableJson(value: unknown): string {
  const serialized = JSON.stringify(stableJsonValue(value));
  if (serialized === undefined) throw new Error("Prompt-cache value is not JSON serializable");
  return serialized;
}

/** Return a recursively key-sorted JSON value without mutating the caller's schema. */
export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item));
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    // Match JSON.stringify semantics for object properties.
    if (item !== undefined) normalized[key] = stableJsonValue(item);
  }
  return normalized;
}

/**
 * Provider-visible tools are sorted by name and their schemas are normalized
 * once.  The returned definitions are isolated from registry-owned objects so
 * cache breakpoint injection and protocol translation cannot mutate a tool.
 */
export function snapshotToolDefinitions(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return [...tools]
    .map((tool) => ({
      ...tool,
      inputSchema: stableJsonValue(tool.inputSchema) as Record<string, unknown>,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface PromptCacheRevisions {
  system: string;
  tools: string;
  /** Stable system + tool prefix, intentionally excluding conversation/user content. */
  prefix: string;
}

/**
 * Revisions are opaque hashes only.  Do not add user text, API keys, or route
 * credentials here: the value is sent as an OpenAI cache key and is eligible
 * for logs in upstream providers.
 */
export function promptCacheRevisions(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
): PromptCacheRevisions {
  const system = hash(
    stableJson(
      messages
        .filter((message) => message.role === "system")
        .map((message) => ({ role: message.role, content: message.content })),
    ),
  );
  const toolRevision = hash(stableJson(snapshotToolDefinitions(tools)));
  return {
    system,
    tools: toolRevision,
    prefix: hash(`${system}\0${toolRevision}`),
  };
}

/** Deterministic, privacy-safe OpenAI cache-key shape (under the API key limit). */
export function openAIPromptCacheKey(
  model: string,
  revisions: PromptCacheRevisions,
  keyShards = 1,
): string {
  const shards = Math.max(1, keyShards);
  // There is intentionally no user/session text in the seed.  Until the
  // provider interface carries a stable session identity, every route with an
  // identical stable prefix resolves to one deterministic shard.
  const shard = Number.parseInt(hash(`${model}\0${revisions.prefix}`).slice(0, 8), 16) % shards;
  return `pico:${hash(model).slice(0, 12)}:${revisions.prefix.slice(0, 40)}:${shard}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
