import { createHash } from "node:crypto";
import type { Message, ToolDefinition } from "../schema/message.js";
import { normalizePromptCacheEndpoint } from "./provider-endpoint.js";

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
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export interface PromptCacheRevisions {
  system: string;
  tools: string;
  /** Stable system + tool prefix, intentionally excluding conversation/user content. */
  prefix: string;
}

export interface OpenAIPromptCacheKeyOptions {
  /**
   * Opaque route digest. It includes provider/model/base URL/cache policy but never credentials,
   * so switching route domains cannot accidentally reuse the same cache identity.
   */
  routeIdentity?: string;
  /**
   * Opaque digest of the stable conversation seed. It only chooses a numeric shard and is never
   * embedded directly into the wire key.
   */
  conversationShardSeed?: string;
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
  options: OpenAIPromptCacheKeyOptions = {},
): string {
  const shards = Number.isSafeInteger(keyShards) && keyShards > 0 ? keyShards : 1;
  const routeIdentity = options.routeIdentity ?? hash(model);
  const shardSeed = options.conversationShardSeed ?? revisions.prefix;
  const shard = Number.parseInt(hash(shardSeed).slice(0, 12), 16) % shards;
  // Keep the key below OpenAI's 64-character limit even for large safe-integer shard counts.
  return `pico:${routeIdentity.slice(0, 12)}:${revisions.prefix.slice(0, 32)}:${shard.toString(36)}`;
}

/** Build a secret-free route cache identity; query strings and credentials are discarded. */
export function promptCacheRouteIdentity(input: {
  provider: string;
  model: string;
  baseURL: string;
  policy: unknown;
}): string {
  return hash(
    stableJson({
      provider: input.provider,
      model: input.model,
      baseURL: normalizePromptCacheEndpoint(input.baseURL),
      policy: input.policy,
    }),
  );
}

/**
 * Choose one stable conversation seed without exposing user text. The provider receives only this
 * digest and reduces it to a numeric shard; the base cache key remains model/system/tools based.
 */
export function promptCacheConversationShardSeed(messages: readonly Message[]): string | undefined {
  const anchor = messages.find((message) => message.role !== "system");
  if (!anchor) return undefined;
  return hash(stableJson({ role: anchor.role, content: anchor.content }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
