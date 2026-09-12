import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeMemoryUndoToken,
  encodeMemoryUndoToken,
} from "../../../src/memory/memory-undo-token.js";
import { DesktopAtomicMemoryService } from "../../../src/daemon/desktop-atomic-memory-service.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";

test("atomic management preserves manual deduplication, sanitizer, settings and versioned undo tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-atomic-command-"));
  const workspacePath = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspacePath);
  const service = new DesktopAtomicMemoryService({ picoHome, publish: () => undefined });
  try {
    const { item } = await service.create(workspacePath, "Prefer concise answers.");
    const token = encodeMemoryUndoToken({ itemId: item.itemId, version: item.version });
    assert.deepEqual(decodeMemoryUndoToken(token), { itemId: item.itemId, version: item.version });
    assert.equal(
      (await service.create(workspacePath, "Prefer concise answers.")).item.itemId,
      item.itemId,
    );
    assert.equal((await service.list(workspacePath, { workspacePath })).items.length, 1);
    await assert.rejects(
      service.create(workspacePath, "sk-abcdefghijklmnopqrstuvwxyz123456"),
      /安全扫描未通过/,
    );
    for (const enabled of [false, true]) {
      const { settings } = await service.getSettings(workspacePath);
      await service.updateSettings(workspacePath, {
        workspacePath,
        expectedVersion: settings.version,
        idempotencyKey: `toggle:${enabled}`,
        enabled,
        recallEnabled: enabled,
      });
      const updated = (await service.getSettings(workspacePath)).settings;
      assert.equal(updated.enabled, enabled);
      assert.equal(updated.recallEnabled, enabled);
    }
    const payload = decodeMemoryUndoToken(token);
    const { item: archived } = await service.update(workspacePath, {
      workspacePath,
      itemId: payload.itemId,
      expectedVersion: payload.version,
      lifecycleState: "archived",
      idempotencyKey: `undo:${token}`,
    });
    assert.equal(archived.lifecycleState, "archived");
    assert.ok(archived.version > payload.version);
    await assert.rejects(
      service.update(workspacePath, {
        workspacePath,
        itemId: payload.itemId,
        expectedVersion: payload.version,
        lifecycleState: "active",
        idempotencyKey: "stale-token",
      }),
      /version|版本|conflict/i,
    );
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      assert.equal((await store.readItem(item.itemId))?.item.lifecycleState, "archived");
      assert.equal(
        (await store.readSettings(resolvePicoPaths(workspacePath, { picoHome }).workspace.id))
          .enabled,
        true,
      );
    } finally {
      store.close();
    }
    await assert.rejects(
      access(join(resolvePicoPaths(workspacePath, { picoHome }).workspace.root, "pico.sqlite")),
    );
    for (const invalid of [
      "bad-token",
      encodeMemoryUndoToken({ itemId: item.itemId, version: 0 }),
    ]) {
      assert.throws(() => decodeMemoryUndoToken(invalid), /invalid memory undo token/);
    }
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
