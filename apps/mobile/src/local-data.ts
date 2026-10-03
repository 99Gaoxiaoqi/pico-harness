import AsyncStorage from "@react-native-async-storage/async-storage";
import { drafts } from "./draft-store.js";
import {
  blockReviewHost,
  clearReviewHost,
  hasUnconfirmedReviewHost,
} from "./review-request-storage.js";
import { clearHostArtifactCache, hasLegacyArtifactCache } from "./artifact-cache.js";

const cleanups = new Map<string, Promise<unknown>>();

export async function inspectHostLocalData(
  hostId: string,
): Promise<{ hasUnconfirmed: boolean; legacyCache: boolean }> {
  const [draftPending, reviewPending] = await Promise.all([
    drafts.hasUnconfirmedHost(hostId),
    hasUnconfirmedReviewHost(AsyncStorage, hostId),
  ]);
  return { hasUnconfirmed: draftPending || reviewPending, legacyCache: hasLegacyArtifactCache() };
}

/** The caller disconnects this host and cancels its pairing before invoking cleanup. */
export function clearHostLocalData(
  hostId: string,
  options: { discardUnconfirmed?: boolean } = {},
): Promise<{ legacyCacheRemaining: boolean }> {
  const previous = cleanups.get(hostId) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const unblockDrafts = drafts.blockHost(hostId);
      const unblockReviews = blockReviewHost(AsyncStorage, hostId);
      try {
        // Block new saves and drain native writes before deciding whether recovery can be discarded.
        if ((await inspectHostLocalData(hostId)).hasUnconfirmed && !options.discardUnconfirmed)
          throw new Error(
            "这台电脑还有结果未确认的发送或审阅，请先核对，或明确放弃本机恢复记录后清除",
          );
        const results = await Promise.allSettled([
          drafts.clearHost(hostId),
          clearReviewHost(AsyncStorage, hostId),
          clearHostArtifactCache(hostId),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return { legacyCacheRemaining: hasLegacyArtifactCache() };
      } finally {
        unblockDrafts();
        unblockReviews();
      }
    });
  cleanups.set(hostId, operation);
  void operation
    .finally(() => {
      if (cleanups.get(hostId) === operation) cleanups.delete(hostId);
    })
    .catch(() => {});
  return operation;
}
