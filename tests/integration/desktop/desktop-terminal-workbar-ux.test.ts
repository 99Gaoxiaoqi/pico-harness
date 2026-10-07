import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "终端标签绑定独立 Shell，收起复用、关闭隔离且窄窗口布局可用",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SessionWorkbarLayout, isWorkbarPanelActive} from './apps/desktop/src/renderer/workbar/index.ts';
    import {useSessionWorkbar} from './apps/desktop/src/renderer/workbar/useSessionWorkbar.ts';
    import {TerminalPanelController, stopWorkbarTerminalInstance} from './apps/desktop/src/renderer/workbar-panels/TerminalPanelController.tsx';
    import './apps/desktop/src/renderer/workbar/SessionWorkbar.css';
    import './apps/desktop/src/renderer/workbar/workbar-astryx.css';
    import './apps/desktop/src/renderer/workbar-panels/ToolPanels.css';
    import './apps/desktop/src/renderer/workbar-panels/TerminalOutputView.css';
    const assert=(value,message)=>{if(!value)throw new Error(message)};
    const wait=async(condition,message)=>{
      for(let i=0;i<300;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}
      throw new Error(message+': '+document.body.innerText);
    };
    const style=document.createElement('style');
    style.textContent=':root{--surface-raised:#fff;--surface-muted:#f5f5f5;--accent-soft:#eef;--ink:#222;--ink-secondary:#666;--ink-tertiary:#888;--line:#eee;--motion:0s;font-size:12px}html,body{margin:0}#app{height:640px;width:1100px}.session-workbar-layout{height:100%}';
    document.head.append(style);
    const shells=new Map(),listeners=new Set(),stopped=[],inputs=[];
    let created=0,candidate=0,state,delayStop=false,releaseStop;
    const ok=value=>({ok:true,value});
    window.pico={terminalFrames:{subscribe(next){listeners.add(next);return{dispose(){listeners.delete(next)}}},setFocused(){},clipboard(){}},runtime:{
      'runtime.ping':async()=>ok({capabilities:['terminal-stream-v1']}),
      'terminal.list':async()=>ok({terminals:[...shells.values()]}),
      'terminal.create':async()=>{
        const terminal={terminalId:'shell-'+(++created),sessionId:'session',status:'running',sequence:0,capability:'pty',resizeSupported:true};
        shells.set(terminal.terminalId,terminal);
        return ok({terminal,resourceEpoch:'epoch',sequence:0,snapshot:terminal.terminalId+'_READY\\r\\n',truncated:false});
      },
      'terminal.attach':async({terminalId})=>ok({terminal:shells.get(terminalId),resourceEpoch:'epoch',sequence:0,snapshot:terminalId+'_READY\\r\\n',truncated:false}),
      'terminal.detach':async()=>ok({}),
      'terminal.resize':async()=>ok({}),
      'terminal.input':async(params)=>{inputs.push(params);return ok({})},
      'terminal.stop':async({terminalId})=>{stopped.push(terminalId);if(delayStop)await new Promise(resolve=>releaseStop=resolve);shells.get(terminalId).status='exited';return ok({terminal:shells.get(terminalId)})},
    }};
    function App(){
      const [session,setSession]=useState('session');
      const [value,dispatch]=useSessionWorkbar(session);
      state=value;
      window.selectSession=setSession;
      window.openTerminal=mode=>dispatch({type:'openTerminal',mode,tab:{id:'panel-'+(++candidate),kind:'terminal',label:'pico-harness'}});
      return <SessionWorkbarLayout state={value} showRestoreButton={false}
        onAction={action=>{
          if(action.type!=='close'){dispatch(action);return;}
          void stopWorkbarTerminalInstance(window.pico.runtime,{workspacePath:'/workspace',sessionId:session,instanceId:action.tabId}).then(()=>dispatch(action));
        }}
        renderPanel={tab=><TerminalPanelController key={session+tab.id} kind='terminal' workspacePath='/workspace' sessionId={session} instanceId={tab.id} terminalTitle={tab.label} active={isWorkbarPanelActive(value,tab.id,{sessionBound:true})} readOnly={false}/>}
      ><div>Conversation</div></SessionWorkbarLayout>;
    }
    const text=()=>document.querySelector('[data-active="true"] .xterm-accessibility-tree')?.textContent??'';
    const root=createRoot(document.getElementById('app'));
    root.render(<App/>);
    (async()=>{
      await wait(()=>window.openTerminal,'mounted');
      window.openTerminal('open');
      await wait(()=>text().includes('shell-1_READY'),'first Shell ready');
      const first=document.querySelector('.xterm-helper-textarea');
      assert(created===1,'one shell created');
      assert(document.querySelectorAll('[role="tablist"]').length===1,'only one tab layer');
      assert(!document.querySelector('.tool-panel__terminal-meta'),'normal terminal has no diagnostics bar');
      assert(document.querySelector('.session-workbar__toolbar').getBoundingClientRect().height<=50,'single compact toolbar');
      assert(state.tabs[0].label==='pico-harness · 1','readable first title');
      window.openTerminal('toggle');
      await wait(()=>state.collapsed,'terminal collapsed');
      assert(document.querySelector('.xterm-helper-textarea')===first,'collapse keeps terminal view');
      window.openTerminal('toggle');
      await wait(()=>!state.collapsed&&document.activeElement===first,'same terminal restored and focused');
      assert(created===1,'reopen does not create shell');
      window.openTerminal('new');
      await wait(()=>text().includes('shell-2_READY'),'second Shell ready');
      assert(created===2&&state.tabs.length===2,'explicit new creates exactly one shell');
      assert(!text().includes('shell-1_READY'),'second shell only shows its own output');
      assert(document.querySelectorAll('[role="tab"]').length===2,'two shells have two outer tabs');
      const closeSecond=document.querySelector('[aria-label="关闭“pico-harness · 2”"]');
      assert(closeSecond,'second close exists: '+JSON.stringify(state.tabs)+' '+[...document.querySelectorAll('button')].map(button=>button.getAttribute('aria-label')).join('|'));
      closeSecond.click();
      await wait(()=>state.tabs.length===1&&text().includes('shell-1_READY'),'closing second restores first');
      assert(stopped.join(',')==='shell-2','close stops only corresponding shell');
      assert(shells.get('shell-1').status==='running','first Shell remains running');
      assert(document.querySelector('.xterm-helper-textarea')===first,'switch and close retain first xterm instance');
      document.getElementById('app').style.width='380px';
      window.dispatchEvent(new Event('resize'));
      await wait(()=>document.querySelector('.session-workbar-shell').getBoundingClientRect().width<=380,'narrow pane fits available width');
      assert(document.querySelector('[aria-label="新建面板"]').getBoundingClientRect().right<=381,'new control stays visible');
      delayStop=true;
      document.querySelector('[aria-label="关闭“pico-harness · 1”"]').click();
      await wait(()=>releaseStop,'close request pending');
      window.selectSession('other-session');
      await wait(()=>state.tabs.length===0,'another session has independent tabs');
      window.openTerminal('new');
      await wait(()=>text().includes('shell-3_READY'),'other session Shell ready');
      releaseStop();
      await new Promise(resolve=>setTimeout(resolve,30));
      assert(state.tabs.length===1,'late close does not remove other session terminal');
      window.selectSession('session');
      await wait(()=>state.tabs.length===0,'successful close removes original session tab');
      root.unmount();
      await fetch('/result',{method:'POST',body:'PASS'});
    })().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
  `);
    assert.equal(result, "PASS", result);
  },
);
