import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { folderWorkspaceCapabilities } from "../../apps/desktop/src/renderer/model.js";
import { shouldBatchHydrateRuntimeNotification } from "../../apps/desktop/src/renderer/runtime.js";
import {
  TEMPORARY_WORKSPACE_LABEL,
  newSessionHref,
  workspaceDisplayName,
} from "../../apps/desktop/src/renderer/workspace-session.js";

test("global new task ensures the temporary workspace without inheriting a project", async () => {
  const appSource = await rendererSource("App.tsx");
  const newTaskPage = appSource.slice(
    appSource.indexOf("function NewTaskPage"),
    appSource.indexOf("interface ConversationEnvironmentPanelProps"),
  );
  assert.match(newTaskPage, /if \(!workspacePath\)/u);
  assert.match(newTaskPage, /actions\.ensureTemporaryWorkspace\(\)/u);
  assert.match(
    newTaskPage,
    /navigate\(newSessionHref\(temporaryWorkspacePath\), \{ replace: true \}\)/u,
  );
  assert.doesNotMatch(newTaskPage, /data\.workspacePath[^\n]+newSessionHref/u);

  const runtimeSource = await rendererSource("runtime.ts");
  const ensureAction = runtimeSource.slice(
    runtimeSource.indexOf("async ensureTemporaryWorkspace"),
    runtimeSource.indexOf(
      "async selectWorkspace",
      runtimeSource.indexOf("async ensureTemporaryWorkspace"),
    ),
  );
  assert.match(ensureAction, /invoke\(bridge, "workspace\.temporary\.ensure", \{\}\)/u);
  assert.match(ensureAction, /loadWorkspace\(bridge, status\.workspacePath\)/u);
});

test("temporary workspace keeps a stable UI label and can switch to a real project", async () => {
  const temporary = {
    path: "/state/temporary-workspace",
    name: "temporary-workspace",
    temporary: true as const,
  };
  assert.equal(workspaceDisplayName(temporary.path, temporary), TEMPORARY_WORKSPACE_LABEL);
  assert.equal(
    workspaceDisplayName("/projects/pico", {
      path: "/projects/pico",
      name: "pico",
    }),
    "pico",
  );
  assert.match(newSessionHref("/projects/pico"), /workspace=%2Fprojects%2Fpico/u);

  const appSource = await rendererSource("App.tsx");
  assert.match(appSource, /workspaceDisplayName\(workspacePath, workspace\)/u);
  assert.match(appSource, /!nested && workspace\?\.temporary/u);
  assert.match(appSource, /navigate\(newSessionHref\(nextWorkspacePath\)\)/u);
  assert.match(appSource, /<option key=\{workspace\.path\} value=\{workspace\.path\}>/u);

  const runtimeSource = await rendererSource("runtime.ts");
  assert.match(runtimeSource, /workspace\.temporary === true/u);
  assert.match(runtimeSource, /temporary: true as const/u);
});

test("temporary workspace omits trust revocation and Git worktree capabilities", async () => {
  assert.equal(folderWorkspaceCapabilities.isolatedWorktrees, false);
  assert.equal(folderWorkspaceCapabilities.branchMerge, false);

  const appSource = await rendererSource("App.tsx");
  const settingsPage = appSource.slice(
    appSource.indexOf("function WorkspaceSettingsPage"),
    appSource.indexOf("function SystemSettingsPage"),
  );
  assert.match(settingsPage, /currentWorkspace\?\.temporary === true/u);
  assert.match(
    settingsPage,
    /temporaryWorkspace \? \([\s\S]+<StatusPill status="ready" \/>[\s\S]+撤销信任/u,
  );
  assert.match(settingsPage, /data\.workspaceMode === "folder" && !temporaryWorkspace/u);
  assert.match(settingsPage, /!temporaryWorkspace && \([\s\S]+初始化 Pico 项目/u);
});

test("terminal run notifications batch hydrate so run.finished converges to idle", async () => {
  assert.equal(shouldBatchHydrateRuntimeNotification("run.started"), false);
  assert.equal(shouldBatchHydrateRuntimeNotification("run.timeline"), false);
  for (const topic of ["run.updated", "run.paused", "run.resumed", "run.finished"]) {
    assert.equal(shouldBatchHydrateRuntimeNotification(topic), true, topic);
  }

  const runtimeSource = await rendererSource("runtime.ts");
  const eventBranch = runtimeSource.slice(
    runtimeSource.indexOf("const handleEvent"),
    runtimeSource.indexOf("void (async () =>", runtimeSource.indexOf("const handleEvent")),
  );
  assert.match(
    eventBranch,
    /shouldBatchHydrateRuntimeNotification\(topic\)[\s\S]+scheduleHydration\(stringValue\(scope\.sessionId\) \|\| undefined\)/u,
  );
});

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
