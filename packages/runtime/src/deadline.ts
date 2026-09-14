/** Schedules a bounded retry/poll delay through the shared Runtime timing primitive. */
export function waitForDelay(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export interface ScheduledDeadline {
  cancel(): void;
}

/** Schedule a cancellable deadline without exposing host-specific timer handles. */
export function scheduleDeadline(callback: () => void, delayMs: number): ScheduledDeadline {
  const timer = setTimeout(callback, delayMs);
  return {
    cancel: () => clearTimeout(timer),
  };
}

/** Schedule a cancellable deadline that does not keep a Node.js host process alive. */
export function scheduleUnrefDeadline(callback: () => void, delayMs: number): ScheduledDeadline {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return {
    cancel: () => clearTimeout(timer),
  };
}

/** Wait for a delay but reject immediately if the caller's lifecycle is aborted. */
export function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Races a target with a deadline; timeout is a normal incomplete result. */
export async function raceWithDeadline(
  target: Promise<unknown> | readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  if (Array.isArray(target)) {
    if (target.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(target).then((): true => true),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(target).then((): true => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Races a target with a deadline; timeout rejects with the caller's error. */
export async function raceWithDeadlineReject<T>(
  target: Promise<T>,
  timeoutMs: number,
  errorFactory: (timeoutMs: number) => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(errorFactory(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
