import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
const root = process.argv[2]!;
app.setPath("userData", join(root, "electron"));
let window: BrowserWindow;
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (code: string) => window.webContents.executeJavaScript(code);
async function wait(code: string) {
  for (let i = 0; i < 100; i++) {
    if (await js(code)) return;
    await pause(20);
  }
  throw new Error(`Timeout: ${code}`);
}
async function fill(name: string, text: string) {
  await js(`(()=>{const e=document.querySelector('[name="${name}"]');e.focus();e.select()})()`);
  await window.webContents.insertText(text);
  await pause();
}
async function enter() {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await pause();
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({
    show: true,
    width: 440,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(join(root, "index.html"));
  await wait(`document.querySelector('[name="workbar-task-title"]')!==null`);
  await fill("workbar-task-title", "新增工作项");
  await enter();
  assert.deepEqual(await js("window.calls[0]"), [
    "create",
    { title: "新增工作项", expectedLedgerRevision: 7 },
  ]);
  await js(`document.querySelector('[role="combobox"]').click()`);
  await wait(`document.querySelector('[role="option"]')!==null`);
  await js(
    `[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('已完成')).click()`,
  );
  assert.deepEqual(await js("window.calls[1]"), [
    "update",
    { taskId: "task", status: "completed", expectedTaskRevision: 3, expectedLedgerRevision: 7 },
  ]);
  await js('window.mode("browser")');
  await wait(
    `document.querySelector('[name="workbar-browser-address"]')?.value==='https://example.com'`,
  );
  assert.equal(
    await js(
      `document.querySelector('[aria-label="后退"]').matches(':disabled,[aria-disabled="true"]')`,
    ),
    true,
  );
  await fill("workbar-browser-address", "https://example.org/path");
  await enter();
  assert.deepEqual(await js("window.calls.at(-1)"), ["navigate", "s", "https://example.org/path"]);
  assert.ok(
    await js(
      `document.querySelector('.workbar-browser__toolbar').getBoundingClientRect().height<=48`,
    ),
  );
  await js('window.mode("terminal")');
  await wait(`document.querySelector('[name="workbar-terminal-command"]')!==null`);
  await fill("workbar-terminal-command", "printf hello");
  await enter();
  assert.deepEqual(await js("window.calls.at(-1)"), ["input", "t", "printf hello"]);
  assert.equal(await js(`document.querySelector('[name="workbar-terminal-command"]').value`), "");
  await js('window.mode("files")');
  await wait(`document.querySelector('[aria-label="生成文件操作"]')!==null`);
  await js(`document.querySelector('[aria-label="生成文件操作"]').click()`);
  await wait(`document.querySelector('[role="menuitem"]')!==null`);
  assert.equal(await js(`document.querySelectorAll('[role="menuitem"]').length`), 3);
  await js(
    `[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('另存生成文件')).click()`,
  );
  assert.deepEqual(await js("window.calls.at(-1)"), ["save", "a"]);
  assert.ok(
    await js(`document.querySelector('.pico-artifact-menu').getBoundingClientRect().width<=32`),
  );
  console.log("ASTRYX_WORKBAR_ELECTRON_OK");
}
run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
