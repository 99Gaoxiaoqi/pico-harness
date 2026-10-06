import { useCallback, useEffect, useRef, useState } from "react";

const DRAFT_PREFIX = "pico.composer-draft:";
export const MAX_PERSISTED_DRAFT_CHARS = 100_000;
// Retain drafts across composer remounts and session switches when storage is blocked.
const memoryDrafts = new Map<string, string>();
const draftListeners = new Map<string, Set<(value: string) => void>>();

function storageKey(key: string): string {
  return `${DRAFT_PREFIX}${key}`;
}

function boundedDraft(value: string): string {
  return value.length <= MAX_PERSISTED_DRAFT_CHARS
    ? value
    : value.slice(-MAX_PERSISTED_DRAFT_CHARS);
}

export function readPersistentDraft(key: string): string {
  const cached = memoryDrafts.get(key);
  if (cached !== undefined) return boundedDraft(cached);
  try {
    const value = boundedDraft(window.localStorage.getItem(storageKey(key)) ?? "");
    memoryDrafts.set(key, value);
    return value;
  } catch {
    return "";
  }
}

export function clearPersistentDraftIfUnchanged(key: string, expectedValue: string): void {
  if (readPersistentDraft(key) === expectedValue) removePersistentDraft(key);
}

export function removePersistentDraft(key: string): void {
  memoryDrafts.set(key, "");
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    // A draft remains usable in memory when storage is unavailable.
  }
  for (const listener of draftListeners.get(key) ?? []) listener("");
}

export function writePersistentDraft(key: string, value: string): void {
  if (!value) {
    removePersistentDraft(key);
    return;
  }
  memoryDrafts.set(key, value);
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
  // Synchronize during this render so a delayed callback cannot restore the previous key.
  if (draft.key !== key) setDraft(current);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const changed = (value: string) => {
      const next = { key, value };
      currentRef.current = next;
      setDraft(next);
    };
    const listeners = draftListeners.get(key) ?? new Set<(value: string) => void>();
    listeners.add(changed);
    draftListeners.set(key, listeners);
    return () => {
      listeners.delete(changed);
      if (!listeners.size) draftListeners.delete(key);
    };
  }, [key]);

  const update = useCallback(
    (next: string) => {
      writePersistentDraft(key, next);
      if (currentRef.current.key === key) {
        currentRef.current = { key, value: next };
        setDraft({ key, value: next });
      }
    },
    [key],
  );

  const clear = useCallback(() => {
    removePersistentDraft(key);
    if (currentRef.current.key === key) {
      currentRef.current = { key, value: "" };
      setDraft({ key, value: "" });
    }
  }, [key]);

  const clearIfUnchanged = useCallback(
    (expectedValue: string) => {
      const latest =
        currentRef.current.key === key ? currentRef.current.value : memoryDrafts.get(key);
      if (latest !== expectedValue) return;
      clear();
    },
    [clear, key],
  );

  return { value: current.value, update, clear, clearIfUnchanged } as const;
}
