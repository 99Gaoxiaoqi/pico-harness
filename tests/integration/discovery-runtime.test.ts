import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepoMapService } from "../../src/code-intelligence/repo-map.js";
import { RepoMapTool } from "../../src/tools/code-intelligence.js";
import { createDiscoveryLargeRepoFixture } from "../fixtures/discovery-large-repo.js";

test("Discovery Repo Map continues across the default scan batch before resolving a late target", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-discovery-repo-map-"));
  const fixture = await createDiscoveryLargeRepoFixture(workDir);
  const service = new RepoMapService(workDir);
  const tool = new RepoMapTool(workDir, service);
  context.after(async () => {
    await service.close();
    await rm(workDir, { recursive: true, force: true });
  });

  const first = await tool.execute(JSON.stringify({ query: fixture.targetSymbol, max_files: 200 }));
  assert.match(first, /backend=repo-map indexed=200\/206 complete=false/u);
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetPath), "u"));

  const second = await tool.execute(
    JSON.stringify({ query: fixture.targetSymbol, max_files: 200 }),
  );
  assert.match(second, /backend=repo-map indexed=206\/206 complete=true/u);
  assert.match(second, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.match(second, new RegExp(escapeRegExp(fixture.targetPath), "u"));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
