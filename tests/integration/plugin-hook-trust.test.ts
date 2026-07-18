import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionHookRuntime } from "../../src/hooks/runtime.js";
import { PluginManagementService } from "../../src/plugins/plugin-management-service.js";
import { resolvePluginScopeRoots } from "../../src/plugins/plugin-manager.js";
import { loadPluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";

test("materialized plugin Hook trust survives a new snapshot and is revoked on dispose", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plugin-hook-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const pluginRoot = join(workspace, "plugin-source");
  const marker = join(root, "marker.txt");
  await mkdir(join(pluginRoot, ".pico"), { recursive: true });
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const scopeRoots = resolvePluginScopeRoots(workspace, { picoHome });
  assert.equal(scopeRoots.user, join(picoHome, "plugins"));
  const canonicalWorkspace = await realpath(workspace);
  assert.equal(scopeRoots.project, join(canonicalWorkspace, ".pico", "plugins"));
  assert.equal(scopeRoots.local, join(canonicalWorkspace, ".claw", "plugins"));
  await writeFile(
    join(pluginRoot, ".pico", "plugin.json"),
    JSON.stringify({ name: "fixture-plugin" }),
  );
  await writeFile(
    join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      PreToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/hook.cjs", marker],
            },
          ],
        },
      ],
    }),
  );
  await writeHookScript(join(pluginRoot, "hook.cjs"), "trusted");
  context.after(() => rm(root, { recursive: true, force: true }));

  const service = new PluginManagementService({ workDir: workspace, picoHome });
  const installed = await service.install("plugin-source", "local");
  assert.equal(installed.success, true);
  const reference = { id: "fixture-plugin", scope: "local" as const };
  const proposal = await service.prepareTrust(reference);
  await service.trust(proposal);
  await service.enable(reference);

  const env = { ...process.env, PATH: process.env.PATH ?? "" };
  const first = await loadPluginRuntimeSnapshot({ workDir: workspace, picoHome, env });
  assert.equal(first.hookSources.length, 1);
  const firstSource = first.hookSources[0]!;
  assert.equal(
    firstSource.trustAuthority?.identity?.resourceDigest,
    proposal.resourceDigest,
    "the Hook authority carries the PluginTrustStore fingerprint identity",
  );
  const firstRuntime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "plugin-hook-first",
    env,
    extensionSources: first.hookSources,
  });
  context.after(async () => await firstRuntime.dispose());
  assert.equal(firstRuntime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted, true);
  await firstRuntime.service.dispatch("PreToolUse", { tool_name: "read_file", tool_input: {} });
  assert.equal(await readFile(marker, "utf8"), "trusted");
  await rm(marker);

  const second = await loadPluginRuntimeSnapshot({ workDir: workspace, picoHome, env });
  assert.equal(second.hookSources.length, 1);
  assert.notEqual(second.hookSources[0]!.path, firstSource.path);
  const secondRuntime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "plugin-hook-second",
    env,
    extensionSources: second.hookSources,
  });
  context.after(async () => await secondRuntime.dispose());
  assert.equal(secondRuntime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted, true);
  await secondRuntime.service.dispatch("PreToolUse", { tool_name: "read_file", tool_input: {} });
  assert.equal(await readFile(marker, "utf8"), "trusted");
  await rm(marker);

  await first.dispose();
  const disposedResult = await firstRuntime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });
  assert.equal(await exists(marker), false, "disposed snapshot must fail closed before execution");
  assert.ok(disposedResult.diagnostics?.some((item) => /信任已失效/u.test(item.message)));

  const installedPlugin = (await service.inspect(reference)).installed;
  await writeHookScript(join(installedPlugin.installPath, "hook.cjs"), "changed");
  const changed = await loadPluginRuntimeSnapshot({ workDir: workspace, picoHome, env });
  assert.equal(
    changed.hookSources.length,
    0,
    "changed installed bytes must not enter a new snapshot",
  );
  assert.ok(changed.diagnostics.some((item) => /changed|fingerprint|trusted/u.test(item.message)));
  await changed.dispose();
  await second.dispose();
});

async function writeHookScript(path: string, value: string): Promise<void> {
  await writeFile(
    path,
    `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(value)});\n`,
  );
  await chmod(path, 0o700);
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
