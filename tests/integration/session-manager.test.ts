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
