import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  await first.grant("task-a", origin);

  const resumed = new DurableClientCapabilityGrants();
  await resumed.bindSession("task-a", workspace, "epoch-1");
  assert.equal(resumed.allows("task-a", origin), true);
  await resumed.bindSession("task-a", workspace, "epoch-2");
  assert.equal(resumed.allows("task-a", origin), false);
  await resumed.revokeSession("task-a", workspace);

  const afterRollback = new DurableClientCapabilityGrants();
  await afterRollback.bindSession("task-a", workspace, "epoch-1");
  assert.equal(afterRollback.allows("task-a", origin), false);
});
