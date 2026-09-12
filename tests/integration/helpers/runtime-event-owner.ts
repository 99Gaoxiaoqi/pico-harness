import type {
  InitializeRuntimeSessionOptions,
  RuntimeOwnerFence,
  RuntimeSessionManifest,
} from "../../../src/storage/runtime-event-store-contracts.js";
import type { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";

/** Test owner stand-in: initialize the namespace, then claim one positive fencing epoch. */
export async function initializeRuntimeEventOwner(
  store: SqliteRuntimeEventStore,
  options: InitializeRuntimeSessionOptions,
): Promise<{
  readonly manifest: RuntimeSessionManifest;
  readonly ownerFence: RuntimeOwnerFence;
}> {
  const manifest = await store.initializeSession(options);
  const current = await store.readOwnerFence(options.sessionId);
  const ownerFence = await store.advanceOwnerFence(options.sessionId, current.epoch);
  return { manifest, ownerFence };
}
