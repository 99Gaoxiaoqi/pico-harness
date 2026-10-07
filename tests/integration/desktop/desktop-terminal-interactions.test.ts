import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { createDesktopBridge } from "../../../apps/desktop/src/preload/bridge.js";
import { DESKTOP_IPC_CHANNELS } from "../../../apps/desktop/src/preload/contract.js";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("桌面终端直接输入、长粘贴和推送水位随主题及可见性保持一致", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TerminalPanelController } from './apps/desktop/src/renderer/workbar-panels/TerminalPanelController.tsx';
    import { readTerminalTheme } from './apps/desktop/src/renderer/workbar-panels/terminal-theme.ts';
    import './apps/desktop/src/renderer/workbar-panels/TerminalOutputView.css';
    import './apps/desktop/src/renderer/workbar-panels/ToolPanels.css';
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const wait = async (condition, message) => {
      for (let count = 0; count < 300; count++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(message + ': ' + document.body.innerText);
    };
    const style = document.createElement('style');
    style.textContent = ':root { --surface-raised: #fff; --ink: #262626; --ink-secondary:#606068; --ink-tertiary:#7c7c85; --line:#eee; --line-strong:#ccc; --surface-muted:#f5f5f5; --surface-strong:#ebebeb; --accent:#467bbd; --accent-soft:#eaf2fc; --danger:#a34235; --warning:#9b661d; --color-text-red:light-dark(#76000c,#ffaea7); --color-text-green:#00490b; --color-text-yellow:#4b3900; --color-text-blue:#003978; --color-text-purple:#5c0e6c; --color-text-cyan:#004351; color-scheme:light; } #app { height:420px; width:700px; } .tool-panel { height:100%; }';
    document.head.append(style);
    Object.defineProperty(navigator,'platform',{configurable:true,value:'Win32'});
    const root = createRoot(document.getElementById('app'));
    let listener, disconnected, disposed = false, ownStream;
    let sequence = 2, snapshot = '\\x1b[?2004hSNAPSHOT\\r\\nBEFORE_REPLY\\r\\n';
    const terminal = () => ({terminalId:'pty',sessionId:'session',title:'Shell',status:'running',sequence,capability:'pty',resizeSupported:true,cwd:'/workspace'});
    const frame = (seq, data) => ({type:'terminal.event',terminalId:'pty',sessionId:'session',resourceEpoch:'epoch',streamId:ownStream,sequence:seq,at:1791331200000,kind:'output',data});
    const requests = [], inputs = [], focusEvents = [], clipboardActions = [];
    let inFlight = 0, maximumFlight = 0, failInput = false;
    window.pico = {
      terminalFrames: { setFocused(value){focusEvents.push(value);}, clipboard(action){clipboardActions.push(action);if(action==='paste')paste('NATIVE_PASTE');}, subscribe(next, close) { listener=next; disconnected=close; return {dispose(){disposed=true;}}; } },
      runtime: {
        'runtime.ping': async () => ({ok:true,value:{capabilities:['terminal-stream-v1']}}),
        'terminal.list': async () => ({ok:true,value:{terminals:[]}}),
        'terminal.create': async (params) => {
          ownStream=params.streamId;
          assert(typeof ownStream==='string','create stream identifies view');
          assert(listener, 'subscription precedes create');
          listener(frame(1,'SNAPSHOT\\r\\n'));
          listener(frame(2,'BEFORE_REPLY\\r\\n'));
          return {ok:true,value:{terminal:terminal(),resourceEpoch:'epoch',sequence:1,snapshot:'\\x1b[?2004hSNAPSHOT\\r\\n',truncated:false}};
        },
        'terminal.attach': async (params) => {
          assert(params.streamId===ownStream,'attach retains view stream');
          requests.push('attach');
          const value={terminal:terminal(),resourceEpoch:'epoch',sequence,snapshot,truncated:false};
          await new Promise(resolve=>setTimeout(resolve,40));
          return {ok:true,value};
        },
        'terminal.input': async (value) => {
          inputs.push(value.data);
          maximumFlight=Math.max(maximumFlight,++inFlight);
          await new Promise(resolve=>setTimeout(resolve,3));
          inFlight--;
          return failInput ? {ok:false,error:{code:'DESKTOP_IPC_FAILED',message:'outcome unknown',retryable:false,outcome:'unknown'}} : {ok:true,value:{}};
        },
        'terminal.resize': async () => ({ok:true,value:{}}),
        'terminal.detach': async (params) => { assert(params.streamId===ownStream,'detach only releases own stream'); requests.push('detach'); return {ok:true,value:{}}; },
      },
    };
    let active=true, readOnly=false;
    const render = () => root.render(<div style={{height:'100%',display:active?'block':'none'}}><TerminalPanelController workspacePath='/workspace' sessionId='session' instanceId='terminal-test' active={active} readOnly={readOnly}/></div>);
    const text = () => document.querySelector('.xterm-accessibility-tree')?.textContent ?? '';
    const key = (name, options={}) => {
      const textarea=document.querySelector('.xterm-helper-textarea');
      const keyCode = ({ArrowUp:38,Backspace:8,Enter:13})[name] ?? name.toUpperCase().charCodeAt(0);
      textarea.dispatchEvent(new KeyboardEvent('keydown',{key:name,keyCode,which:keyCode,bubbles:true,cancelable:true,...options}));
      textarea.dispatchEvent(new KeyboardEvent('keyup',{key:name,keyCode,which:keyCode,bubbles:true,cancelable:true,...options}));
    };
    const paste = data => {
      const clipboardData=new DataTransfer(); clipboardData.setData('text/plain',data);
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
    };
    const emit = (data, gap=1) => { sequence+=gap; snapshot+=data; listener(frame(sequence,data)); };
    (async()=>{
      render();
      await wait(()=>text().includes('BEFORE_REPLY'),'buffered frame shown');
      assert(text().split('SNAPSHOT').length===2,'snapshot frame duplicate filtered');
      listener({...frame(sequence+1,'FOREIGN_STREAM'),streamId:'other-view'});
      await new Promise(resolve=>setTimeout(resolve,20));
      assert(!text().includes('FOREIGN_STREAM'),'other view stream is ignored');
      const textarea=document.querySelector('.xterm-helper-textarea');
      assert(document.activeElement===textarea,'focus follows fit');
      assert(!document.querySelector('input[name="workbar-terminal-command"]'),'extra input removed');
      assert(getComputedStyle(document.querySelector('.tool-panel--terminal')).backgroundColor==='rgb(255, 255, 255)','panel inherits app background');
      assert(readTerminalTheme(document.querySelector('.tool-panel--terminal')).red==='rgba(118, 0, 12, 1)','ANSI resolves computed light-dark color');
      key('a'); key('ArrowUp'); key('Backspace'); key('Enter'); key('c',{ctrlKey:true});
      await wait(()=>inputs.length===5 && inFlight===0,'raw keyboard sent '+JSON.stringify(inputs));
      assert(inputs.join('')==='a\\x1b[A\\x7f\\r\\x03','keyboard preserved without appended CR: '+JSON.stringify(inputs));
      key('v',{ctrlKey:true,shiftKey:true});
      await wait(()=>inputs.length===6 && inFlight===0,'native clipboard paste sent');
      assert(clipboardActions.join(',')==='paste' && inputs[5]==='\\x1b[200~NATIVE_PASTE\\x1b[201~','Windows clipboard shortcut uses native paste');
      const beforePaste=inputs.length;
      const long='🦊'.repeat(18000);
      paste(long);
      await wait(()=>inputs.slice(beforePaste).join('').endsWith('\\x1b[201~') && inFlight===0,'long paste completed');
      assert(inputs.slice(beforePaste).join('')==='\\x1b[200~'+long+'\\x1b[201~','long paste preserves bracketed raw text');
      assert(inputs.slice(beforePaste).every(data=>new TextEncoder().encode(data).byteLength<=16384),'paste split into UTF8 bounded chunks');
      assert(maximumFlight===1,'input serialized');
      document.documentElement.style.setProperty('--surface-raised','#f3f4f5');
      document.documentElement.style.setProperty('--ink','#17324d');
      await wait(()=>getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor==='rgb(243, 244, 245)','theme updates xterm options');
      assert(document.querySelector('.xterm-helper-textarea')===textarea && text().includes('BEFORE_REPLY'),'theme preserves terminal instance and output');
      const other=document.createElement('input');document.body.append(other);other.focus();
      active=false;render();await new Promise(resolve=>setTimeout(resolve,40));
      const stopped=inputs.length; key('h');paste('hidden');
      assert(document.activeElement===other,'hidden terminal does not steal focus');
      assert(focusEvents.at(-1)===false,'native terminal menu scope released on blur');
      emit('PUSHED_WHILE_HIDDEN\\r\\n');
      await new Promise(resolve=>setTimeout(resolve,40));
      assert(inputs.length===stopped,'hidden terminal blocks input');
      active=true;render();
      await wait(()=>requests.length===1 && document.activeElement===textarea,'restored terminal reattaches and focuses');
      readOnly=true;render();await new Promise(resolve=>setTimeout(resolve,40));key('r');paste('readonly');
      assert(inputs.length===stopped,'readonly blocks input');
      readOnly=false;render();await new Promise(resolve=>setTimeout(resolve,40));
      emit('GAP_RECOVERED\\r\\n',2);
      await wait(()=>requests.length===2 && text().includes('GAP_RECOVERED'),'sequence gap recovers snapshot');
      disconnected(); key('d');
      await wait(()=>requests.length===3,'disconnect reconnects through attach');
      await new Promise(resolve=>setTimeout(resolve,60));
      assert(inputs.length===stopped,'disconnect blocks input before snapshot returns');
      failInput=true; key('u');key('z');
      await wait(()=>document.body.innerText.includes('输入未重发'),'unknown result reported');
      assert(inputs.length===stopped+1,'unknown result and queued data never replay');
      failInput=false;
      const connect=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('连接'));
      assert(connect,'unknown result requires explicit reconnection');connect.click();
      await wait(()=>requests.length===4 && ![...document.querySelectorAll('button')].some(button=>button.textContent.includes('连接')),'manual reconnect completes');
      listener({type:'terminal.event',terminalId:'pty',sessionId:'session',resourceEpoch:'epoch',streamId:ownStream,sequence:++sequence,at:1791331200000,kind:'status',status:'exited',exitCode:0});
      await wait(()=>document.body.innerText.includes('已退出'),'status frame consumes sequence');
      key('x'); assert(inputs.length===stopped+1,'exited terminal blocks input');
      root.unmount();await new Promise(resolve=>setTimeout(resolve,10));
      assert(disposed && requests.includes('detach'),'unmount releases listener and attachment');
      await fetch('/result',{method:'POST',body:'PASS'});
    })().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
  `);
  assert.equal(result, "PASS", result);
});

test("桌面终端对旧 Host 明确提示更新并阻止创建", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TerminalPanelController } from './apps/desktop/src/renderer/workbar-panels/TerminalPanelController.tsx';
    let mutations=0;
    window.pico={
      terminalFrames:{subscribe(){return{dispose(){}}},setFocused(){},clipboard(){}},
      runtime:{
        'runtime.ping':async()=>({ok:true,value:{capabilities:[]}}),
        'terminal.create':async()=>{mutations++;throw new Error('unexpected create');},
        'terminal.list':async()=>{throw new Error('unexpected list');},
      },
    };
    const root=createRoot(document.getElementById('app'));
    root.render(<TerminalPanelController workspacePath='/workspace' sessionId='session' instanceId='old-host' active={true} readOnly={false}/>);
    (async()=>{
      for(let i=0;i<100&&!document.querySelector('[role="alert"]');i++)await new Promise(resolve=>setTimeout(resolve,10));
      if(!document.body.textContent.includes('请更新 Pico'))throw new Error(document.body.textContent);
      document.querySelector('button[aria-label="新建终端"]').click();
      await new Promise(resolve=>setTimeout(resolve,30));
      if(mutations)throw new Error('old host received create');
      root.unmount();
      await fetch('/result',{method:'POST',body:'PASS'});
    })().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
  `);
  assert.equal(result, "PASS", result);
});

