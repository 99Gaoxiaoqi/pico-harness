import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopPreferences,
  DesktopPreferencesStore,
} from "../../apps/desktop/src/main/preferences.js";
import { parseUsage } from "../../apps/desktop/src/renderer/runtime.js";

test("desktop background preference persists in main-owned storage and malformed data fails safe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new DesktopPreferencesStore(root);
  assert.deepEqual(await store.read(), createDesktopPreferences(false));
  await store.write(createDesktopPreferences(true));
  assert.deepEqual(await new DesktopPreferencesStore(root).read(), createDesktopPreferences(true));

  await writeFile(join(root, "preferences.json"), "not-json", "utf8");
  assert.deepEqual(await store.read(), createDesktopPreferences(false));
});

test("settings routes stay globally accessible and project management never selects a workspace", async () => {
  const app = await rendererSource("App.tsx");
  const navigation = await rendererSource("navigation.ts");
  const runtime = await rendererSource("runtime.ts");

  for (const route of ["settings/workspaces", "settings/usage", "settings/system"]) {
    const start = app.indexOf(`path="${route}"`);
    const end = app.indexOf("<Route", start + 1);
    assert.ok(start >= 0 && end > start, route);
    assert.doesNotMatch(app.slice(start, end), /WorkspaceRoute/u, route);
  }
  assert.match(navigation, /to: "\/settings\/workspaces", label: "项目"/u);
  assert.doesNotMatch(navigation, /settings\/usage[^\n]+scoped: true/u);

  const page = sourceSection(app, "function WorkspaceSettingsPage", "function SystemSettingsPage");
  assert.doesNotMatch(page, /当前选择|selectWorkspace|chooseWorkspace/u);
  assert.match(page, /actions\.registerWorkspace\(\)/u);
  assert.match(page, /actions\.unregisterWorkspace\(workspace\.path\)/u);
  assert.match(page, /磁盘文件不会被删除/u);

  const register = sourceSection(
    runtime,
    "async registerWorkspace",
    "async ensureTemporaryWorkspace",
  );
  assert.match(register, /workspace\.register/u);
  assert.doesNotMatch(register, /loadWorkspace\(bridge/u);
});

test("general settings read background mode from main and preserve UI state on save failure", async () => {
  const app = await rendererSource("App.tsx");
  const runtime = await rendererSource("runtime.ts");
  const general = sourceSection(app, "function SettingsPage", "function WorkspaceSettingsPage");
  assert.doesNotMatch(general, /localStorage|pico\.background-mode/u);
  assert.match(general, /data\.backgroundMode/u);
  assert.match(general, /actions\.setBackgroundMode/u);

  const loader = sourceSection(
    runtime,
    "const loadDesktopPreferences",
    "const loadScopedCapabilities",
  );
  assert.match(loader, /lifecycle\.getBackgroundMode\(\)/u);
  const action = sourceSection(runtime, "async setBackgroundMode", "async openWorkspace");
  const save = action.indexOf("bridge.lifecycle.setBackgroundMode(enabled)");
  const state = action.indexOf("backgroundMode: enabled");
  assert.ok(
    save >= 0 && state > save,
    "Renderer state must update only after main persistence succeeds",
  );
});

test("closing the last window exits on macOS unless background mode is enabled", async () => {
  const main = await readFile(
    new URL("../../apps/desktop/src/main/index.ts", import.meta.url),
    "utf8",
  );
  const handler = sourceSection(main, 'app.on("window-all-closed"', 'app.on("activate"');
  assert.match(handler, /!lifecycle\.shouldKeepInBackground\(\)/u);
  assert.match(handler, /app\.quit\(\)/u);
  assert.doesNotMatch(handler, /process\.platform|darwin/u);
});

test("usage parser preserves global token and CNY cost semantics", () => {
  const parsed = parseUsage({
    usage: {
      scope: "all",
      providerCallCount: 4,
      usageReportCount: 3,
      baselineCount: 1,
      costStatus: "partial",
      unavailableWorkspaces: [{ workspacePath: "/missing", error: "unavailable" }],
      total: {
        totalTokens: 150,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
        costCNY: 1.25,
      },
    },
  });
  assert.equal(parsed.scope, "all");
  assert.equal(parsed.totalTokens, 150);
  assert.equal(parsed.reasoningTokens, 20);
  assert.equal(parsed.costCNY, 1.25);
  assert.equal(parsed.costStatus, "partial");
  assert.equal(parsed.unavailableWorkspaceCount, 1);
});

test("usage settings expose an accessible time filter and never display dollars", async () => {
  const app = await rendererSource("App.tsx");
  const page = sourceSection(app, "function UsagePage", "function SettingsPage");
  assert.match(page, /role="group"/u);
  assert.match(page, /aria-pressed=\{period === value\}/u);
  assert.match(page, /24 小时/u);
  assert.match(page, /全部任务/u);
  assert.match(page, /总 Tokens/u);
  assert.match(page, /推理 Tokens/u);
  assert.match(app, /`¥\$\{costCNY\.toFixed\(2\)\}`/u);
  assert.doesNotMatch(page, /\$\$\{/u);
  assert.match(page, /未显示虚假的 ¥0\.00/u);
  assert.match(page, /usageRequestSequence/u);
  assert.match(page, /requestSequence !== usageRequestSequence\.current/u);
  assert.match(page, /无法确认这个范围是否为空/u);
  assert.match(page, /totalRecords === 0[\s\S]+usage\.unavailableWorkspaceCount/u);
  assert.match(page, /历史基线只保留 Token 与费用总数/u);
});

test("changing the default model preserves every independent default axis", async () => {
  const runtime = await rendererSource("runtime.ts");
  const action = sourceSection(runtime, "async setDefaultModelRoute", "async queryUsage");
  for (const field of [
    "collaborationMode",
    "orchestrationMode",
    "permissionMode",
    "mode",
    "thinkingEffort",
  ]) {
    assert.match(action, new RegExp(`providerConfig\\.userDefaults\\.${field}`, "u"), field);
  }
});

test("deleting a locally stored provider credential requires confirmation", async () => {
  const providerPage = await rendererSource("ProviderPage.tsx");
  const credentialDialog = providerPage.slice(providerPage.indexOf("function CredentialDialog"));
  const handleDelete = sourceSection(
    credentialDialog,
    "const handleDelete = async () =>",
    "if (!provider) return null;",
  );
  assert.match(handleDelete, /window\.confirm/u);
  assert.match(handleDelete, /删除后/u);
  assert.ok(
    handleDelete.indexOf("window.confirm") < handleDelete.indexOf("onDelete(provider.id"),
    "The irreversible action must only run after confirmation",
  );
});

test("global feedback stays dismissible without covering settings actions", async () => {
  const app = await rendererSource("App.tsx");
  const runtime = await rendererSource("runtime.ts");
  const styles = await rendererSource("styles.css");
  assert.match(app, /aria-label="关闭提示"/u);
  assert.match(app, /actions\.dismissMessage/u);
  assert.match(runtime, /dismissMessage\(\) \{\s*setMessage\(undefined\)/u);
  const toast = sourceSection(styles, ".toast {", ".toast__dismiss {");
  assert.match(toast, /position: fixed/u);
  assert.match(toast, /bottom: 24px/u);
  assert.doesNotMatch(toast, /top:/u);
  assert.match(styles, /workspace-frame\.has-toast[^\n]+\.page \{\s*padding-bottom: 96px/u);
});

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}
