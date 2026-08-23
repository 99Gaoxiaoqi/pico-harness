import assert from "node:assert/strict";
import test from "node:test";
import {
  guardBrowserNavigation,
  normalizeActiveBrowserViewport,
  normalizeBrowserAddress,
  normalizePersistedBrowserNavigation,
  normalizeViewport,
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