test("桌面 preload 校验终端推送并释放原生键盘及事件监听", () => {
  const ipc = new EventEmitter();
  const sent: unknown[][] = [];
  Object.assign(ipc, {
    send: (...args: unknown[]) => sent.push(args),
    invoke: async () => undefined,
  });
  const bridge = createDesktopBridge(ipc as unknown as IpcRenderer);
  const frames: unknown[] = [];
  let disconnected = 0;
  const subscription = bridge.terminalFrames.subscribe(
    (frame) => frames.push(frame),
    () => disconnected++,
  );
  const frame = {
    type: "terminal.event",
    terminalId: "pty",
    sessionId: "session",
    resourceEpoch: "epoch",
    sequence: 1,
    at: 1,
    kind: "output",
    data: "raw",
  };
  ipc.emit(DESKTOP_IPC_CHANNELS.terminalFrame, {}, { ...frame, at: "invalid" });
  ipc.emit(DESKTOP_IPC_CHANNELS.terminalFrame, {}, frame);
  ipc.emit(DESKTOP_IPC_CHANNELS.terminalDisconnected, {});
  bridge.terminalFrames.setFocused(true);
  bridge.terminalFrames.clipboard("paste");
  bridge.terminalFrames.clipboard("quit" as "copy");
  bridge.terminalFrames.setFocused(false);
  assert.deepEqual(frames, [frame]);
  assert.equal(disconnected, 1);
  assert.deepEqual(sent, [
    [DESKTOP_IPC_CHANNELS.terminalKeyboardFocus, true],
    [DESKTOP_IPC_CHANNELS.terminalClipboard, "paste"],
    [DESKTOP_IPC_CHANNELS.terminalKeyboardFocus, false],
  ]);
  subscription.dispose();
  assert.equal(ipc.listenerCount(DESKTOP_IPC_CHANNELS.terminalFrame), 0);
  assert.equal(ipc.listenerCount(DESKTOP_IPC_CHANNELS.terminalDisconnected), 0);
});

