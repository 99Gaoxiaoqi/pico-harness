import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureWorkspaceTrusted, WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { WorkspaceTrustStore as StorageWorkspaceTrustStore } from "@pico/storage/workspace-trust-store";
import { ensureWorkspaceTrusted as legacyEnsureWorkspaceTrusted } from "@pico/pico-host/workspace-trust";

test("workspace trust keeps fail-closed policy in Host and durable state in Storage", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const hostStore = new WorkspaceTrustStore({
    userStateDirectory: picoHome,
    now: () => new Date("2026-09-14T00:00:00.000Z"),
  });
  await assert.rejects(
    () => ensureWorkspaceTrusted(workspace, { store: hostStore }),
    /非交互环境不会自动信任/u,
  );

  const prompted: string[] = [];
  const trusted = await ensureWorkspaceTrusted(workspace, {
    store: hostStore,
    prompt: {
      async requestTrust(request) {
        prompted.push(request.workspacePath, ...request.risks);
        return "trust";
      },
    },
  });
  assert.equal(trusted.status, "trusted-now");
  assert.equal(prompted[0], await hostStore.canonicalize(workspace));
  assert.ok(prompted.some((value) => value.includes("AGENTS.md")));

  const storageStore = new StorageWorkspaceTrustStore({ userStateDirectory: picoHome });
  assert.equal(await storageStore.isTrusted(trusted.workspacePath), true);
  const info = await lstat(hostStore.filePath);
  assert.equal(info.isFile(), true);
  assert.equal(info.mode & 0o777, 0o600);

  const legacy = await legacyEnsureWorkspaceTrusted(workspace, { store: hostStore });
  assert.equal(legacy.status, "already-trusted", "旧入口必须复用同一信任记录");
});
