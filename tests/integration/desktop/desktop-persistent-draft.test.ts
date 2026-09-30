import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createElement } from "react";
import { render, Text } from "ink";
import {
  MAX_PERSISTED_DRAFT_CHARS,
  readPersistentDraft,
  removePersistentDraft,
  writePersistentDraft,
  usePersistentDraft,
} from "../../../apps/desktop/src/renderer/conversation/usePersistentDraft.js";

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

async function withLocalStorage(
  storage: Omit<DraftStorage, "values">,
  run: () => void | Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  try {
    await run();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("persistent draft writes and removes a session-scoped value", async () => {
  const storage = memoryStorage();
  await withLocalStorage(storage, () => {
    writePersistentDraft("workspace:session", "continue from here");
    assert.equal(readPersistentDraft("workspace:session"), "continue from here");

    removePersistentDraft("workspace:session");
    assert.equal(readPersistentDraft("workspace:session"), "");
  });
});

test("persistent draft keeps the most recent characters when it exceeds the limit", async () => {
  const storage = memoryStorage();
  const oversized = `discarded-${"x".repeat(MAX_PERSISTED_DRAFT_CHARS)}-recent`;
  await withLocalStorage(storage, () => {
    writePersistentDraft("oversized", oversized);
    assert.equal(readPersistentDraft("oversized"), oversized.slice(-MAX_PERSISTED_DRAFT_CHARS));
  });
});

test("persistent draft storage failures are fail-safe", async () => {
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
  await withLocalStorage(unavailable, () => {
    assert.doesNotThrow(() => writePersistentDraft("draft", "kept by hook state"));
    assert.doesNotThrow(() => removePersistentDraft("draft"));
    assert.equal(readPersistentDraft("draft"), "");
  });
});

test("mounted draft survives blocked storage, key switches and delayed send completion", async () => {
  const unavailable = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
    removeItem() {
      throw new Error("storage unavailable");
    },
  };
  await withLocalStorage(unavailable, async () => {
    let draft: ReturnType<typeof usePersistentDraft> | undefined;
    const renders: Array<{ key: string; value: string }> = [];
    function Composer({ draftKey }: { draftKey: string }) {
      draft = usePersistentDraft(draftKey);
      renders.push({ key: draftKey, value: draft.value });
      return createElement(Text, null, `${draftKey}: ${draft.value}`);
    }
    const stdout = new PassThrough();
    stdout.resume();
    const mounted = render(createElement(Composer, { draftKey: "blocked:a" }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      interactive: false,
      patchConsole: false,
    });
    try {
      await mounted.waitUntilRenderFlush();
      const sent = "summarize /[skill:review:local:%2Fskills%2Freview.md]";
      draft!.update(sent);
      await mounted.waitUntilRenderFlush();
      const completeFirstSend = draft!.clearIfUnchanged;
      mounted.rerender(createElement(Composer, { draftKey: "blocked:b" }));
      await mounted.waitUntilRenderFlush();
      assert.equal(renders.find((item) => item.key === "blocked:b")?.value, "");
      draft!.update("new session draft");
      await mounted.waitUntilRenderFlush();
      completeFirstSend(sent);
      await mounted.waitUntilRenderFlush();
      assert.equal(draft!.value, "new session draft");
      assert.equal(readPersistentDraft("blocked:a"), "");

      const completeSecondSend = draft!.clearIfUnchanged;
      draft!.update("edited while sending");
      // Even completion before React's next render must see the latest edit.
      completeSecondSend("new session draft");
      await mounted.waitUntilRenderFlush();
      assert.equal(draft!.value, "edited while sending");
      mounted.rerender(createElement(Composer, { draftKey: "blocked:a" }));
      await mounted.waitUntilRenderFlush();
      mounted.rerender(createElement(Composer, { draftKey: "blocked:b" }));
      await mounted.waitUntilRenderFlush();
      assert.equal(draft!.value, "edited while sending");
      draft!.clearIfUnchanged("edited while sending");
      assert.equal(readPersistentDraft("blocked:b"), "");
      mounted.rerender(createElement(Composer, { draftKey: "blocked:b" }));
      await mounted.waitUntilRenderFlush();
      assert.equal(draft!.value, "");
      assert.equal(readPersistentDraft("blocked:b"), "");
    } finally {
      mounted.unmount();
      await mounted.waitUntilExit();
    }
  });
});
