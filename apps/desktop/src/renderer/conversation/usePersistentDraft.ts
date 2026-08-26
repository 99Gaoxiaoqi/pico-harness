import { useCallback, useEffect, useState } from "react";

const DRAFT_PREFIX = "pico.composer-draft:";
export const MAX_PERSISTED_DRAFT_CHARS = 100_000;

function storageKey(key: string): string {
  return `${DRAFT_PREFIX}${key}`;
}

function boundedDraft(value: string): string {
  return value.length <= MAX_PERSISTED_DRAFT_CHARS
    ? value
    : value.slice(-MAX_PERSISTED_DRAFT_CHARS);
}

export function readPersistentDraft(key: string): string {
  try {
    return boundedDraft(window.localStorage.getItem(storageKey(key)) ?? "");
  } catch {
    return "";
  }
}

export function removePersistentDraft(key: string): void {
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    // A draft remains usable in memory when storage is unavailable.
  }
}

export function writePersistentDraft(key: string, value: string): void {
  if (!value) {
    removePersistentDraft(key);
    return;
  }
  try {
    // Keep the most recent input because it is closest to what the user is actively editing.
    window.localStorage.setItem(storageKey(key), boundedDraft(value));
  } catch {
    // A draft remains usable in memory when storage is unavailable.
  }
}

export function usePersistentDraft(key: string) {
  const [draft, setDraft] = useState(() => ({ key, value: readPersistentDraft(key) }));
  const current = draft.key === key ? draft : { key, value: readPersistentDraft(key) };

  useEffect(() => {
    if (draft.key !== key) setDraft(current);
  }, [current, draft.key, key]);

  const update = useCallback(
    (next: string) => {
      setDraft({ key, value: next });
      writePersistentDraft(key, next);
    },
    [key],
  );

  const clear = useCallback(() => {
    setDraft({ key, value: "" });
    removePersistentDraft(key);
  }, [key]);

  return { value: current.value, update, clear } as const;
}
