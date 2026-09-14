/** File-lock-local deadline helper; it is not the cross-runtime deadline primitive. */
export async function raceWithStorageFileLockDeadline<T>(
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
