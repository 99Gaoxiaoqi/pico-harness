import type { ApprovalResult } from "./manager.js";

export interface PermissionSource {
  name: string;
  promise: Promise<ApprovalResult>;
  cleanup: () => void;
}

export interface RacePermissionSourcesOptions {
  sources: PermissionSource[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function racePermissionSources({
  sources,
  signal,
  timeoutMs,
}: RacePermissionSourcesOptions): Promise<ApprovalResult> {
  if (sources.length === 0) {
    return Promise.reject(new Error("Permission race requires at least one source"));
  }

  return new Promise<ApprovalResult>((resolve, reject) => {
    let settled = false;
    let rejectedCount = 0;
    let firstRejection: unknown;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanupSource = (source: PermissionSource): void => {
      try {
        source.cleanup();
      } catch {
        // Best effort: cleanup must not mask the winning decision or abort reason.
      }
    };

    const cleanupAll = (): void => {
      for (const source of sources) {
        cleanupSource(source);
      }
    };

    const finishReject = (error: Error | unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
      cleanupAll();
      reject(error);
    };

    const onAbort = (): void => {
      finishReject(new Error("Permission race aborted"));
    };

    if (signal?.aborted) {
      finishReject(new Error("Permission race aborted"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        finishReject(new Error(`Permission race timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    for (const source of sources) {
      source.promise.then(
        (decision) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
          }
          signal?.removeEventListener("abort", onAbort);
          for (const loser of sources) {
            if (loser !== source) {
              cleanupSource(loser);
            }
          }
          resolve(decision);
        },
        (error) => {
          if (settled) {
            return;
          }
          firstRejection ??= error;
          rejectedCount += 1;
          if (rejectedCount === sources.length) {
            finishReject(firstRejection);
          }
        },
      );
    }
  });
}
