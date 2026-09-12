import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  managedProcessLauncher,
  SandboxViolationError,
  type ManagedSpawnRequest,
} from "../../../src/safety/process-sandbox/index.js";
import {
  buildDefaultToolRegistry,
  type DefaultProcessSandboxDescriptor,
} from "../../../src/tools/default-registry.js";
import { resetRgCache, setRgAvailable } from "../../../src/tools/grep.js";
import { WorkspaceRoots } from "../../../src/tools/workspace-roots.js";

test("Grep refreshes its process sandbox per invocation and rejects unsupported restrictions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grep-sandbox-refresh-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(resetRgCache);
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  const scratchRoot = join(root, "scratch");
  await mkdir(workspace);
  await mkdir(external);
  await writeFile(join(external, "needle.txt"), "dynamic-boundary-needle\n", "utf8");
  const canonicalExternal = await realpath(external);
  const roots = await WorkspaceRoots.create(workspace);

  let descriptor: DefaultProcessSandboxDescriptor = {
    profile: "read-only",
    config: { network: "deny" },
    scratchRoot,
    generation: 0,
  };
  let resolverCalls = 0;
  const registry = buildDefaultToolRegistry(workspace, {
    workspaceRoots: roots,
    deferWorkspaceBoundary: true,
    processSandbox: {
      ...descriptor,
      resolveSandbox: () => {
        resolverCalls++;
        return descriptor;
      },
    },
  });
  const grep = registry.getTool("grep");
  assert.ok(grep);

  await assert.rejects(
    grep.execute(JSON.stringify({ pattern: "dynamic-boundary-needle", path: external })),
    /路径越界/u,
  );

  roots.replaceBoundaryEntries([{ path: canonicalExternal, access: "read", scope: "subtree" }]);
  descriptor = { ...descriptor, readRoots: [canonicalExternal], generation: 1 };
  setRgAvailable(true);
  const launches: ManagedSpawnRequest[] = [];
  context.mock.method(managedProcessLauncher, "launch", (request: ManagedSpawnRequest) => {
    launches.push(request);
    throw new Error("launch reached");
  });

  await assert.rejects(
    grep.execute(JSON.stringify({ pattern: "dynamic-boundary-needle", path: external })),
    /launch reached/u,
  );
  assert.equal(launches.length, 1);
  assert.ok(launches[0]?.policy.readRoots.includes(canonicalExternal));
  assert.equal(launches[0]?.policy.generation, 1);

  descriptor = { ...descriptor, hasUnsupportedDenyEntries: true, generation: 2 };
  const denied = await grep.execute(JSON.stringify({ pattern: "needle" })).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(denied instanceof SandboxViolationError);
  assert.equal(denied.code, "policy_compilation_failed");
  assert.match(denied.message, /protectedMetadata.*fail-closed/iu);
  assert.equal(launches.length, 1);
  assert.equal(resolverCalls, 3);
});
