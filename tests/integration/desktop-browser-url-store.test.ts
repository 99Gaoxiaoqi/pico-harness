import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrowserSessionCloseFence,
  commitBrowserRevocations,
  persistBrowserNavigationForCurrentEntry,
  PersistentBrowserViewportGenerationAuthority,
} from "../../apps/desktop/src/main/browser-logic.js";
import { BrowserUrlStore } from "../../apps/desktop/src/main/browser-url-store.js";
import {
  BrowserAgentBrokerError,
  BrowserAgentCommandBroker,
} from "../../src/daemon/browser-agent-command-broker.js";

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
    version: 2,
    sessions: [
      { sessionId: "session-a", generationFloor: 0, url: "https://openai.com/" },
      { sessionId: "session-b", generationFloor: 0, url: "http://example.com/path#two" },
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

  await writeFile(store.filePath, JSON.stringify({ version: 3, sessions: [] }), "utf8");
  assert.equal(new BrowserUrlStore(root).get("session-a"), undefined);
});

test("browser generation floor survives Desktop restart against the same daemon", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-generation-restart-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const broker = new BrowserAgentCommandBroker();

  const firstStore = new BrowserUrlStore(root);
  const firstMain = new PersistentBrowserViewportGenerationAuthority(firstStore);
  const firstGeneration = await firstMain.acquire("session-a");
  broker.acquireLease({ sessionId: "session-a", visible: true, generation: firstGeneration });
  const disposed = firstMain.revokeAll();
  await commitBrowserRevocations(
    disposed.persistence,
    disposed.revocations,
    async (sessionId, generation) => {
      broker.acquireLease({ sessionId, visible: false, generation });
    },
  );

  const restartedStore = new BrowserUrlStore(root);
  const restartedMain = new PersistentBrowserViewportGenerationAuthority(restartedStore);
  const restartedGeneration = await restartedMain.acquire("session-a");
  assert.ok(restartedGeneration > disposed.revocations[0]!.generation);
  assert.throws(
    () =>
      broker.acquireLease({
        sessionId: "session-a",
        visible: true,
        generation: firstGeneration,
      }),
    (error: unknown) =>
      error instanceof BrowserAgentBrokerError && error.code === "BROWSER_LEASE_STALE",
  );
  assert.equal(
    broker.acquireLease({
      sessionId: "session-a",
      visible: true,
      generation: restartedGeneration,
    }).visible,
    true,
  );
});

test("browser close fence blocks acquire through publication and daemon notification", async () => {
  const published: unknown[] = [];
  const releasePublish = Promise.withResolvers<void>();
  let blockPublish = false;
  const store = new BrowserUrlStore("/unused", {
    writeDebounceMs: 60_000,
    write: async (_path, state) => {
      published.push(structuredClone(state));
      if (blockPublish) await releasePublish.promise;
    },
  });
  store.set("session-a", "https://example.com/active");
  await store.flush();
  const authority = new PersistentBrowserViewportGenerationAuthority(store);
  const closeFence = new BrowserSessionCloseFence();
  const acquireViewport = async (): Promise<number> => {
    closeFence.assertAvailable("session-a");
    return authority.acquire("session-a");
  };
  const firstGeneration = await acquireViewport();
  published.length = 0;
  blockPublish = true;
  const notificationStarted = Promise.withResolvers<void>();
  const releaseNotification = Promise.withResolvers<void>();
  const entry = {};
  let currentEntry: typeof entry | undefined = entry;
  const lateNavigation = (): boolean =>
    persistBrowserNavigationForCurrentEntry({
      entry,
      currentEntry: () => currentEntry,
      url: "https://example.com/late",
      isMainFrame: true,
      persist: (url) => store.set("session-a", url),
      refresh: () => undefined,
    });

  const notifications: number[] = [];
  let closeGeneration = 0;
  const completion = closeFence.run("session-a", async () => {
    currentEntry = undefined;
    const revocation = authority.revoke("session-a", { deleteUrl: true });
    closeGeneration = revocation.generation;
    await commitBrowserRevocations(
      revocation.persistence,
      [{ sessionId: "session-a", generation: revocation.generation }],
      async (_sessionId, generation) => {
        notificationStarted.resolve();
        await releaseNotification.promise;
        notifications.push(generation);
      },
    );
  });
  let duplicateCloseRan = false;
  const duplicateCompletion = closeFence.run("session-a", async () => {
    duplicateCloseRan = true;
  });
  await Promise.resolve();
  assert.equal(closeFence.isClosing("session-a"), true);
  await assert.rejects(acquireViewport(), /正在关闭/u);
  assert.equal(authority.accept("session-a", firstGeneration), false);
  assert.equal(
    !closeFence.isClosing("session-a") && authority.accept("session-a", firstGeneration),
    false,
  );
  assert.equal(lateNavigation(), false);

  assert.deepEqual(published, [
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: closeGeneration }],
    },
  ]);
  assert.equal(notifications.length, 0);
  releasePublish.resolve();
  await notificationStarted.promise;
  assert.equal(closeFence.isClosing("session-a"), true);
  await assert.rejects(acquireViewport(), /正在关闭/u);
  assert.deepEqual(notifications, []);
  releaseNotification.resolve();
  await Promise.all([completion, duplicateCompletion]);
  assert.equal(duplicateCloseRan, false);
  assert.equal(closeFence.isClosing("session-a"), false);
  currentEntry = {};
  const restoredGeneration = await acquireViewport();
  assert.equal(lateNavigation(), false);
  assert.equal(store.get("session-a"), undefined);
  assert.deepEqual(published, [
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: closeGeneration }],
    },
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: restoredGeneration }],
    },
  ]);
  assert.deepEqual(notifications, [closeGeneration]);
});

