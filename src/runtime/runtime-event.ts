/**
 * Compatibility export for Runtime callers.
 *
 * Runtime event schema, decoding and validation are durable-fact concerns and
 * live in the neutral storage layer. Runtime keeps this path stable for older
 * adapters and integrations.
 */
export * from "../storage/runtime-event.js";
