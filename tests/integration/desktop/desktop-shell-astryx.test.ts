import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("Astryx 桌面外壳保留侧栏尺寸、任务菜单和搜索键盘焦点", { timeout: 45_000 }, async (t) => {
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
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter, Routes, Route, useLocation} from "react-router-dom";
import {AppShell} from "./apps/desktop/src/renderer/AppShell.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
import "./apps/desktop/src/renderer/astryx-controls.css";
import "./apps/desktop/src/renderer/styles.css";
import "./apps/desktop/src/renderer/shell-astryx.css";
Object.assign(globalThis, {React, IS_REACT_ACT_ENVIRONMENT: true});
const target = document.getElementById("app");
target.style.height = "100%";
const writes = [];
const runtime = {
  data: previewData, preview: false, busy: false, message: "",
  actions: {
    setSessionPinned: async (...args) => writes.push(["pin", ...args]),
    setSessionArchived: async (...args) => writes.push(["archive", ...args]),
    deleteSession: async (...args) => writes.push(["delete", ...args]),
  }
};
function Page() {
  const location = useLocation();
  return <div data-page>{location.pathname}</div>;
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
async function scenario() {
  await act(async () => root.render(<PicoTheme><RuntimeContext value={runtime}><MemoryRouter initialEntries={["/task/new"]}><Routes><Route element={<AppShell/>}><Route path="*" element={<Page/>}/></Route></Routes></MemoryRouter></RuntimeContext></PicoTheme>));
  await frame();
  const sidebar = () => document.querySelector(".sidebar").getBoundingClientRect();
  check(Math.abs(sidebar().width - 226) < 1, "Expanded sidebar width: " + sidebar().width);
  check(document.querySelectorAll('[role="main"],main').length === 1, "Only one main landmark");
  check(getComputedStyle(document.querySelector("#astryx-app-shell-main")).overflow === "hidden", "Shell must not create a second scrolling content area");
  check(getComputedStyle(button("搜索任务")).getPropertyValue("-webkit-app-region") === "no-drag", "Search remains clickable in drag region");
  const searchRect = button("搜索任务").getBoundingClientRect();
  check(searchRect.width === 30 && searchRect.height === 30, "Search button keeps 30px geometry");
  check(button("按时间分组").getBoundingClientRect().height === 26, "Grouping control retains 26px height");
  await click("收起侧栏");
  check(Math.abs(sidebar().width - 62) < 1, "Collapsed sidebar width: " + sidebar().width);
  await click("展开侧栏");
  await click("按项目分组");
  check(document.querySelector(".sidebar-project__header"), "Project grouping works");
  await click("按时间分组");
  const running = previewData.sessions[0];
  const idle = previewData.sessions[1];
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
  check(writes.length === 1 && writes[0][0] === "pin" && writes[0][1].sessionId === idle.id, "Menu uses original task identity");
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
  await act(async () => document.querySelector('a[aria-label="设置"]').click());
  check(document.querySelector(".settings-sidebar"), "Settings replaces task sidebar");
  check(Math.abs(sidebar().width - 226) < 1, "Settings sidebar geometry stays unchanged");
  await act(async () => root.unmount());
}
scenario().then(() => fetch("/result", {method:"POST", body:"PASS: desktop shell navigation and search"})).catch(error => fetch("/result", {method:"POST", body:String(error.stack || error)}));
`;
