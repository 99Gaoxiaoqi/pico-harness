import { resolvePicoPaths } from "../paths/pico-paths.js";

/** Process-level drain fences shared by every SessionManager instance. */
export const sessionDrains = new Map<string, Promise<void>>();
const sessionManagerOwners = new Map<string, symbol>();

export function sessionEntryKey(id: string, workDir: string, picoHome?: string): string {
  return `${resolvePicoPaths(workDir, { picoHome }).workspace.root}\0${id}`;
}

/** Prevent two manager instances from owning mutable Session objects for one durable key. */
export function claimSessionManagerKey(key: string, owner: symbol): boolean {
  const current = sessionManagerOwners.get(key);
  if (current !== undefined) return current === owner;
  sessionManagerOwners.set(key, owner);
  return true;
}

export function releaseSessionManagerKey(key: string, owner: symbol): void {
  if (sessionManagerOwners.get(key) === owner) sessionManagerOwners.delete(key);
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
