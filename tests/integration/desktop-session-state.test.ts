import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopSessionStateStore } from "../../src/daemon/desktop-session-state.js";

test("desktop session state persists pinning and removes deleted metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-session-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "session-state.json");
  const workspacePath = join(root, "workspace");
  let now = 100;
  const store = new DesktopSessionStateStore({ filePath, now: () => now++ });

  await store.update(workspacePath, "session-1", { pinned: true });
  await store.update(workspacePath, "session-1", { archived: true });

  const reloaded = new DesktopSessionStateStore({ filePath, now: () => now++ });
  assert.deepEqual(await reloaded.get(workspacePath, "session-1"), {
    workspacePath,
    sessionId: "session-1",
    pinnedAt: 100,
    archivedAt: 101,
    updatedAt: 101,
  });

  await reloaded.update(workspacePath, "session-1", { pinned: false });
  assert.equal((await reloaded.get(workspacePath, "session-1"))?.pinnedAt, undefined);
  assert.equal(await reloaded.remove(workspacePath, "session-1"), true);
  assert.equal(await reloaded.get(workspacePath, "session-1"), undefined);
});
