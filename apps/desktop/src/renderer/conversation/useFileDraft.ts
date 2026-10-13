import { useSyncExternalStore } from "react";
import { validateUploadFiles } from "../file-upload.js";

export interface DraftFile {
  readonly id: string;
  readonly file: File;
  readonly error?: string;
}

// File objects deliberately never enter localStorage. Drafts survive route remounts only in memory.
const drafts = new Map<string, readonly DraftFile[]>();
const listeners = new Set<() => void>();
const empty: readonly DraftFile[] = [];
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(key: string, value: readonly DraftFile[]) {
  if (value.length) drafts.set(key, value);
  else drafts.delete(key);
  for (const listener of listeners) listener();
}

export function captureFileDraftClear(key: string, files: readonly File[]): () => void {
  const sent = new Set(files);
  const ids = new Set(
    (drafts.get(key) ?? empty).filter(({ file }) => sent.has(file)).map(({ id }) => id),
  );
  return () =>
    update(
      key,
      (drafts.get(key) ?? empty).filter(({ id }) => !ids.has(id)),
    );
}

export function useFileDraft(key: string) {
  const files = useSyncExternalStore(
    subscribe,
    () => drafts.get(key) ?? empty,
    () => empty,
  );
  const validationErrors = validateUploadFiles(files.map(({ file }) => file));
  return {
    files,
    validationErrors,
    add: (incoming: readonly File[]) =>
      update(key, [
        ...(drafts.get(key) ?? empty),
        ...incoming.map((file) => ({ id: crypto.randomUUID(), file })),
      ]),
    remove: (id: string) =>
      update(
        key,
        (drafts.get(key) ?? empty).filter((item) => item.id !== id),
      ),
    clearSent: (sent: readonly DraftFile[]) => {
      const ids = new Set(sent.map(({ id }) => id));
      update(
        key,
        (drafts.get(key) ?? empty).filter((item) => !ids.has(item.id)),
      );
    },
    setError: (file: File, error: string) =>
      update(
        key,
        (drafts.get(key) ?? empty).map((item) => (item.file === file ? { ...item, error } : item)),
      ),
  };
}
