import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  observeRepoMapScans,
  RepoMapService,
  type RepoMapScanReport,
} from "../../src/code-intelligence/repo-map.js";
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

  const scans: RepoMapScanReport[] = [];
  const first = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: fixture.targetSymbol, max_files: 200 })),
  );
  assert.match(first, /backend=repo-map indexed=200\/206 cursor=200 complete=false/u);
  assert.equal(scans[0]?.scannedFiles.length, 200);
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetPath), "u"));

  const second = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: fixture.targetSymbol, max_files: 200 })),
  );
  assert.match(second, /backend=repo-map indexed=206\/206 cursor=206 complete=true/u);
  assert.equal(scans[1]?.scannedFiles.length, 6);
  assert.equal(new Set(scans.flatMap(({ scannedFiles }) => scannedFiles)).size, 206);
  assert.match(second, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.match(second, new RegExp(escapeRegExp(fixture.targetPath), "u"));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
