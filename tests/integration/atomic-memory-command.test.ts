import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemoryCommand, decodeMemoryUndoToken } from "../../src/memory/memory-command.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

test("local memory commands use atomic storage after trust, preserving remember/status/toggle/undo", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-command-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const command = createMemoryCommand({ workDir, picoHome, trustStore });
  const execute = async (...argv: string[]) => {
    const result = await command.execute(
      { raw: `/memory ${argv.join(" ")}`, name: "memory", args: argv.join(" "), argv },
      {},
    );
    assert.equal(result.type, "local");
    return result.type === "local" ? (result.message ?? "") : "";
  };
  try {
    assert.match(await execute("remember", "Prefer concise answers."), /not trusted/);
    await assert.rejects(access(join(picoHome, "memory.sqlite")));
    await trustStore.trust(await trustStore.canonicalize(workDir));
    const remembered = await execute("remember", "Prefer concise answers.");
    assert.match(remembered, /Remembered workspace fact/);
    const token = remembered.match(/\/memory undo (\S+)/)?.[1];
    assert.ok(token);
    const id = decodeMemoryUndoToken(token).factId;
    assert.match(await execute("remember", "Prefer concise answers."), new RegExp(id));
    assert.match(await execute("status"), /Active facts: 1/);
    assert.doesNotMatch(await execute("status"), /Review budget|Pending proposals/);
    assert.match(
      await execute("remember", "sk-abcdefghijklmnopqrstuvwxyz123456"),
      /安全扫描未通过/,
    );
    assert.match(await execute("off"), /Memory disabled/);
    assert.match(await execute("status"), /Memory: off[\s\S]*Injection: off/);
    assert.match(await execute("on"), /Memory enabled/);
    assert.match(await execute("undo", token), /is archived/);
    assert.match(await execute("undo", token), /fact changed/);
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      assert.equal((await store.readItem(id))?.item.lifecycleState, "archived");
      assert.equal(
        (await store.readSettings(resolvePicoPaths(workDir, { picoHome }).workspace.id)).enabled,
        true,
      );
    } finally {
      store.close();
    }
    // Fresh workspaces no longer create the legacy operational memory database on this path.
    await assert.rejects(
      access(join(resolvePicoPaths(workDir, { picoHome }).workspace.root, "pico.sqlite")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
