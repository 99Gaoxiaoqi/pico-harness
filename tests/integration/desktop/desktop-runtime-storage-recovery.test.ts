import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
} from "../../../packages/runtime-host/src/control/root-authority.js";
import { ensureDesktopRuntimeStorageRoot } from "../../../apps/desktop/src/main/runtime-storage-recovery.js";

interface RootMarker {
  readonly schemaVersion: 1;
  readonly kind: "interactive";
  readonly rootId: string;
  readonly rootIdentity: { readonly dev: string; readonly ino: string };
}

test("Desktop runtime storage recovery keeps cancellation read-only and repairs only after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-runtime-storage-recovery-"));
  const canonicalRoot = await realpath(root);
  const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
  const sentinelPath = join(root, "keep.txt");
  try {
    const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
    await writeFile(sentinelPath, "keep original data");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as RootMarker;
    const identity = await stat(root, { bigint: true });
    const mismatched: RootMarker = {
      ...marker,
      rootIdentity: {
        dev: (identity.dev + 1n).toString(),
        ino: identity.ino.toString(),
      },
    };
    const mismatchedBytes = `${JSON.stringify(mismatched)}\n`;
    await writeFile(markerPath, mismatchedBytes, { mode: 0o600 });

    let confirmations = 0;
    assert.equal(
      await ensureDesktopRuntimeStorageRoot({
        rootPath: root,
        confirmRepair: async (storagePath) => {
          confirmations++;
          assert.equal(storagePath, canonicalRoot);
          return false;
        },
      }),
      false,
    );
    assert.equal(confirmations, 1);
    assert.equal(await readFile(markerPath, "utf8"), mismatchedBytes);

    assert.equal(
      await ensureDesktopRuntimeStorageRoot({
        rootPath: root,
        confirmRepair: async (storagePath) => {
          confirmations++;
          assert.equal(storagePath, canonicalRoot);
          return true;
        },
      }),
      true,
    );
    assert.equal(confirmations, 2);
    const repaired = JSON.parse(await readFile(markerPath, "utf8")) as RootMarker;
    assert.equal(repaired.rootId, capability.rootId);
    assert.deepEqual(repaired.rootIdentity, {
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
    });
    assert.equal(await readFile(sentinelPath, "utf8"), "keep original data");
    assert.equal(
      (await resolveStorageRoot({ path: root, kind: "interactive" })).rootId,
      capability.rootId,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop runtime storage recovery does not prompt for a healthy or new root", async () => {
  const base = await mkdtemp(join(tmpdir(), "pico-desktop-runtime-storage-healthy-"));
  const root = join(base, "new-root");
  try {
    let confirmations = 0;
    assert.equal(
      await ensureDesktopRuntimeStorageRoot({
        rootPath: root,
        confirmRepair: async () => {
          confirmations++;
          return false;
        },
      }),
      true,
    );
    assert.equal(confirmations, 0);
    assert.equal((await stat(root)).isDirectory(), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
