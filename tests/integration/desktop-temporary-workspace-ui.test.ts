import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { folderWorkspaceCapabilities } from "../../apps/desktop/src/renderer/model.js";
import { shouldBatchHydrateRuntimeNotification } from "../../apps/desktop/src/renderer/runtime.js";
import {
  TEMPORARY_WORKSPACE_LABEL,
  TEMPORARY_WORKSPACE_GROUP_LABEL,
  newSessionHref,
  workspaceDisplayName,
} from "../../apps/desktop/src/renderer/workspace-session.js";
import { TemporaryWorkspaceRequest } from "../../apps/desktop/src/renderer/temporary-workspace-request.js";

test("global new task ensures the temporary workspace without inheriting a project", async () => {
  const appSource = await rendererSource("App.tsx");
  const newTaskPage = appSource.slice(
    appSource.indexOf("function NewTaskPage"),
    appSource.indexOf("interface ConversationEnvironmentPanelProps"),
  );
  assert.match(newTaskPage, /if \(!workspacePath\)/u);
  assert.match(newTaskPage, /actions\.ensureTemporaryWorkspace\(\)/u);
  assert.match(newTaskPage, /aria-label="正在准备新任务"/u);
  assert.match(newTaskPage, /<p>正在准备无项目任务…<\/p>/u);
  assert.ok(
    newTaskPage.indexOf('aria-label="正在准备新任务"') <
      newTaskPage.lastIndexOf("return <ConversationPage />"),
    "the unbound route must render a dedicated preparation state instead of a stale composer",
  );
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
  assert.match(ensureAction, /temporaryWorkspaceRequest\.current\.run/u);
  assert.match(ensureAction, /await loadWorkspace\(bridge, status\.workspacePath\)/u);
  assert.doesNotMatch(
    ensureAction,
    /loadWorkspaceIndex/u,
    "new task must not wait for every registered workspace to refresh",
  );
});

test("a stale workspace index cannot remove the newly activated workspace", async () => {
  const runtimeSource = await rendererSource("runtime.ts");
  const indexLoad = runtimeSource.slice(
    runtimeSource.indexOf("const loadWorkspaceIndex"),
    runtimeSource.indexOf("const loadUserCapabilities"),
  );
  assert.match(indexLoad, /workspaceIndexLoadGenerationRef\.current \+ 1/u);
  assert.match(
    indexLoad,
    /workspaceIndexLoadGenerationRef\.current !== generation\) return workspaces/u,
  );
  assert.match(
    indexLoad,
    /workspaceIndexLoadGenerationRef\.current !== generation\) return current/u,
  );

  const workspaceLoad = runtimeSource.slice(
    runtimeSource.indexOf("const loadWorkspace ="),
    runtimeSource.indexOf("const loadConversation ="),
  );
  assert.match(workspaceLoad, /workspaceIndexLoadGenerationRef\.current \+= 1/u);
  assert.match(workspaceLoad, /workspaceLoadIntentRef\.current = workspacePath/u);

  const focusRefresh = runtimeSource.slice(
    runtimeSource.indexOf("const refreshOnFocus"),
    runtimeSource.indexOf("window.addEventListener", runtimeSource.indexOf("const refreshOnFocus")),
  );
  assert.match(
    focusRefresh,
    /dataRef\.current\.workspacePath === workspacePath[\s\S]*?workspaceLoadIntentRef\.current === workspacePath/u,
  );

  const subscriptionBootstrap = runtimeSource.slice(
    runtimeSource.indexOf('const boundary = await bridge.runtime["events.replay"]'),
    runtimeSource.indexOf("subscription = bridge.events.subscribe"),
  );
  const staleGuard = subscriptionBootstrap.indexOf(
    "workspaceLoadIntentRef.current !== workspacePath",
  );
  const workspaceHydration = subscriptionBootstrap.indexOf(
    "await loadWorkspace(bridge, workspacePath)",
  );
  assert.ok(staleGuard >= 0 && staleGuard < workspaceHydration);
});

test("concurrent new-task effects share one temporary workspace request", async () => {
  const request = new TemporaryWorkspaceRequest();
  let resolve!: (workspacePath: string) => void;
  let calls = 0;
  const operation = () => {
    calls += 1;
    return new Promise<string>((next) => {
      resolve = next;
    });
  };

  const first = request.run(operation);
  const second = request.run(operation);
  assert.strictEqual(second, first);
  assert.equal(calls, 1);

  resolve("/state/temporary-workspace");
  assert.equal(await first, "/state/temporary-workspace");
  await Promise.resolve();

  const next = request.run(async () => {
    calls += 1;
    return "/state/another-temporary-workspace";
  });
  assert.equal(calls, 2, "a new request may start after the previous task is ready");
  assert.equal(await next, "/state/another-temporary-workspace");
});

