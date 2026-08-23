import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PERSISTED_DRAFT_CHARS,
  readPersistentDraft,
  removePersistentDraft,
  writePersistentDraft,
} from "../../apps/desktop/src/renderer/conversation/usePersistentDraft.js";

interface DraftStorage {
  readonly values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): DraftStorage {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function withLocalStorage(storage: Omit<DraftStorage, "values">, run: () => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  try {
    run();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("persistent draft writes and removes a session-scoped value", () => {
  const storage = memoryStorage();
  withLocalStorage(storage, () => {
    writePersistentDraft("workspace:session", "continue from here");
    assert.equal(readPersistentDraft("workspace:session"), "continue from here");

    removePersistentDraft("workspace:session");
    assert.equal(readPersistentDraft("workspace:session"), "");
  });
});

test("persistent draft keeps the most recent characters when it exceeds the limit", () => {
  const storage = memoryStorage();
  const oversized = `discarded-${"x".repeat(MAX_PERSISTED_DRAFT_CHARS)}-recent`;
  withLocalStorage(storage, () => {
    writePersistentDraft("oversized", oversized);
    assert.equal(readPersistentDraft("oversized"), oversized.slice(-MAX_PERSISTED_DRAFT_CHARS));
  });
});

test("persistent draft storage failures are fail-safe", () => {
  const unavailable = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  };
  withLocalStorage(unavailable, () => {
    assert.doesNotThrow(() => writePersistentDraft("draft", "kept by hook state"));
    assert.doesNotThrow(() => removePersistentDraft("draft"));
    assert.equal(readPersistentDraft("draft"), "");
  });
});
