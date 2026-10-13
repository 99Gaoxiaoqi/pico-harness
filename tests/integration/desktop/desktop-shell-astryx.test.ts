import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("Astryx 侧栏项目操作与键盘导航", { timeout: 45_000 }, async (t) => {
  const candidates = [
    process.env.PICO_TEST_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
  let chrome: string | undefined;
  for (const candidate of candidates) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      chrome = candidate;
      break;
    }
  }
  if (!chrome) {
    t.skip("需要 Chrome/Chromium，可通过 PICO_TEST_CHROME 指定浏览器");
    return;
  }
  const bundle = await build({
    stdin: {
      contents: shellScenario,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "tsx",
    },
    outdir: "/virtual-pico-shell",
    loader: { ".svg": "dataurl" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  assert.ok(script);
  const outcome = Promise.withResolvers<string>();
  const server = createServer((request, response) => {
    if (request.url === "/result") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        response.end("ok");
        outcome.resolve(body);
      });
      return;
    }
    response.setHeader(
      "content-type",
      request.url === "/bundle.js"
        ? "text/javascript"
        : request.url === "/bundle.css"
          ? "text/css"
          : "text/html",
    );
    response.end(
      request.url === "/bundle.js"
        ? script
        : request.url === "/bundle.css"
          ? css
          : '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>',
    );
  });
  const profile = await mkdtemp(join(tmpdir(), "pico-shell-ui-"));
  let browser: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--window-size=1280,900",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${address.port}`,
      ],
      { stdio: "ignore" },
    );
    browser.once("error", outcome.reject);
    timer = setTimeout(
      () => outcome.reject(new Error("Browser UI scenario did not finish in 30 seconds")),
      30_000,
    );
    const result = await outcome.promise;
    assert.match(result, /^PASS: desktop shell navigation and search$/, result);
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
      browser.kill("SIGTERM");
      await closed;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

