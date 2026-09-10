import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolAccesses } from "./tool-access.js";

interface FileClaim {
  kind: "file";
  path: string;
  /** Conservative creation alias only; never rewrites the path used for actual I/O. */
  creationAlias: string;
  inode?: string;
  write: boolean;
}
type Claim =
  | FileClaim
  | { kind: "all" }
  | { kind: "resource"; key: string }
  | { kind: "capacity"; key: string; limit: number };
interface Waiter {
  claims?: readonly Claim[];
  signal?: AbortSignal;
  abort?: () => void;
  start: () => void;
  reject: (error: unknown) => void;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/** Resolve existing symlinks, including the nearest existing parent of a new file. */
async function canonicalPath(input: string): Promise<string> {
  const path = resolve(input);
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), path.slice(parent.length));
  }
}

async function resolveClaims(accesses: ToolAccesses): Promise<readonly Claim[]> {
  return Promise.all(
    accesses.map(async (access): Promise<Claim> => {
      if (access.kind === "all") return { kind: "all" };
      if (access.kind === "resource") return { kind: "resource", key: access.key };
      if (!isAbsolute(access.path))
        throw new Error("Resource authority requires absolute file paths");
      const path = await canonicalPath(access.path);
      let inode: string | undefined;
      try {
        const metadata = await stat(path, { bigint: true });
        inode = `${metadata.dev}:${metadata.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        kind: "file",
        path,
        creationAlias: path.toLowerCase(),
        ...(inode ? { inode } : {}),
        write: access.operation !== "read",
      };
    }),
  );
}

function within(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

class ResourceVersionChanged extends Error {}

function conflicts(left: readonly Claim[], right: readonly Claim[]): boolean {
  return left.some((a) =>
    right.some((b) => {
      if (a.kind === "capacity" || b.kind === "capacity") return false;
      if (a.kind === "all" || b.kind === "all") return true;
      if (a.kind === "resource" || b.kind === "resource") {
        return a.kind === "resource" && b.kind === "resource" && a.key === b.key;
      }
      return (
        (a.write || b.write) &&
        ((a.inode !== undefined && a.inode === b.inode) ||
          ((a.inode === undefined || b.inode === undefined) &&
            a.creationAlias === b.creationAlias) ||
          within(a.path, b.path) ||
          within(b.path, a.path))
      );
    }),
  );
}

/**
 * Shared execution-host authority, independent of any one model batch/Registry.
 * Other OS processes require the existing workspace/session ownership boundary;
 * this is deliberately not a distributed lock or protection against external writers.
 * Cancellation never releases an active claim before the physical operation settles.
 */
export class ToolResourceAuthority {
  private readonly active = new Set<Waiter>();
  private readonly queued: Waiter[] = [];
  private readonly capacities = new Map<string, number>();

  async run<T>(
    accesses: ToolAccesses,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Atomic file publication legitimately replaces the inode. Release and reacquire
    // using the new identity; never keep an old inode lease or rerun an operation.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.enqueue(resolveClaims(accesses), signal, async (claims) => {
          const current = await resolveClaims(accesses);
          if (JSON.stringify(current) !== JSON.stringify(claims)) {
            const retargeted = current.some((claim, index) => {
              const old = claims[index];
              return claim.kind === "file" && (old?.kind !== "file" || old.path !== claim.path);
            });
            if (retargeted)
              throw new Error("Tool resource path was retargeted while awaiting admission");
            throw new ResourceVersionChanged();
          }
          signal?.throwIfAborted();
          return operation();
        });
      } catch (error) {
        if (!(error instanceof ResourceVersionChanged)) throw error;
      }
    }
    throw new Error("Tool resource is changing too frequently for safe admission");
  }

  /** Capacity is separate from file exclusion; unrelated resources do not block on it. */
  runLimited<T>(
    key: string,
    limit: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!key || !Number.isSafeInteger(limit) || limit < 1)
      return Promise.reject(new Error("Invalid resource capacity"));
    const previous = this.capacities.get(key);
    if (previous !== undefined && previous !== limit)
      return Promise.reject(new Error(`Resource capacity changed for ${key}`));
    this.capacities.set(key, limit);
    return this.enqueue(Promise.resolve([{ kind: "capacity", key, limit }]), signal, operation);
  }

  private enqueue<T>(
    claims: Promise<readonly Claim[]>,
    signal: AbortSignal | undefined,
    operation: (claims: readonly Claim[]) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolveResult, reject) => {
      const waiter: Waiter = {
        signal,
        reject,
        start: () => {
          this.active.add(waiter);
          if (waiter.abort) signal?.removeEventListener("abort", waiter.abort);
          void Promise.resolve()
            .then(() => {
              signal?.throwIfAborted();
              return operation(waiter.claims!);
            })
            .then(resolveResult, reject)
            .finally(() => {
              this.active.delete(waiter);
              this.pump();
            });
        },
      };
      const remove = (error: unknown) => {
        const index = this.queued.indexOf(waiter);
        if (index < 0) return;
        this.queued.splice(index, 1);
        if (waiter.abort) signal?.removeEventListener("abort", waiter.abort);
        reject(error);
        this.pump();
      };
      this.queued.push(waiter);
      waiter.abort = () => remove(abortError(signal));
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      void claims.then((resolved) => {
        waiter.claims = resolved;
        this.pump();
      }, remove);
    });
  }

  private pump(): void {
    for (let index = 0; index < this.queued.length; ) {
      const waiter = this.queued[index]!;
      const claims = waiter.claims;
      if (!claims) {
        index++;
        continue;
      }
      const earlier = this.queued.slice(0, index);
      const blocked =
        [...this.active].some((other) => conflicts(claims, other.claims!)) ||
        earlier.some(
          (other) =>
            !other.claims ||
            conflicts(claims, other.claims) ||
            claims.some(
              (claim) =>
                claim.kind === "capacity" &&
                other.claims!.some((next) => next.kind === "capacity" && next.key === claim.key),
            ),
        ) ||
        claims.some(
          (claim) =>
            claim.kind === "capacity" &&
            [...this.active].filter((other) =>
              other.claims!.some((next) => next.kind === "capacity" && next.key === claim.key),
            ).length >= claim.limit,
        );
      if (blocked) {
        index++;
        continue;
      }
      this.queued.splice(index, 1);
      waiter.start();
    }
  }
}

export const sharedToolResourceAuthority = new ToolResourceAuthority();
