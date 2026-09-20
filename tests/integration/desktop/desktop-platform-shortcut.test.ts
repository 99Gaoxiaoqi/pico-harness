import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import { emptyData } from "../../../apps/desktop/src/renderer/model.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";

test("desktop sidebar renders the native new-task shortcut on Windows and macOS", async (t) => {
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      return url.endsWith(".css")
        ? { format: "module", source: "export {};", shortCircuit: true }
        : nextLoad(url, context);
    },
  });
  t.after(() => hooks.deregister());
  const { AppShell } = await import("../../../apps/desktop/src/renderer/AppShell.js");
  const globals = ["window", "navigator", "React"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() =>
    globals.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }),
  );
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  const storage = { getItem: () => null };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage, sessionStorage: storage },
  });
  const store = {
    data: emptyData,
    preview: false,
    connection: { kind: "ready" },
    actions: {},
  } as unknown as RuntimeStore;
  for (const [platform, shortcut] of [
    ["Win32", "Ctrl+N"],
    ["MacIntel", "⌘ N"],
  ]) {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(RuntimeContext.Provider, { value: store }, createElement(AppShell)),
      ),
    );
    assert.ok(html.includes(`<kbd class="sidebar-shortcut">${shortcut}</kbd>`));
  }
});