const shellScenario = `
import "./apps/desktop/src/renderer/layers.css";
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter, Routes, Route, useLocation} from "react-router-dom";
import {AppShell} from "./apps/desktop/src/renderer/AppShell.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
import "./apps/desktop/src/renderer/styles.css";
import "./apps/desktop/src/renderer/astryx-controls.css";
import "./apps/desktop/src/renderer/shell-astryx.css";
Object.assign(globalThis, {React, IS_REACT_ACT_ENVIRONMENT: true});
const mainPath = "/workspace/maka-harness";
const linkedPath = "/workspace/maka-harness-feature";
const emptyWorktreePath = "/workspace/maka-harness-empty";
const clonePath = "/workspace/independent-clone";
const scenarioData = {
  ...previewData,
  workspaces: [
    {...previewData.workspaces[0], path: mainPath, name: "maka-harness", projectId: "shared-project", projectName: "maka-harness"},
    {...previewData.workspaces[0], path: linkedPath, name: "maka-harness-feature", projectId: "shared-project", projectName: "maka-harness"},
    {...previewData.workspaces[0], path: emptyWorktreePath, name: "maka-harness-empty", projectId: "shared-project", projectName: "maka-harness"},
  ],
  sessions: previewData.sessions.map((session, index) => ({
    ...session,
    workspacePath: index === 1 ? linkedPath : mainPath,
    projectId: "shared-project",
    projectName: "maka-harness",
  })),
  runs: previewData.runs.map((run) => ({...run, workspacePath: mainPath})),
};
const target = document.getElementById("app");
target.style.height = "100%";
const writes = [];
let confirmResult = true;
let failArchive = false;
let failUnregister = false;
window.confirm = () => confirmResult;
const runtime = {
  data: scenarioData, preview: false, busy: false, message: "",
  actions: {
    setSessionPinned: async (...args) => writes.push(["pin", ...args]),
    setSessionArchived: async (ref, archived) => {
      writes.push(["archive", ref, archived]);
      if (failArchive) return false;
      runtime.data = {...runtime.data, sessions: runtime.data.sessions.map(session =>
        session.workspacePath === ref.workspacePath && session.id === ref.sessionId
          ? {...session, status: archived ? "archived" : "active"} : session)};
      render();
      return true;
    },
    unregisterWorkspace: async (workspacePath) => {
      writes.push(["unregister", workspacePath]);
      if (failUnregister) return false;
      runtime.data = {
        ...runtime.data,
        workspaces: runtime.data.workspaces.filter(workspace => workspace.path !== workspacePath),
        sessions: runtime.data.sessions.filter(session => session.workspacePath !== workspacePath),
        runs: runtime.data.runs.filter(run => run.workspacePath !== workspacePath),
      };
      render();
      return true;
    },
    deleteSession: async (...args) => writes.push(["delete", ...args]),
  }
};
function Page() {
  const location = useLocation();
  return <div data-page data-workspace={new URLSearchParams(location.search).get("workspace") || ""}>{location.pathname}</div>;
}
const root = createRoot(target);
const check = (value, message) => { if (!value) throw new Error(message); };
const button = (name) => {
  const found = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name || item.textContent.trim() === name);
  check(found, "Missing button " + name);
  return found;
};
const click = async (name) => { await act(async () => { button(name).focus(); button(name).click(); }); };
const key = async (element, key, options = {}) => {
  await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true, ...options})));
};
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const render = () => root.render(<PicoTheme><RuntimeContext value={runtime}><MemoryRouter initialEntries={["/task/new"]}><Routes><Route element={<AppShell/>}><Route path="*" element={<Page/>}/></Route></Routes></MemoryRouter></RuntimeContext></PicoTheme>);
const projectMenu = () => document.querySelector('[role="menu"][aria-label="项目操作 maka-harness"]');
const projectItem = (name) => [...projectMenu().querySelectorAll('[role="menuitem"]')].find(item => item.textContent.includes(name));
const clickProjectItem = async (name) => {
  await click("项目操作 maka-harness");
  await frame();
  check(projectItem(name), "Missing project action " + name);
  await act(async () => projectItem(name).click());
  await frame();
};
async function scenario() {
  await act(async () => render());
  await frame();
  const sidebar = () => document.querySelector(".sidebar").getBoundingClientRect();
  check(Math.abs(sidebar().width - 226) < 1, "Expanded sidebar width: " + sidebar().width);
  check(document.querySelectorAll('[role="main"],main').length === 1, "Only one main landmark");
  check(getComputedStyle(document.querySelector("#astryx-app-shell-main")).overflow === "hidden", "Shell must not create a second scrolling content area");
  check(getComputedStyle(button("搜索任务")).getPropertyValue("-webkit-app-region") === "no-drag", "Search remains clickable in drag region");
  const searchRect = button("搜索任务").getBoundingClientRect();
  check(searchRect.width === 30 && searchRect.height === 30, "Search button keeps 30px geometry");
  check(button("按时间分组").getBoundingClientRect().height === 26, "Grouping control retains 26px height");
  check(document.querySelector(".sidebar-project__header"), "Project grouping is the first-run default");
  await click("收起侧栏");
  check(Math.abs(sidebar().width - 62) < 1, "Collapsed sidebar width: " + sidebar().width);
  await click("展开侧栏");
  await click("按项目分组");
  check(document.querySelectorAll(".sidebar-project__header").length === 1, "Linked worktrees share one project group");
  check(document.querySelectorAll(".sidebar-project__sessions .sidebar-task-link").length === 2, "Both worktree sessions remain visible in the shared group");
  await click("项目操作 maka-harness");
  await frame();
  check(projectMenu().querySelectorAll('[role="menuitem"]').length === 2 && !projectItem("创建任务"), "Project menu contains only archive and removal");
  const menuButtonRect = button("项目操作 maka-harness").getBoundingClientRect();
  const newTaskButtonRect = button("新建任务 maka-harness").getBoundingClientRect();
  check(menuButtonRect.right <= newTaskButtonRect.left && newTaskButtonRect.right <= sidebar().right, "Direct new-task button sits to the right of the project menu without overlap");
  check(projectItem("归档聊天").getAttribute("aria-disabled") === "true", "Running project cannot archive chats");
  check(projectItem("移除项目").getAttribute("aria-disabled") === "true", "Running project cannot be removed");
  check(button("maka-harness").getAttribute("aria-expanded") === "true", "Opening project menu does not collapse chats");
  await key(document.activeElement, "Escape");
  check(document.activeElement === button("项目操作 maka-harness"), "Project menu Escape restores trigger focus");
  const contextEvent = new MouseEvent("contextmenu", {bubbles: true, cancelable: true});
  await act(async () => button("maka-harness").dispatchEvent(contextEvent));
  await frame();
  check(contextEvent.defaultPrevented && projectMenu(), "Right-click opens the project menu");
  await key(document.activeElement, "Escape");
  await click("新建任务 maka-harness");
  check(document.querySelector('[data-page]').dataset.workspace === mainPath, "Project task uses the primary folder");
  check(button("项目操作 maka-harness").getAttribute("aria-expanded") === "false" && button("maka-harness").getAttribute("aria-expanded") === "true", "Direct task creation does not open the menu or collapse the project");
  await click("按时间分组");
  const running = scenarioData.sessions[0];
  const idle = scenarioData.sessions[1];
  await click("更多操作 " + running.title);
  await frame();
  const deleteItem = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes("删除"));
  check(deleteItem?.getAttribute("aria-disabled") === "true", "Running task delete stays disabled");
  await key(document.activeElement, "Escape");
  check(document.activeElement === button("更多操作 " + running.title), "Menu Escape restores trigger focus");
  await click("更多操作 " + idle.title);
  await frame();
  const idleMenu = [...document.querySelectorAll('[role="menu"]')].find(el => el.getAttribute("aria-label") === "更多操作 " + idle.title);
  const pin = [...idleMenu.querySelectorAll('[role="menuitem"]')].find(el => el.textContent === "置顶");
  check(pin, "Pin menu item");
  await act(async () => pin.click());
  check(writes.length === 1 && writes[0][0] === "pin" && writes[0][1].sessionId === idle.id && writes[0][1].workspacePath === linkedPath, "Menu keeps the linked-worktree session identity");
  await click("搜索任务");
  const input = () => document.querySelector('.task-search input');
  check(document.querySelector('dialog[open]') && document.activeElement === input(), "Search autofocuses input");
  const dialogRect = document.querySelector("dialog[open]").getBoundingClientRect();
  check(Math.abs(dialogRect.width - 580) < 1 && input().getBoundingClientRect().width > 350, "Search preserves width and usable input: " + dialogRect.width + "/" + input().getBoundingClientRect().width);
  await key(input(), "Enter", {isComposing: true});
  check(document.querySelector('dialog[open]'), "IME Enter does not select a result");
  await act(async () => {
    const field = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "重构编辑器");
    field.dispatchEvent(new Event("input", {bubbles: true}));
  });
  check(document.querySelectorAll('.task-search__result').length === 1, "Search filters task results");
  await key(input(), "ArrowDown");
  check(document.activeElement.classList.contains("task-search__result"), "ArrowDown focuses first result");
  await click("关闭搜索");
  check(!document.querySelector('dialog[open]') && document.activeElement === button("搜索任务"), "Close restores previous focus");
  await key(window, "k", {ctrlKey: true});
  check(input().value === "", "Shortcut reopen clears prior query");
  await key(input(), "Enter");
  check(document.querySelector('[data-page]').textContent === "/session/" + running.id, "Enter opens the first task");
  await key(window, "n", {ctrlKey: true});
  check(document.querySelector('[data-page]').textContent === "/task/new", "New-task shortcut still works");
  runtime.data = {
    ...runtime.data,
    runs: runtime.data.runs.map(run => ({...run, status: "completed"})),
    workspaces: [...runtime.data.workspaces, {...previewData.workspaces[0], path: clonePath, name: "independent-clone", projectId: "clone-project", projectName: "independent-clone"}],
    sessions: [...runtime.data.sessions, {...running, workspacePath: clonePath, projectId: "clone-project", projectName: "independent-clone"}],
  };
  await act(async () => render());
  await click("按项目分组");
  writes.length = 0;
  confirmResult = false;
  await clickProjectItem("归档聊天");
  check(writes.length === 0, "Cancelling project archive makes no changes");
  confirmResult = true;
  failArchive = true;
  await clickProjectItem("归档聊天");
  check(writes.length === 1 && runtime.data.sessions.filter(session => session.status === "active").length === 3, "Failed archive stops the batch and keeps chats available");
  failArchive = false;
  writes.length = 0;
  const activeLink = [...document.querySelectorAll('.sidebar-task-link')].find(link => link.getAttribute("href").includes(encodeURIComponent(mainPath)));
  await act(async () => activeLink.click());
  await clickProjectItem("归档聊天");
  check(JSON.stringify(writes) === JSON.stringify([
    ["archive", {workspacePath: mainPath, sessionId: running.id}, true],
    ["archive", {workspacePath: linkedPath, sessionId: idle.id}, true],
  ]), "Project archive includes linked worktrees and skips archived or independent-clone chats");
  check(runtime.data.sessions.find(session => session.workspacePath === clonePath).status === "active", "Same session ID in another project stays active");
  check(document.querySelector('[data-page]').textContent === "/task/new" && document.querySelector('[data-page]').dataset.workspace === mainPath, "Archiving current chat opens a new task in its workspace");
  check(button("maka-harness").querySelector("small").textContent === "0", "Empty project remains available after archiving");
  await click("项目操作 maka-harness");
  await frame();
  check(projectItem("归档聊天").getAttribute("aria-disabled") === "true", "Empty project cannot archive again");
  await key(document.activeElement, "Escape");
  await click("新建任务 maka-harness");
  check(document.querySelector('[data-page]').dataset.workspace === mainPath, "Empty project still creates tasks in the primary folder");
  writes.length = 0;
  confirmResult = false;
  await clickProjectItem("移除项目");
  check(writes.length === 0, "Cancelling project removal makes no changes");
  confirmResult = true;
  failUnregister = true;
  await clickProjectItem("移除项目");
  check(writes.length === 1 && runtime.data.workspaces.length === 4, "Failed removal stops before unregistering other worktrees");
  failUnregister = false;
  writes.length = 0;
  await clickProjectItem("移除项目");
  check(JSON.stringify(writes) === JSON.stringify([["unregister", mainPath], ["unregister", linkedPath], ["unregister", emptyWorktreePath]]), "Removal unregisters every project folder, including an empty worktree");
  check(runtime.data.workspaces.length === 1 && runtime.data.workspaces[0].path === clonePath, "Removing a project preserves other projects");
  check(!document.querySelector('[aria-label="项目操作 maka-harness"]') && document.querySelector('[data-page]').dataset.workspace === "", "Removed project disappears and selected workspace is cleared");
  check(!writes.some(write => write[0] === "delete"), "Project actions never delete chats");
  runtime.data = {
    ...runtime.data,
    workspaces: [...runtime.data.workspaces, {...previewData.workspaces[0], path: "/workspace/scratch", temporary: true, projectId: null, projectName: null}],
    sessions: [...runtime.data.sessions, {...idle, workspacePath: "/workspace/scratch", projectId: null, projectName: null}],
  };
  await act(async () => render());
  await click("项目操作 未归属项目");
  await frame();
  const scratchMenu = document.querySelector('[role="menu"][aria-label="项目操作 未归属项目"]');
  check(![...scratchMenu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.includes("移除项目")), "Managed scratch space cannot be removed");
  await key(document.activeElement, "Escape");
  await click("新建任务 未归属项目");
  check(document.querySelector('[data-page]').dataset.workspace === "", "Unassigned task creates a fresh scratch workspace");
  await act(async () => document.querySelector('a[aria-label="设置"]').click());
  check(document.querySelector(".settings-sidebar"), "Settings replaces task sidebar");
  check(Math.abs(sidebar().width - 226) < 1, "Settings sidebar geometry stays unchanged");
  await act(async () => root.unmount());
}
scenario().then(() => fetch("/result", {method:"POST", body:"PASS: desktop shell navigation and search"})).catch(error => fetch("/result", {method:"POST", body:String(error.stack || error)}));
`;
