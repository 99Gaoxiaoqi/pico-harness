import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserUrlStore } from "../../apps/desktop/src/main/browser-url-store.js";

test("browser URL store atomically restores the last HTTP(S) URL per Session", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-url-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const first = new BrowserUrlStore(root);
  first.set("session-b", "http://example.com/path#one");
  first.set("session-a", "https://openai.com/");
  first.set("session-b", "http://example.com/path#two");
  first.set("session-a", "file:///tmp/secret");
  await first.flush();

  const restored = new BrowserUrlStore(root);
  assert.equal(restored.get("session-a"), "https://openai.com/");
  assert.equal(restored.get("session-b"), "http://example.com/path#two");
  assert.deepEqual(JSON.parse(await readFile(first.filePath, "utf8")), {
    version: 1,
    sessions: [
      { sessionId: "session-a", url: "https://openai.com/" },
      { sessionId: "session-b", url: "http://example.com/path#two" },
    ],
  });
  assert.equal((await stat(first.filePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("browser URL store deletes closed sessions and rejects unknown versions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-url-delete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const store = new BrowserUrlStore(root);
  store.set("session-a", "https://example.com/keep");
  store.set("session-b", "https://example.com/delete");
  store.delete("session-b");
  await store.flush();

  const restored = new BrowserUrlStore(root);
  assert.equal(restored.get("session-a"), "https://example.com/keep");
  assert.equal(restored.get("session-b"), undefined);

  await writeFile(store.filePath, JSON.stringify({ version: 2, sessions: [] }), "utf8");
  assert.equal(new BrowserUrlStore(root).get("session-a"), undefined);
});

test("browser URL store keeps memory retryable when an atomic publish fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-url-retry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const store = new BrowserUrlStore(root);
  await mkdir(store.filePath);
  store.set("session-a", "https://example.com/retry");
  await assert.rejects(store.flush());
  assert.equal(store.get("session-a"), "https://example.com/retry");
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );

  await rm(store.filePath, { recursive: true });
  await store.flush();
  assert.equal(new BrowserUrlStore(root).get("session-a"), "https://example.com/retry");
});

test("browser URL store throttles background writes but flush drains the latest URL", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let writes = 0;
  const store = new BrowserUrlStore("/unused", {
    writeDebounceMs: 10,
    write: async () => {
      writes++;
      if (writes === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    },
  });

  store.set("session-a", "https://example.com/one");
  await firstStarted.promise;
  store.set("session-a", "https://example.com/two");
  store.set("session-a", "https://example.com/three");
  releaseFirst.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(writes, 1);

  await store.flush();
  assert.equal(writes, 2);
  assert.equal(store.get("session-a"), "https://example.com/three");
});
