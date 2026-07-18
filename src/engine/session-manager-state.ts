import { resolvePicoPaths } from "../paths/pico-paths.js";

/** Process-level drain fences shared by every SessionManager instance. */
export const sessionDrains = new Map<string, Promise<void>>();

export function sessionEntryKey(id: string, workDir: string, picoHome?: string): string {
  return `${resolvePicoPaths(workDir, { picoHome }).workspace.root}\0${id}`;
}

/** Join a newly closing Session to an existing per-key drain fence. */
export function registerSessionDrain(key: string, drain: Promise<void>): Promise<void> {
  const previous = sessionDrains.get(key);
  const tracked = previous ? Promise.all([previous, drain]).then(() => undefined) : drain;
  sessionDrains.set(key, tracked);
  void tracked.then(
    () => {
      if (sessionDrains.get(key) === tracked) sessionDrains.delete(key);
    },
    () => {
      if (sessionDrains.get(key) === tracked) sessionDrains.delete(key);
    },
  );
  return tracked;
}
