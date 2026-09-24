import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserHttpOrigin,
  browserNavigationOrigin,
  ClientCapabilityGrants,
  DurableClientCapabilityGrants,
} from "@pico/pico-host/client-capability-grants";

test("browser grants distinguish task sessions and exact HTTP origins", () => {
  const grants = new ClientCapabilityGrants();
  const origin = { kind: "browser_origin", origin: "https://example.com" } as const;
  grants.grant("task-a", origin);
  assert.equal(grants.allows("task-a", origin), true);
  assert.equal(
    grants.allows("task-a", { kind: "browser_origin", origin: "https://other.example" }),
    false,
  );
  assert.equal(grants.allows("task-b", origin), false);
  grants.revokeSession("task-a");
  assert.equal(grants.allows("task-a", origin), false);
});

test("browser origin canonicalization rejects non-web and credential-bearing URLs", () => {
  assert.equal(browserNavigationOrigin("example.com/page"), "https://example.com");
  assert.equal(browserHttpOrigin("https://example.com:443/page"), "https://example.com");
  assert.equal(browserHttpOrigin("file:///etc/passwd"), undefined);
  assert.equal(browserHttpOrigin("https://user:password@example.com"), undefined);
});

test("Desktop MCP grants are scoped to exact server and tool, and revocable", () => {
  const grants = new ClientCapabilityGrants();
  const scope = { kind: "desktop_mcp", server: "design", tool: "read" } as const;
  grants.grant("task-a", scope);
  assert.equal(grants.allows("task-a", scope), true);
  assert.equal(grants.allows("task-a", { ...scope, tool: "write" }), false);
  grants.revokeSession("task-a", scope);
  assert.equal(grants.allows("task-a", scope), false);
});

test("client grants survive restart only for the same session, workspace and authority epoch", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-client-grants-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  const origin = { kind: "browser_origin", origin: "https://example.com" } as const;
  const first = new DurableClientCapabilityGrants();
  await first.bindSession("task-a", workspace, "epoch-1");
  await first.grant("task-a", origin, workspace);

  const resumed = new DurableClientCapabilityGrants();
  await resumed.bindSession("task-a", workspace, "epoch-1");
  assert.equal(resumed.allows("task-a", origin, workspace), true);
  await resumed.bindSession("task-a", workspace, "epoch-2");
  assert.equal(resumed.allows("task-a", origin, workspace), false);
  await resumed.revokeSession("task-a", workspace);

  const afterRollback = new DurableClientCapabilityGrants();
  await afterRollback.bindSession("task-a", workspace, "epoch-1");
  assert.equal(afterRollback.allows("task-a", origin, workspace), false);
});

test("durable client grants reject unknown keys and never cross workspace identities", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-grants-scope-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const firstWorkspace = join(root, "first");
  const secondWorkspace = join(root, "second");
  const file = join(
    firstWorkspace,
    "client-capabilities",
    `${createHash("sha256").update("task-a").digest("hex")}.json`,
  );
  await mkdir(join(firstWorkspace, "client-capabilities"), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      sessionId: "task-a",
      authorityEpoch: "epoch-1",
      grants: ["browser_origin:https://example.com", "unknown:all"],
    }),
  );
  const grants = new DurableClientCapabilityGrants();
  const scope = { kind: "browser_origin", origin: "https://example.com" } as const;
  await grants.bindSession("task-a", firstWorkspace, "epoch-1");
  assert.equal(grants.allows("task-a", scope, firstWorkspace), false);
  await grants.grant("task-a", scope, firstWorkspace);
  await grants.bindSession("task-a", secondWorkspace, "epoch-1");
  assert.equal(grants.allows("task-a", scope, secondWorkspace), false);
  assert.equal(grants.allows("task-a", scope, firstWorkspace), true);
});

test("failed publish never grants in memory and concurrent revocation cannot resurrect a grant", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-client-grants-race-"));
  context.after(async () => rm(workspace, { recursive: true, force: true }));
  const scope = { kind: "browser_origin", origin: "https://example.com" } as const;
  const failed = new DurableClientCapabilityGrants(async () => {
    throw new Error("disk unavailable");
  });
  await failed.bindSession("task-a", workspace, "epoch-1");
  await assert.rejects(failed.grant("task-a", scope, workspace), /disk unavailable/);
  assert.equal(failed.allows("task-a", scope, workspace), false);

  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const racing = new DurableClientCapabilityGrants(async (path, contents) => {
    publishing.resolve();
    await release.promise;
    await mkdir(join(workspace, "client-capabilities"), { recursive: true });
    await writeFile(path, contents);
  });
  await racing.bindSession("task-a", workspace, "epoch-1");
  const granting = racing.grant("task-a", scope, workspace);
  const denied = assert.rejects(granting, /已撤销/);
  await publishing.promise;
  const revoking = racing.revokeSession("task-a", workspace);
  assert.equal(racing.allows("task-a", scope, workspace), false);
  release.resolve();
  await denied;
  await revoking;
  const resumed = new DurableClientCapabilityGrants();
  await resumed.bindSession("task-a", workspace, "epoch-1");
  assert.equal(resumed.allows("task-a", scope, workspace), false);
});
