import { app, BrowserWindow, type KeyboardInputEvent } from "electron";
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
async function key(keyCode: string, modifiers: NonNullable<KeyboardInputEvent["modifiers"]> = []) {
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

  await window.webContents.insertText("abc");
  await pause();
  await js(
    `document.querySelector('${editor}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:(()=>{const d=new DataTransfer();d.setData('text/plain','PASTE');return d})()}))`,
  );
  await wait("window.draft==='abcPASTE'");
  window.webContents.undo();
  await wait("window.draft==='abc'");
  window.webContents.redo();
  await wait("window.draft==='abcPASTE'");
  await js(
    `(()=>{const e=document.querySelector('${editor}');const s=getSelection();const r=document.createRange();r.selectNodeContents(e);s.removeAllRanges();s.addRange(r)})()`,
  );
  await window.webContents.insertText("替换选区");
  await wait("window.draft==='替换选区'");
  await js("window.setDraft('')");
  await pause();
  // Include the native char event: keyDown alone does not edit contenteditable.
  const lineBreak = async () => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers: ["shift"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["shift"] });
    await pause();
  };
  await window.webContents.insertText("abc");
  await lineBreak();
  await wait("window.draft==='abc\\n'");
  await lineBreak();
  await wait("window.draft==='abc\\n\\n'");
  await js("window.setDraft('恢复\\n\\n')");
  await pause();
  await window.webContents.insertText("末尾");
  await wait("window.draft==='恢复\\n\\n末尾'");
  await js("window.setDraft('')");
  await pause();
  await lineBreak();
  await wait("window.draft==='\\n'");
  await js("window.setDraft('')");
  await pause();
  await js(
    `document.querySelector('${editor}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:(()=>{const d=new DataTransfer();d.setData('text/plain','X\\nY\\n\\n');return d})()}))`,
  );
  await wait("window.draft==='X\\nY\\n\\n'");
  await js("window.setDraft('')");
  await pause();
  const pasted = "长文本".repeat(100);
  await js(
    `document.querySelector('${editor}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(pasted)});return d})()}))`,
  );
  await wait(`window.draft===${JSON.stringify(pasted)}`);
  assert.equal(await js(`document.querySelector('${editor} [data-astryx-token]')===null`), true);
  await js("window.setDraft('')");
  await pause();
  await js(
    `document.querySelector('${editor}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:(()=>{const d=new DataTransfer();d.setData('text/plain','文件旁的文本');d.items.add(new File(['image'],'example.png',{type:'image/png'}));return d})()}))`,
  );
  await wait("window.draft==='文件旁的文本'");
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
  assert.deepEqual(
    await js("window.disabledScrollWrites"),
    [],
    "disabled Astryx scrolling never writes on mount, append or resize",
  );
  await js("window.setStatus('running')");
  for (const width of [960, 800]) {
    window.setContentSize(width, 720);
    await pause(100);
    const geometry = await js(`(()=>{
      const form=document.querySelector('.conversation-composer');
      const controls=form.querySelector('.conversation-composer__controls');
      const behavior=form.querySelector('.conversation-behavior');
      const pause=form.querySelector('[aria-label="暂停运行"]');
      const send=form.querySelector('.conversation-send-button');
      const rect=e=>e.getBoundingClientRect().toJSON();
      return {form:rect(form),controls:rect(controls),behavior:rect(behavior),pause:rect(pause),send:rect(send),fontSize:parseFloat(getComputedStyle(behavior).fontSize),overflow:form.scrollWidth>form.clientWidth};
    })()`);
    // Running controls share the footer row while they fit, then wrap below it.
    assert.ok(
      geometry.behavior.left >= geometry.controls.right ||
        geometry.behavior.top >= geometry.controls.bottom,
      JSON.stringify(geometry),
    );
    assert.ok(
      Math.abs(
        geometry.behavior.top +
          geometry.behavior.height / 2 -
          geometry.send.top -
          geometry.send.height / 2,
      ) < 2,
      JSON.stringify(geometry),
    );
    assert.ok(
      Math.abs(
        geometry.pause.top +
          geometry.pause.height / 2 -
          geometry.send.top -
          geometry.send.height / 2,
      ) < 2,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.fontSize <= 12 && !geometry.overflow, JSON.stringify(geometry));
  }
  await js("window.mountRuntimeComposer()");
  await pause();
  await js(`document.querySelector('${editor}').focus()`);
  await window.webContents.insertText("已确认发送");
  await key("Enter");
  assert.equal(await js("window.draft"), "已确认发送", "unacknowledged send keeps draft");
  await wait("typeof window.finishSend==='function'");
  assert.notEqual(
    await js("window.refreshStarted"),
    true,
    "first send must precede workspace hydration",
  );
  await js("window.finishSend(true)");
  await wait("window.refreshStarted===true");
  await pause();
  assert.equal(
    await js(
      "Boolean(document.querySelector('.workspace-picker,.workspace-route-loading,.trust-screen'))",
    ),
    false,
    "admitted first send must stay in the conversation while workspace hydration is pending",
  );
  await wait(`window.draft==='' && document.querySelector('${editor}').textContent===''`);
  await js("window.failRefresh()");
  await wait("window.runtimeMessage?.includes('刷新暂不可用')");
  assert.equal(await js("window.draft"), "", "refresh failure cannot restore an accepted message");
  await js(`document.querySelector('${editor}').focus()`);
  await window.webContents.insertText("失败保留");
  await key("Enter");
  await js("window.finishSend(false)");
  await wait("window.runtimeMessage?.includes('发送被拒绝')");
  assert.equal(await js("window.draft"), "失败保留");
  assert.equal(await js(`document.querySelector('${editor}').textContent`), "失败保留");
  console.log("ASTRYX_CHAT_ELECTRON_OK");
}
run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