test("a failed temporary workspace request can be retried", async () => {
  const request = new TemporaryWorkspaceRequest();
  await assert.rejects(request.run(async () => Promise.reject(new Error("unavailable"))));
  await Promise.resolve();
  assert.equal(
    await request.run(async () => "/state/recovered-workspace"),
    "/state/recovered-workspace",
  );
});

test("temporary workspace keeps a stable UI label and can switch to a real project", async () => {
  const temporary = {
    path: "/state/temporary-workspace",
    name: "temporary-workspace",
    temporary: true as const,
  };
  assert.equal(workspaceDisplayName(temporary.path, temporary), TEMPORARY_WORKSPACE_LABEL);
  assert.equal(TEMPORARY_WORKSPACE_LABEL, "无项目");
  assert.equal(TEMPORARY_WORKSPACE_GROUP_LABEL, "未归属项目");
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
  assert.match(appSource, /TEMPORARY_WORKSPACE_GROUP_LABEL/u);
  assert.match(
    appSource,
    /const projectWorkspaceOptions = data\.workspaces\.filter\([\s\S]*?candidate\.temporary !== true/u,
  );
  assert.match(appSource, /projectWorkspaceOptions\.map\(\(workspace\) =>/u);
  assert.match(
    appSource,
    /workspace\?\.temporary \? TEMPORARY_PROJECT_OPTION_VALUE : workspacePath/u,
  );
  assert.match(
    appSource,
    /nextWorkspacePath === CHOOSE_PROJECT_OPTION_VALUE[\s\S]*?void chooseProjectFolder\(\)/u,
  );
  assert.match(
    appSource,
    /<option value=\{TEMPORARY_PROJECT_OPTION_VALUE\}>\s*\{workspaceLabel\}\s*<\/option>/u,
  );
  assert.match(appSource, /navigate\(newSessionHref\(nextWorkspacePath\)\)/u);
  assert.match(appSource, /<option key=\{workspace\.path\} value=\{workspace\.path\}>/u);
  assert.match(appSource, /const chooseProjectFolder = async \(\) =>/u);
  assert.match(appSource, /title="打开项目文件夹"/u);
  assert.match(
    appSource,
    /const chooseProjectFolder[\s\S]*?actions\.chooseWorkspace\(\)[\s\S]*?navigate\(newSessionHref\(path\)\)/u,
  );

  const runtimeSource = await rendererSource("runtime.ts");
  assert.match(runtimeSource, /workspace\.temporary === true/u);
  assert.match(runtimeSource, /temporary: true as const/u);
});

test("first send leaves the new-task shell as soon as its session appears", async () => {
  const appSource = await rendererSource("App.tsx");
  assert.match(appSource, /firstSendBaselineRef/u);
  assert.match(appSource, /setAwaitingFirstSession\(true\)/u);
  assert.match(
    appSource,
    /!firstSendBaselineRef\.current\.has\(candidate\.id\)[\s\S]*?sessionHref\(\{ workspacePath: createdSession\.workspacePath, sessionId: createdSession\.id \}\)/u,
  );
});

test("temporary workspace omits trust revocation and Git worktree capabilities", async () => {
  assert.equal(folderWorkspaceCapabilities.isolatedWorktrees, false);
  assert.equal(folderWorkspaceCapabilities.branchMerge, false);

  const appSource = await rendererSource("App.tsx");
  const settingsPage = appSource.slice(
    appSource.indexOf("function WorkspaceSettingsPage"),
    appSource.indexOf("function SystemSettingsPage"),
  );
  assert.match(settingsPage, /find\(\(workspace\) => workspace\.temporary === true\)/u);
  assert.match(settingsPage, /filter\(\(workspace\) => workspace\.temporary !== true\)/u);
  assert.match(settingsPage, /Pico 私有任务空间/u);
  assert.match(settingsPage, /temporaryWorkspace \? "ready" : "disabled"/u);
  const projectActions = settingsPage.slice(settingsPage.indexOf("projects.map"));
  assert.match(projectActions, /撤销信任/u);
  assert.match(projectActions, /unregisterWorkspace\(workspace\.path\)/u);
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