test("桌面终端释放视图关闭后迟到的 attach 响应", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TerminalPanelController } from './apps/desktop/src/renderer/workbar-panels/TerminalPanelController.tsx';
    import './apps/desktop/src/renderer/workbar-panels/TerminalOutputView.css';
    let complete, attachParams;
    const detached=[];
    const terminal={terminalId:'pending',sessionId:'session',title:'Shell',status:'running',sequence:1,capability:'pty',resizeSupported:true};
    window.pico={
      terminalFrames:{subscribe(){return{dispose(){}}},setFocused(){},clipboard(){}},
      runtime:{
        'runtime.ping':async()=>({ok:true,value:{capabilities:['terminal-stream-v1']}}),
        'terminal.list':async()=>({ok:true,value:{terminals:[terminal]}}),
        'terminal.attach':params=>{attachParams=params;return new Promise(resolve=>{complete=resolve;});},
        'terminal.detach':async params=>{detached.push(params);return{ok:true,value:{}};},
      },
    };
    const root=createRoot(document.getElementById('app'));
    root.render(<TerminalPanelController workspacePath='/workspace' sessionId='session' instanceId='pending-attach' active={true} readOnly={true}/>);
    (async()=>{
      for(let i=0;i<100&&!complete;i++)await new Promise(resolve=>setTimeout(resolve,10));
      if(!complete)throw new Error('attach not started');
      root.unmount();
      complete({ok:true,value:{terminal,resourceEpoch:'late-epoch',sequence:1,snapshot:'prompt',truncated:false}});
      for(let i=0;i<100&&!detached.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
      if(detached.length!==1||detached[0].streamId!==attachParams.streamId||detached[0].resourceEpoch!=='late-epoch')throw new Error('late attach was not released: '+JSON.stringify(detached));
      await fetch('/result',{method:'POST',body:'PASS'});
    })().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
  `);
  assert.equal(result, "PASS", result);
});
