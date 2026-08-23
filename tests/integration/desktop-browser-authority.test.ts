import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserViewportGenerationAuthority,
  guardBrowserNavigation,
  normalizeActiveBrowserViewport,
  normalizeBrowserAddress,
  normalizePersistedBrowserNavigation,
  normalizeViewport,
  replaceVisibleBrowserEntry,
} from "../../apps/desktop/src/main/browser-logic.js";

test("embedded browser accepts only HTTP(S) and defaults bare hosts to HTTPS", () => {
  assert.equal(normalizeBrowserAddress("example.com"), "https://example.com/");
  assert.equal(normalizeBrowserAddress("http://example.com/path"), "http://example.com/path");
  assert.equal(normalizeBrowserAddress("file:///tmp/secret"), null);
  assert.equal(normalizeBrowserAddress("javascript:alert(1)"), null);
  assert.equal(normalizeBrowserAddress("data:text/plain,secret"), null);
});

test("embedded browser rejects non-finite or empty viewports and clamps safe bounds", () => {
  assert.equal(normalizeViewport(null), null);
  assert.equal(normalizeViewport({ x: 0, y: 0, width: Number.NaN, height: 100 }), null);
  assert.equal(normalizeViewport({ x: 0, y: 0, width: 0, height: 100 }), null);
  assert.deepEqual(normalizeViewport({ x: -3.4, y: 1.6, width: 300.7, height: 199.2 }), {
    x: 0,
    y: 2,
    width: 301,
    height: 199,
  });
});

test("embedded browser creates a page only for an active non-empty viewport", () => {
  const viewport = { x: 1, y: 2, width: 300, height: 200 };
  assert.equal(normalizeActiveBrowserViewport(viewport, false), null);
  assert.equal(normalizeActiveBrowserViewport(null, true), null);
  assert.deepEqual(normalizeActiveBrowserViewport(viewport, true), viewport);
});

test("embedded browser persists only top-level HTTP(S) navigation", () => {
  assert.equal(
    normalizePersistedBrowserNavigation("https://example.com/main#next", true),
    "https://example.com/main#next",
  );
  assert.equal(
    normalizePersistedBrowserNavigation("https://third-party.example/frame#next", false),
    null,
  );
  assert.equal(normalizePersistedBrowserNavigation("file:///tmp/secret", true), null);
});

test("embedded browser blocks invalid direct and redirected navigation protocols", () => {
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  assert.equal(guardBrowserNavigation(event, "https://example.com/next"), true);
  assert.equal(guardBrowserNavigation(event, "file:///tmp/secret"), false);
  assert.equal(guardBrowserNavigation(event, "javascript:alert(1)"), false);
  assert.equal(prevented, 2);
});

test("embedded browser viewport generations survive remounts and reject stale mounts", () => {
  const authority = new BrowserViewportGenerationAuthority();
  const firstMount = authority.acquire("session-a");
  assert.equal(authority.accept("session-a", firstMount), true);
  const movedDockMount = authority.acquire("session-a");
  assert.ok(movedDockMount > firstMount);
  assert.equal(authority.accept("session-a", movedDockMount), true);
  assert.equal(authority.accept("session-a", firstMount), false);
  assert.equal(
    authority.accept("session-a", movedDockMount + 10),
    false,
    "Main 不得接受未签发的更高 generation",
  );
  assert.equal(authority.current("session-a"), movedDockMount);
  const archiveFloor = authority.revoke("session-a");
  assert.ok(archiveFloor > movedDockMount);
  assert.equal(
    authority.accept("session-a", movedDockMount),
    false,
    "archive/delete 后旧 viewport 回调不得重新取得创建权限",
  );
  const restoredMount = authority.acquire("session-a");
  assert.ok(restoredMount > archiveFloor);
  assert.equal(authority.accept("session-a", restoredMount), true);
  assert.equal(authority.acquire("session-b"), 1);
});

test("embedded browser clear replaces a visible entry without losing bounds or generation", () => {
  type Entry = { readonly id: string; generation: number; visible: boolean };
  const calls: string[] = [];
  const current: Entry = { id: "old", generation: 7, visible: true };
  const replacement = replaceVisibleBrowserEntry({
    current,
    generation: (entry) => entry.generation,
    bounds: () => ({ x: 10, y: 20, width: 300, height: 200 }),
    destroy: (entry) => calls.push(`destroy:${entry.id}`),
    create: () => {
      calls.push("create");
      return { id: "new", generation: 0, visible: false };
    },
    show: (entry, bounds, generation) => {
      calls.push(`show:${bounds.width}x${bounds.height}`);
      entry.generation = generation;
      entry.visible = true;
    },
  });
  assert.deepEqual(calls, ["destroy:old", "create", "show:300x200"]);
  assert.deepEqual(replacement, { id: "new", generation: 7, visible: true });
  const navigate = (entry: Entry, url: string): string => {
    if (!entry.visible) throw new Error("browser entry is not visible");
    return url;
  };
  assert.equal(
    navigate(replacement, "https://example.com/after-clear"),
    "https://example.com/after-clear",
  );
});
