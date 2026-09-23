import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import { registerDesktopIpcHandlers } from "../../apps/desktop/src/main/ipc.js";
import { createPlatformServices } from "../../apps/desktop/src/platform/index.js";
import { createEmbeddedBrowserAuthority } from "../../apps/desktop/src/main/browser-manager.js";
const root = process.argv[2]!;
const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
app.setPath("userData", join(root, "electron"));
const runtime = new LocalRuntimeClient({
  runtimeHostRootPath: fixture.picoHome,
  candidateLauncher: () => ({
    spawned: Promise.reject(new Error("Only the parent test owns daemon launches")),
  }),
});
let window: BrowserWindow;
let dispose: (() => void) | undefined;
let previousClipboard: string | undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(expression: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await window.webContents.executeJavaScript(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('无步骤记录')&&b.getAttribute('aria-expanded')==='false');if(b)b.click()})()`,
    );
    if (await window.webContents.executeJavaScript(expression)) return;
    await pause(30);
  }
  throw new Error(
    `Timed out: ${expression}\n${await window.webContents.executeJavaScript("document.body.innerText")}`,
  );
}
const invoke = (method: string, params: unknown) =>
  window.webContents.executeJavaScript(
    `window.invoke(${JSON.stringify(method)},${JSON.stringify(params)})`,
  );
const click = (text: string) =>
  window.webContents.executeJavaScript(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click()})()`,
  );
async function main() {
  await app.whenReady();
  previousClipboard = clipboard.readText();
  window = new BrowserWindow({
    show: true,
    width: 1000,
    height: 800,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dispose = registerDesktopIpcHandlers({
    ipcMain,
    getTrustedWebContents: () => window.webContents,
    runtime,
    platform: createPlatformServices(),
    lifecycle: {
      getBackgroundMode: () => false,
      async setBackgroundMode() {},
      requestQuit() {},
      isQuitting: () => false,
    },
    browser: createEmbeddedBrowserAuthority({
      getWindow: () => window,
      onState() {},
      userDataPath: join(root, "browser"),
    }),
    submitTerminalCreate: (send) => send(),
  });
  await window.loadFile(join(root, "index.html"));
  await window.webContents.executeJavaScript(
    `window.scope=${JSON.stringify(fixture.scope)};window.mount(window.scope)`,
  );
  await wait("document.querySelectorAll('[data-run-id]').length===16");
  await click("加载较早记录");
  await wait("document.querySelectorAll('[data-run-id]').length===32");
  await click("加载较早记录");
  await wait("document.querySelectorAll('[data-run-id]').length===48");
  while (
    await window.webContents.executeJavaScript(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='加载较早记录')",
    )
  ) {
    const count = await window.webContents.executeJavaScript(
      "document.querySelectorAll('[data-run-id]').length",
    );
    await click("加载较早记录");
    await wait(`document.querySelectorAll('[data-run-id]').length>${count}`);
  }
  assert.equal(
    await window.webContents.executeJavaScript("document.querySelectorAll('[data-run-id]').length"),
    fixture.seedRuns,
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('button[data-step-id]').click()",
  );
  await wait("!!document.querySelector('[aria-label=\"执行步骤详情\"]')");
  await window.webContents.executeJavaScript(
    "[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('请求与执行明细'))?.click()",
  );
  await click("复制模型标识");
  await wait(
    "document.querySelector('[aria-label=\"复制模型标识\"]').parentElement.textContent.includes('已复制')",
  );
  assert.deepEqual(JSON.parse(clipboard.readText()), {
    providerId: "openai",
    modelId: "trace-model",
  });
  const start = Date.now();
  await invoke("session.send", {
    ...fixture.scope,
    input: { kind: "text", text: "live run" },
    idempotencyKey: "electron-live",
  });
  await wait("document.querySelectorAll('[data-run-id]').length===68", 2000);
  const liveRefreshMs = Date.now() - start;
  assert.ok(liveRefreshMs < 2000);
  await wait(
    "[...document.querySelectorAll('[data-run-id]')].every(n=>n.dataset.status!=='running')",
  );
  // Each production run has one model step. Match visible titles against the real paged query.
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await invoke("session.execution.query", {
      ...fixture.scope,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.runs.map((run: { runId: string }) => run.runId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 68);
  assert.equal(new Set(ids).size, 68);
  await click("隐藏较早记录");
  await wait(
    "document.querySelectorAll('[data-run-id]').length===16 && !document.querySelector('[aria-label=\"执行步骤详情\"]')",
  );
  await window.webContents.executeJavaScript("window.setActive(false)");
  await pause(150);
  await window.webContents.executeJavaScript("window.setActive(true)");
  await wait("document.querySelectorAll('[data-run-id]').length===16");
  const other = await invoke("session.create", { workspacePath: fixture.scope.workspacePath });
  await window.webContents.executeJavaScript(
    `window.mount(${JSON.stringify({ workspacePath: fixture.scope.workspacePath, sessionId: other.session.sessionId })})`,
  );
  await wait("document.querySelectorAll('[data-run-id]').length===0");
  await window.webContents.executeJavaScript(`window.mount(${JSON.stringify(fixture.scope)})`);
  await wait("document.querySelectorAll('[data-run-id]').length===16");
  const fault = async (name: string) =>
    assert.equal((await fetch(fixture.controlURL.replace("/restart", `/${name}`))).status, 200);
  const refresh = () =>
    window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"刷新追踪\"]').click()",
    );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-tab=overview]').click()",
  );
  await wait(
    "document.querySelector('[data-tab=overview]').getAttribute('aria-selected')==='true'",
  );
  try {
    await fault("corrupt");
    await refresh();
    await wait(
      "!!document.querySelector('[role=alert]') && !!document.querySelector('[aria-label=\"会话用量\"]') && !document.body.innerText.includes('会话用量读取失败')",
    );
  } finally {
    await fault("restore");
  }
  await refresh();
  await wait("!document.querySelector('[role=alert]')");
  try {
    await fault("fault");
    await refresh();
    await wait(
      "document.body.innerText.includes('会话用量读取失败') && document.querySelectorAll('[data-run-id]').length===16",
    );
  } finally {
    await fault("restore");
  }
  await refresh();
  await wait(
    "!document.body.innerText.includes('会话用量读取失败') && !document.querySelector('[role=alert]')",
  );
  await window.webContents.executeJavaScript(
    "window.resourceFrames=0;window.pico.sessionFrames.subscribe(f=>{if(f.type==='subscription.resource_changed')window.resourceFrames++});void 0",
  );
  assert.equal((await fetch(fixture.controlURL)).status, 200);
  await pause(600);
  await invoke("session.send", {
    ...fixture.scope,
    input: { kind: "text", text: "after reconnect" },
    idempotencyKey: "electron-reconnect",
  });
  await wait(
    "window.resourceFrames>0 && document.querySelector('[aria-label=\"会话用量\"]').innerText.includes('350')",
    10000,
  );
  console.log(
    "EXECUTION_TRACE_ELECTRON_OK",
    JSON.stringify({
      liveRefreshMs,
      runs: ids.length,
      clipboard: clipboard.readText(),
      versions: process.versions,
    }),
  );
}
void main()
  .then(async () => {
    if (previousClipboard !== undefined) clipboard.writeText(previousClipboard);
    dispose?.();
    runtime.close();
    window?.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    if (previousClipboard !== undefined) clipboard.writeText(previousClipboard);
    dispose?.();
    runtime.close();
    window?.destroy();
    app.exit(1);
  });
