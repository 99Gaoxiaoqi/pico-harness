import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalizeSandboxBoundaryExpansion } from "../../../src/safety/sandbox-boundary-path.js";
import {
  PROTECTED_METADATA_NAMES,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from "../../../src/safety/permission-profile.js";
import { WorkspaceRoots } from "../../../src/tools/workspace-roots.js";

test("boundary paths are canonicalized without creating authority-bearing parents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-boundary-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  const file = join(root, "existing.txt");
  await mkdir(tree);
  await writeFile(file, "ok", "utf8");

  const expansion = await canonicalizeSandboxBoundaryExpansion({
    filesystem: {
      entries: [
        { path: tree, access: "read", scope: "subtree" },
        { path: file, access: "read", scope: "exact" },
        { path: join(root, "new.txt"), access: "write", scope: "exact" },
      ],
    },
  });
  assert.equal(expansion.filesystem?.entries.length, 3);
  assert.ok(expansion.filesystem?.entries.every((entry) => entry.path.startsWith("/")));

  await assert.rejects(
    canonicalizeSandboxBoundaryExpansion({
      filesystem: {
        entries: [
          {
            path: join(root, "missing-parent", "new.txt"),
            access: "write",
            scope: "exact",
          },
        ],
      },
    }),
    /parent does not exist/u,
  );
  await assert.rejects(
    canonicalizeSandboxBoundaryExpansion({
      filesystem: {
        entries: [{ path: file, access: "read", scope: "subtree" }],
      },
    }),
    /must be a directory/u,
  );
});

test("WorkspaceRoots preserves exact/subtree and read/write boundary semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-boundary-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const readOnlyFile = join(outside, "read-only.txt");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(readOnlyFile, "ok", "utf8");
  const roots = await WorkspaceRoots.create(workspace);
  roots.replaceBoundaryEntries([
    { path: readOnlyFile, access: "read", scope: "exact" },
    { path: join(outside, "writable"), access: "write", scope: "subtree" },
  ]);

  assert.equal(roots.isAllowedPath(readOnlyFile, "read"), true);
  assert.equal(roots.isAllowedPath(readOnlyFile, "write"), false);
  assert.equal(roots.isAllowedPath(join(outside, "other.txt"), "read"), false);
  assert.equal(roots.isAllowedPath(join(outside, "writable", "new.txt"), "write"), true);
});

test("WorkspaceRoots enforces the complete managed profile for direct file tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-boundary-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const denied = join(workspace, "denied.txt");
  const protectedFile = join(workspace, ".git", "config");
  await mkdir(workspace);
  await mkdir(outside);
  await mkdir(join(workspace, ".git"));
  await writeFile(denied, "blocked", "utf8");
  await writeFile(protectedFile, "blocked", "utf8");
  const roots = await WorkspaceRoots.create(workspace);

  roots.replaceBoundaryProfile(createReadOnlyPermissionProfile());
  assert.equal(roots.isAllowedPath(join(workspace, "read.txt"), "read"), true);
  assert.equal(roots.isAllowedPath(join(workspace, "write.txt"), "write"), false);

  const writable = createWorkspaceWritePermissionProfile();
  roots.replaceBoundaryProfile({
    ...writable,
    name: "custom",
    fileSystem: {
      ...writable.fileSystem,
      protectedMetadata: { access: "deny_write", names: PROTECTED_METADATA_NAMES },
      entries: [
        ...writable.fileSystem.entries,
        { kind: "path", access: "deny", path: denied, match: "exact" },
        { kind: "path", access: "read", path: outside, match: "subtree" },
      ],
    },
  });
  assert.equal(roots.isAllowedPath(denied, "read"), false);
  assert.equal(roots.isAllowedPath(denied, "write"), false);
  assert.equal(roots.isAllowedPath(join(outside, "read.txt"), "read"), true);
  assert.equal(roots.isAllowedPath(join(outside, "write.txt"), "write"), false);
  assert.equal(roots.isAllowedPath(join(tmpdir(), "direct-write.txt"), "write"), false);

  roots.authorizeOnce(protectedFile);
  await assert.rejects(
    roots.assertAllowed(protectedFile, { access: "write" }),
    /\u8def\u5f84\u8d8a\u754c/u,
    "one-shot approval must not weaken a policy-level protected metadata denial",
  );
});
