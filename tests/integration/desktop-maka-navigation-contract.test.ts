import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appPrimaryNavigation,
  legacySurfaceHref,
  settingsNavigationGroups,
  sortSidebarTasks,
} from "../../apps/desktop/src/renderer/navigation.js";

test("desktop main sidebar follows the Maka task-first information architecture", async () => {
  assert.deepEqual(
    appPrimaryNavigation.map(({ label, to }) => ({ label, to })),
    [{ label: "定时任务", to: "/automations" }],
  );

  const source = await rendererSource("App.tsx");
  assert.match(source, /aria-label="任务分组方式"/u);
  assert.match(source, /setGrouping\("time"\)/u);
  assert.match(source, /setGrouping\("project"\)/u);
  assert.match(source, /className="sidebar-project__header"/u);
  assert.doesNotMatch(source, /const resourceNav/u);
  assert.doesNotMatch(source, /sidebar-project__header"[\s\S]{0,180}to=\{newSessionHref/u);
});

test("settings replaces the task sidebar and owns tool capability routes", async () => {
  assert.deepEqual(
    settingsNavigationGroups.map((group) => ({
      label: group.label,
      items: group.items.map((item) => item.label),
    })),
    [
      { label: "偏好", items: ["通用", "项目"] },
      { label: "能力", items: ["模型", "记忆", "Skills", "MCP"] },
      { label: "活动", items: ["用量"] },
      { label: "系统", items: ["健康"] },
    ],
  );
  assert.equal(
    legacySurfaceHref("/settings/models", "?workspace=%2Ftmp%2Fpico"),
    "/settings/models?workspace=%2Ftmp%2Fpico",
  );

  const source = await rendererSource("App.tsx");
  assert.match(source, /settingsRoute \? \(/u);
  assert.match(
    source,
    /location\.pathname\.startsWith\("\/settings"\)[\s\S]{0,100}location\.pathname\.startsWith\("\/extensions"\)/u,
  );
  assert.match(source, /<SettingsSidebar/u);
  assert.match(source, /path="settings" element=\{<SettingsPage \/>\}/u);
  const settingsRouteStart = source.indexOf('<Route path="settings"');
  const workspaceSettingsRouteStart = source.indexOf(
    'path="settings/workspaces"',
    settingsRouteStart,
  );
  assert.doesNotMatch(
    source.slice(settingsRouteStart, workspaceSettingsRouteStart),
    /WorkspaceRoute/u,
  );
});

test("invalid workspace query falls back to an interactive new task", async () => {
  const source = await rendererSource("App.tsx");
  const newTaskPage = source.slice(
    source.indexOf("function NewTaskPage"),
    source.indexOf("interface ConversationEnvironmentPanelProps"),
  );
  assert.match(
    newTaskPage,
    /if \(workspacePath && !workspace\) \{\s+return <Navigate replace to="\/task\/new" \/>;\s+\}/u,
  );
});

test("sidebar pending state includes prompts and is scoped by workspace plus session", async () => {
  const source = await rendererSource("App.tsx");
  const sidebarTasks = source.slice(
    source.indexOf("function SidebarTasks"),
    source.indexOf("function SidebarSessionRow"),
  );
  assert.match(source, /prompts=\{data\.prompts\}/u);
  assert.match(sidebarTasks, /run\.workspacePath === session\.workspacePath/u);
  assert.match(sidebarTasks, /run\.sessionId === session\.id/u);
  assert.match(sidebarTasks, /sessionRunIds\.has\(approval\.runId\)/u);
  assert.match(sidebarTasks, /prompts\.some\(\(prompt\) => sessionRunIds\.has\(prompt\.runId\)\)/u);
  assert.match(sidebarTasks, /activeWorkspacePath === session\.workspacePath/u);
});

test("new task settings prefer canonical defaults and only use legacy mode as fallback", async () => {
  const source = await rendererSource("App.tsx");
  const defaults = source.slice(
    source.indexOf("const newTaskSettings"),
    source.indexOf("const updateNewTaskSettings"),
  );
  assert.match(defaults, /defaults\.collaborationMode \?\?/u);
  assert.match(defaults, /defaults\.orchestrationMode \?\? "default"/u);
  assert.match(defaults, /defaults\.permissionMode \?\?/u);
  assert.match(defaults, /legacyMode === "plan"/u);
  assert.match(defaults, /legacyMode === "auto" \|\| legacyMode === "yolo"/u);
});

test("deleting a session removes only its session-owned composer draft", async () => {
  const source = await rendererSource("App.tsx");
  const deleteHandler = source.slice(
    source.indexOf("const handleDeleteSession"),
    source.indexOf("return (", source.indexOf("const handleDeleteSession")),
  );
  assert.match(
    deleteHandler,
    /if \(deleted\) \{[\s\S]{0,120}removePersistentDraft\([\s\S]{0,160}workspaceSessionKey/u,
  );
  assert.doesNotMatch(deleteHandler, /memory/i);
});

test("time grouping sorts pinned tasks first and then uses recency", () => {
  const sorted = sortSidebarTasks([
    { id: "older", updatedAt: 20 },
    { id: "pinned", updatedAt: 10, pinned: true },
    { id: "newer", updatedAt: 30 },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["pinned", "newer", "older"],
  );
});

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
