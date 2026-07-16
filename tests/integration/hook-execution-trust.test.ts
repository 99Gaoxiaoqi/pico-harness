import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/index.js";
import { HookService } from "../../src/hooks/service.js";
import { HookTrustStore } from "../../src/hooks/trust/store.js";

test("command Hook revalidates script bytes immediately before execution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-execution-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const scriptPath = join(workspace, "script.cjs");
  const markerPath = join(root, "executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = {
    type: "command",
    command: process.execPath,
    args: ["script.cjs", markerPath],
  } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await writeMarkerScript(scriptPath, "trusted");

  const trustStore = new HookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  assert.equal(pendingEntry.trusted, false);
  await trustStore.trustResolved(workspace, pendingEntry);

  const active = await loadHookSnapshot({
    workDir: workspace,
    picoHome,
    trustStore,
    version: 2,
  });
  const activeEntry = active.snapshot.handlers.PreToolUse[0];
  assert.ok(activeEntry?.trusted);
  const executor = new DefaultHookExecutor({ workDir: workspace });
  context.after(async () => await executor.dispose());
  const service = new HookService({
    workDir: workspace,
    sessionId: "hook-execution-trust",
    executor,
    snapshot: active.snapshot,
    revalidateExecutableTrust: async (entry) =>
      (await trustStore.status({
        workspace,
        source: entry.source,
        handler: entry.handler,
      })) === "active",
  });

  await service.dispatch("PreToolUse", { tool_name: "read_file", tool_input: {} });
  assert.equal(await readFile(markerPath, "utf8"), "trusted");
  await rm(markerPath);

  await writeMarkerScript(scriptPath, "changed");
  assert.equal(
    await trustStore.status({ workspace, source: activeEntry.source, handler }),
    "pending",
  );
  const denied = await service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(markerPath), false, "变化后的脚本字节不得在 watcher debounce 前执行");
  assert.ok(denied.diagnostics?.some((diagnostic) => /执行前信任已失效/u.test(diagnostic.message)));
});

test("each command Hook revalidates after preceding handlers complete", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-sequential-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const mutatorPath = join(workspace, "mutator.cjs");
  const victimPath = join(workspace, "victim.cjs");
  const markerPath = join(root, "victim-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handlers = [
    { type: "command", command: process.execPath, args: ["mutator.cjs", victimPath] },
    { type: "command", command: process.execPath, args: ["victim.cjs", markerPath] },
  ] as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: handlers }] }, null, 2)}\n`,
  );
  await writeFile(
    mutatorPath,
    `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(
      'require("node:fs").writeFileSync(process.argv[2], "changed");\n',
    )});\n`,
  );
  await writeMarkerScript(victimPath, "trusted");

  const trustStore = new HookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  assert.equal(pending.snapshot.handlers.PreToolUse.length, 2);
  for (const entry of pending.snapshot.handlers.PreToolUse) {
    await trustStore.trustResolved(workspace, entry);
  }
  const active = await loadHookSnapshot({
    workDir: workspace,
    picoHome,
    trustStore,
    version: 2,
  });
  assert.ok(active.snapshot.handlers.PreToolUse.every((entry) => entry.trusted));

  const executor = new DefaultHookExecutor({ workDir: workspace });
  context.after(async () => await executor.dispose());
  const service = new HookService({
    workDir: workspace,
    sessionId: "hook-sequential-trust",
    executor,
    snapshot: active.snapshot,
    concurrency: 1,
    revalidateExecutableTrust: async (entry) =>
      (await trustStore.status({
        workspace,
        source: entry.source,
        handler: entry.handler,
      })) === "active",
  });

  const denied = await service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(markerPath), false, "前序 Hook 改写的后续脚本不得沿用预检查结果");
  assert.equal(
    await trustStore.status({
      workspace,
      source: active.snapshot.handlers.PreToolUse[1]!.source,
      handler: handlers[1],
    }),
    "pending",
  );
  assert.ok(denied.diagnostics?.some((diagnostic) => /执行前信任已失效/u.test(diagnostic.message)));
});

async function writeMarkerScript(path: string, marker: string): Promise<void> {
  await writeFile(
    path,
    `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(marker)});\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}
