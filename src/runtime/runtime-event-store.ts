/**
 * Compatibility export for Runtime callers. The JSONL durable store is a
 * persistence adapter and is owned by the storage layer; Runtime keeps this
 * module path so existing host imports remain stable.
 */
export * from "../storage/runtime-event-store.js";
