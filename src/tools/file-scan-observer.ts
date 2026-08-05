import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkspaceFileScanReport {
  readonly scannedFiles: readonly string[];
}

interface WorkspaceFileScanObserverContext {
  readonly observer: (report: WorkspaceFileScanReport) => void;
  readonly parent?: WorkspaceFileScanObserverContext;
}

const observerStorage = new AsyncLocalStorage<WorkspaceFileScanObserverContext>();

export function observeWorkspaceFileScans<T>(
  observer: (report: WorkspaceFileScanReport) => void,
  execute: () => Promise<T>,
): Promise<T> {
  const parent = observerStorage.getStore();
  return observerStorage.run({ observer, ...(parent ? { parent } : {}) }, execute);
}

export function reportWorkspaceFileScans(scannedFiles: readonly string[]): void {
  if (scannedFiles.length === 0) return;
  let context = observerStorage.getStore();
  while (context) {
    context.observer({ scannedFiles });
    context = context.parent;
  }
}
