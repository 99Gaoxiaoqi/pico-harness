import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  describePluginScopeRegistry,
  isPluginPathWithinScope,
  pluginInstallPath,
  pluginScopePriority,
  resolvePluginScopeRoots,
  selectPluginScopeWinners,
} from "../../src/plugins/plugin-scope.js";
import { PluginManager } from "../../src/plugins/plugin-manager.js";
import {
  formatPluginDiagnostics,
  fromMaterializationDiagnostics,
  fromRuntimeDiagnostics,
} from "../../src/plugins/plugin-diagnostics.js";

test("plugin scopes resolve to isolated roots and deterministic priority winners", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plugin-scope-"));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const picoHome = join(root, "pico-home");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const rootsA = resolvePluginScopeRoots(workspaceA, { picoHome });
  const rootsB = resolvePluginScopeRoots(workspaceB, { picoHome });
  assert.equal(rootsA.user, rootsB.user);
  assert.notEqual(rootsA.project, rootsB.project);
  assert.notEqual(rootsA.local, rootsB.local);
  assert.equal(pluginScopePriority("user"), 1);
  assert.equal(pluginScopePriority("project"), 2);
  assert.equal(pluginScopePriority("local"), 3);
  assert.equal(pluginInstallPath("local", "formatters", rootsA), join(rootsA.local, "formatters"));
  assert.equal(isPluginPathWithinScope("local", join(rootsA.local, "formatters"), rootsA), true);
  assert.equal(isPluginPathWithinScope("local", join(rootsA.project, "formatters"), rootsA), false);

  const registry = describePluginScopeRegistry(workspaceA, { picoHome });
  assert.equal(registry.userStatePath, join(picoHome, "plugins.json"));
  assert.match(registry.workspaceStatePath, /workspaces/u);
  assert.equal(registry.roots.local, rootsA.local);

  const winners = selectPluginScopeWinners([
    { id: "formatter", scope: "user" as const },
    { id: "formatter", scope: "project" as const },
    { id: "formatter", scope: "local" as const },
    { id: "lint", scope: "user" as const },
  ]);
  assert.deepEqual(winners, [
    { id: "formatter", scope: "local" },
    { id: "lint", scope: "user" },
  ]);
});

test("manager copies external plugins into the declared root and keeps user registry global", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plugin-managed-root-"));
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const source = join(root, "source-plugin");
  const picoHome = join(root, "pico-home");
  await mkdir(join(source, ".pico"), { recursive: true });
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeFile(join(source, ".pico", "plugin.json"), JSON.stringify({ name: "stable-plugin" }));
  await writeFile(join(source, "README.md"), "v1\n");
  context.after(() => rm(root, { recursive: true, force: true }));

  const managerA = new PluginManager({ workDir: workspaceA, picoHome });
  const installed = await managerA.installFromDirectory(source, "local");
  assert.equal(installed.success, true, installed.message);
  const rootsA = resolvePluginScopeRoots(workspaceA, { picoHome });
  const entriesA = await managerA.list();
  assert.equal(entriesA.length, 1);
  assert.equal(entriesA[0]?.installPath, join(rootsA.local, "stable-plugin"));
  assert.equal(relative(rootsA.local, entriesA[0]!.installPath).startsWith(".."), false);
  assert.equal(await readFile(join(entriesA[0]!.installPath, "README.md"), "utf8"), "v1\n");

  const managerB = new PluginManager({ workDir: workspaceB, picoHome });
  const userInstall = await managerB.installFromDirectory(source, "user");
  assert.equal(userInstall.success, true, userInstall.message);
  const userEntriesB = (await managerB.list()).filter((item) => item.scope === "user");
  assert.equal(userEntriesB.length, 1);
  assert.equal(userEntriesB[0]?.installPath, join(rootsA.user, "stable-plugin"));

  // A changed source cannot silently replace a managed copy in the same scope.
  await writeFile(join(source, "README.md"), "v2\n");
  const conflict = await managerA.installFromDirectory(source, "local");
  assert.equal(conflict.success, false);
  assert.match(conflict.message, /plugin_scope_conflict/u);
});

test("plugin diagnostics normalize materialization/runtime failures into stable text", () => {
  const materialization = fromMaterializationDiagnostics([
    { pluginId: "formatter", sourcePath: "/plugins/formatter", message: "not trusted" },
  ]);
  const runtime = fromRuntimeDiagnostics([
    { pluginId: "formatter", sourcePath: "/runtime/hooks.json", message: "invalid JSON" },
  ]);
  const lines = formatPluginDiagnostics([...materialization, ...runtime]);
  assert.deepEqual(lines, [
    "- [error] plugin_materialization_failed (formatter): not trusted · /plugins/formatter",
    "- [warning] plugin_runtime_contribution_invalid (formatter): invalid JSON · /runtime/hooks.json",
  ]);
});