test("browser close fence releases after failure without reviving its entry or URL", async () => {
  const published: unknown[] = [];
  let rejectPublish = false;
  const store = new BrowserUrlStore("/unused", {
    writeDebounceMs: 60_000,
    retryDelayMs: 60_000,
    write: async (_path, state) => {
      published.push(structuredClone(state));
      if (rejectPublish) throw new Error("rename failed");
    },
  });
  store.set("session-a", "https://example.com/active");
  await store.flush();
  const authority = new PersistentBrowserViewportGenerationAuthority(store);
  const closeFence = new BrowserSessionCloseFence();
  const acquireViewport = async (): Promise<number> => {
    closeFence.assertAvailable("session-a");
    return authority.acquire("session-a");
  };
  const firstGeneration = await acquireViewport();
  published.length = 0;
  rejectPublish = true;
  const entry = {};
  let currentEntry: typeof entry | undefined = entry;
  const lateNavigation = (): boolean =>
    persistBrowserNavigationForCurrentEntry({
      entry,
      currentEntry: () => currentEntry,
      url: "https://example.com/late",
      isMainFrame: true,
      persist: (url) => store.set("session-a", url),
      refresh: () => undefined,
    });

  const notifications: number[] = [];
  let closeGeneration = 0;
  await assert.rejects(
    closeFence.run("session-a", async () => {
      currentEntry = undefined;
      const revocation = authority.revoke("session-a", { deleteUrl: true });
      closeGeneration = revocation.generation;
      await commitBrowserRevocations(
        revocation.persistence,
        [{ sessionId: "session-a", generation: revocation.generation }],
        async (_sessionId, generation) => {
          notifications.push(generation);
        },
      );
    }),
    /rename failed/u,
  );

  assert.equal(closeFence.isClosing("session-a"), false);
  assert.equal(authority.accept("session-a", firstGeneration), false);
  assert.equal(lateNavigation(), false);
  assert.deepEqual(published, [
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: closeGeneration }],
    },
  ]);
  assert.equal(notifications.length, 0);

  published.length = 0;
  rejectPublish = false;
  await closeFence.run("session-a", async () => {
    const retry = authority.revoke("session-a", { deleteUrl: true });
    assert.equal(retry.generation, closeGeneration);
    await commitBrowserRevocations(
      retry.persistence,
      [{ sessionId: "session-a", generation: retry.generation }],
      async (_sessionId, generation) => {
        notifications.push(generation);
      },
    );
  });
  const restoredGeneration = await acquireViewport();
  assert.equal(lateNavigation(), false);
  assert.equal(currentEntry, undefined);
  assert.equal(store.get("session-a"), undefined);
  assert.deepEqual(published, [
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: closeGeneration }],
    },
    {
      version: 2,
      sessions: [{ sessionId: "session-a", generationFloor: restoredGeneration }],
    },
  ]);
  assert.deepEqual(notifications, [closeGeneration]);
});

test("browser URL store migrates v1 and fails safe on corrupt generation state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-browser-generation-migration-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const filePath = join(root, "browser-urls.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      sessions: [{ sessionId: "session-a", url: "https://example.com/legacy" }],
    }),
    "utf8",
  );
  const migrated = new BrowserUrlStore(root);
  assert.equal(migrated.get("session-a"), "https://example.com/legacy");
  assert.equal(migrated.getGenerationFloor("session-a"), 0);
  await migrated.flush();
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).version, 2);

  await writeFile(filePath, "{corrupt", "utf8");
  const errors: unknown[] = [];
  const corrupt = new BrowserUrlStore(root, { onError: (error) => errors.push(error) });
  assert.throws(() => corrupt.getGenerationFloor("session-a"), /拒绝当前操作/u);
  assert.equal(errors.length, 1);
  await corrupt.flush();
  assert.equal(await readFile(filePath, "utf8"), "{corrupt");
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
  // Production debounce is intentionally unref'ed; the isolated test owns this ref'ed deadline.
  const startDeadline = Promise.withResolvers<never>();
  const startTimeout = setTimeout(
    () => startDeadline.reject(new Error("background browser URL write did not start")),
    1_000,
  );
  try {
    await Promise.race([firstStarted.promise, startDeadline.promise]);
  } finally {
    clearTimeout(startTimeout);
  }
  store.set("session-a", "https://example.com/two");
  store.set("session-a", "https://example.com/three");
  releaseFirst.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(writes, 1);

  await store.flush();
  assert.equal(writes, 2);
  assert.equal(store.get("session-a"), "https://example.com/three");
});
