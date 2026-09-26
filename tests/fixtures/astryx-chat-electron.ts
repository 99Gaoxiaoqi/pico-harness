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
const editor = ".conversation-composer [contenteditable]";
const scroller = ".pico-chat-layout";
async function key(keyCode: string, modifiers: string[] = []) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await pause();
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({
    show: true,
    width: 1100,
    height: 720,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(join(root, "index.html"));
  await wait(`document.querySelector('${editor}')?.textContent==='第一行\\n第二行'`);
  assert.equal(
    await js(`document.querySelector('${scroller}').hasAttribute('data-astryx-chat-following')`),
    false,
  );
  await js("window.focusEditor()");
  assert.equal(await js(`document.activeElement===document.querySelector('${editor}')`), true);
  await key("Enter");
  assert.deepEqual(await js("window.sent"), ["第一行\n第二行"]);
  assert.equal(
    await js("window.draft"),
    "第一行\n第二行",
    "failed/unacknowledged sends retain the draft",
  );
  assert.equal(await js(`document.querySelector('${editor}').textContent`), "第一行\n第二行");
  await js(
    `document.querySelector('${editor}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}))`,
  );
  await key("Enter", ["shift"]);
  assert.equal(await js("window.sent.length"), 1, "IME and Shift+Enter do not submit");
  await js("window.clearOnSend=true");
  await key("Enter");
  await wait(`window.draft==='' && document.querySelector('${editor}').textContent===''`);
  await key("Up");
  assert.equal(await js("window.draft"), "", "history recall stays disabled");

  const pasted = "长文本".repeat(100);
  await js(
    `document.querySelector('${editor}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(pasted)});return d})()}))`,
  );
  await wait(`window.draft===${JSON.stringify(pasted)}`);
  assert.equal(await js(`document.querySelector('${editor} [data-astryx-token]')===null`), true);
  await js(`window.setDraft('高输入\\n'.repeat(30))`);
  await wait(
    `document.querySelector('${editor}').clientHeight<=202 && document.querySelector('${editor}').scrollHeight>200`,
  );
  await js('window.setDraft("")');
  await pause();

  // The same scroll container is governed exclusively by Pico's 96px rule.
  await js(`(()=>{const s=document.querySelector('${scroller}');s.scrollTop=s.scrollHeight})()`);
  await pause();
  await js("window.append()");
  await pause();
  assert.ok(
    await js(
      `(()=>{const s=document.querySelector('${scroller}');return s.scrollHeight-s.scrollTop-s.clientHeight<=1})()`,
    ),
  );
  const before = await js(
    `(()=>{const s=document.querySelector('${scroller}');s.scrollTop=s.scrollHeight-s.clientHeight-97;s.dispatchEvent(new Event('scroll'));return s.scrollTop})()`,
  );
  await js("window.append()");
  await pause(100);
  assert.equal(
    await js(`document.querySelector('${scroller}').scrollTop`),
    before,
    "reading history is not pulled down",
  );
  await wait(`document.querySelector('[aria-label="回到最新消息"]')!==null`);
  await js(`document.querySelector('[aria-label="回到最新消息"]').click()`);
  await pause();
  await js(
    `(()=>{const s=document.querySelector('${scroller}');s.scrollTop=s.scrollHeight-s.clientHeight-96;s.dispatchEvent(new Event('scroll'))})()`,
  );
  await js("window.append()");
  await pause();
  assert.ok(
    await js(
      `(()=>{const s=document.querySelector('${scroller}');return s.scrollHeight-s.scrollTop-s.clientHeight<=1})()`,
    ),
  );

  await js(`document.querySelector('[aria-label="添加上下文与模式"]').click()`);
  await wait(`document.querySelector('[role="menuitemcheckbox"]')!==null`);
  await js(
    `[...document.querySelectorAll('[role="menuitemcheckbox"]')].find(e=>e.textContent.includes('Plan')).click()`,
  );
  await wait(`document.querySelector('[data-mode="plan"]')!==null`);
  await key("Escape");
  await js(`document.querySelector('.side-chat__composer [contenteditable]').focus()`);
  await key("Enter");
  assert.deepEqual(await js("window.sideSent"), ["侧聊草稿"]);
  assert.equal(await js("window.sideDraft"), "侧聊草稿");
  window.setContentSize(800, 600);
  await pause(100);
  assert.ok(
    await js(
      `(()=>{const s=document.querySelector('${scroller}'),c=document.querySelector('.conversation-composer');return c.getBoundingClientRect().bottom<=s.getBoundingClientRect().bottom+1})()`,
    ),
  );
  console.log("ASTRYX_CHAT_ELECTRON_OK");
}
run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
