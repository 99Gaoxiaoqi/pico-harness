import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../../src/engine/session.js";

test("SessionManager reuses an entry and drains it after eviction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-manager-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager({ maxSessions: 4 });
  try {
    const first = await manager.getOrCreate("manager-a", workDir, {
      persistence: false,
      picoHome,
    });
    const reused = await manager.getOrCreate("manager-a", workDir, {
      persistence: false,
      picoHome,
    });
    assert.strictEqual(reused, first);
    assert.equal(manager.size, 1);

    const release = manager.pin(first);
    assert.equal(manager.delete("manager-a", workDir, { picoHome }), undefined);
    assert.strictEqual(manager.get("manager-a", workDir, { picoHome }), first);
    release();

    const second = await manager.getOrCreate("manager-b", workDir, {
      persistence: false,
      picoHome,
    });
    assert.notStrictEqual(second, first);
    assert.equal(manager.size, 2);

    const removed = manager.delete("manager-a", workDir, { picoHome });
    assert.strictEqual(removed, first);
    await removed?.close();
    assert.equal(manager.get("manager-a", workDir, { picoHome }), undefined);
  } finally {
    const remaining = manager.delete("manager-b", workDir, { picoHome });
    await remaining?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionManager publishes a recovered Session with its acquisition pin already held", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-manager-pinned-acquire-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager({ maxSessions: 1 });
  let lease: Awaited<ReturnType<SessionManager["getOrCreatePinned"]>> | undefined;
  try {
    const acquiring = manager.getOrCreatePinned("pinned-first", workDir, {
      persistence: false,
      picoHome,
    });
    const competing = acquiring.then(() =>
      manager.getOrCreate("competing-second", workDir, { persistence: false, picoHome }),
    );
    lease = await acquiring;
    await competing;

    assert.equal(manager.size, 2);
    assert.strictEqual(manager.get("pinned-first", workDir, { picoHome }), lease.session);
    assert.equal(await lease.session.serialize(async () => "still open"), "still open");
    lease.release();
    lease = undefined;
    await manager.getOrCreate("eviction-trigger", workDir, { persistence: false, picoHome });
    assert.equal(manager.get("pinned-first", workDir, { picoHome }), undefined);
  } finally {
    lease?.release();
    for (const id of ["pinned-first", "competing-second", "eviction-trigger"]) {
      await manager.delete(id, workDir, { picoHome })?.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Session serialized capability reuses its active lease and queues standalone callers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-capability-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("serialized-capability", workDir, {
      persistence: false,
      picoHome,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondEntered = false;
    const first = session.serialize(async () => {
      assert.equal(await session.withSerializedExecution(async () => "nested"), "nested");
      await firstGate;
    });
    const second = session.withSerializedExecution(async () => {
      secondEntered = true;
    });
    await Promise.resolve();
    assert.equal(secondEntered, false);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally {
    const session = manager.delete("serialized-capability", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session serialized capability drains detached nested work before releasing the queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-detached-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("serialized-detached", workDir, {
      persistence: false,
      picoHome,
    });
    let releaseNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const order: string[] = [];
    const first = session.serialize(async () => {
      session.spawnSerializedExecution(async () => {
        order.push("nested-start");
        await nestedGate;
        order.push("nested-end");
      });
      await Promise.resolve();
      order.push("parent-end");
    });
    const queued = session.serialize(async () => {
      order.push("queued");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ["nested-start", "parent-end"]);
    releaseNested();
    await Promise.all([first, queued]);
    assert.deepEqual(order, ["nested-start", "parent-end", "nested-end", "queued"]);
  } finally {
    const session = manager.delete("serialized-detached", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session serialized capability preserves parent and nested failures before releasing the queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-errors-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("serialized-errors", workDir, {
      persistence: false,
      picoHome,
    });
    let releaseGrandchild!: () => void;
    const grandchildGate = new Promise<void>((resolve) => {
      releaseGrandchild = resolve;
    });
    const parentError = new Error("parent failed");
    const nestedError = new Error("nested failed");
    let queuedEntered = false;
    const first = session.serialize(async () => {
      session.spawnSerializedExecution(async () => {
        session.spawnSerializedExecution(async () => {
          await grandchildGate;
        });
        throw nestedError;
      });
      await Promise.resolve();
      throw parentError;
    });
    const queued = session.serialize(async () => {
      queuedEntered = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(queuedEntered, false);
    releaseGrandchild();
    const failure = await first.catch((error: unknown) => error);
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [parentError, nestedError]);
    await queued;
    assert.equal(queuedEntered, true);
  } finally {
    const session = manager.delete("serialized-errors", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session serialized capability observes detached rejection immediately and de-duplicates it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-observed-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const session = await manager.getOrCreate("serialized-observed", workDir, {
      persistence: false,
      picoHome,
    });
    const sharedError = new Error("shared failure");
    const failure = await session
      .serialize(async () => {
        void session.withSerializedExecution(async () => {
          throw sharedError;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw sharedError;
      })
      .catch((error: unknown) => error);

    assert.strictEqual(failure, sharedError);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    const session = manager.delete("serialized-observed", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session serialized capability does not rethrow an awaited and handled nested failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-handled-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("serialized-handled", workDir, {
      persistence: false,
      picoHome,
    });
    const result = await session.serialize(async () =>
      session
        .withSerializedExecution(async () => {
          throw new Error("handled nested failure");
        })
        .catch(() => "handled"),
    );
    assert.equal(result, "handled");
  } finally {
    const session = manager.delete("serialized-handled", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session seals a completed parent before late inherited microtasks can join its lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-serialized-seal-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("serialized-seal", workDir, {
      persistence: false,
      picoHome,
    });
    const order: string[] = [];
    let releaseNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    let nested: Promise<void> | undefined;
    const first = session.serialize(async () => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          nested = session.withSerializedExecution(async () => {
            order.push("nested-start");
            await nestedGate;
            order.push("nested-end");
          });
        });
      });
    });
    const queued = session.serialize(async () => {
      order.push("queued");
    });

    for (let index = 0; index < 8; index++) await Promise.resolve();
    const beforeRelease = [...order];
    releaseNested();
    await Promise.all([first, queued]);
    for (let index = 0; index < 2; index++) await Promise.resolve();
    await nested;
    assert.deepEqual(beforeRelease, ["queued"]);
    assert.deepEqual(order, ["queued", "nested-start", "nested-end"]);
  } finally {
    const session = manager.delete("serialized-seal", workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionManager enforces one process owner per durable session key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-manager-owner-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const firstManager = new SessionManager();
  const secondManager = new SessionManager();
  try {
    const first = await firstManager.getOrCreate("owned", workDir, {
      persistence: false,
      picoHome,
    });
    await assert.rejects(
      secondManager.getOrCreate("owned", workDir, { persistence: false, picoHome }),
      /already owned by another SessionManager/u,
    );

    assert.strictEqual(firstManager.delete("owned", workDir, { picoHome }), first);
    const second = await secondManager.getOrCreate("owned", workDir, {
      persistence: false,
      picoHome,
    });
    assert.notStrictEqual(second, first);
  } finally {
    const first = firstManager.delete("owned", workDir, { picoHome });
    const second = secondManager.delete("owned", workDir, { picoHome });
    await Promise.all([first?.close(), second?.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionManager eviction keeps the Session durable history recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-manager-durable-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const manager = new SessionManager();
  try {
    const session = await manager.getOrCreate("manager-durable", workDir, { picoHome });
    await session.commitMessages({ role: "user", content: "durable" });
    const removed = manager.delete("manager-durable", workDir, { picoHome });
    await removed?.close();

    const recovered = await manager.getOrCreate("manager-durable", workDir, { picoHome });
    assert.deepEqual(recovered.getHistory(), [{ role: "user", content: "durable" }]);
    const removedAgain = manager.delete("manager-durable", workDir, { picoHome });
    await removedAgain?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
