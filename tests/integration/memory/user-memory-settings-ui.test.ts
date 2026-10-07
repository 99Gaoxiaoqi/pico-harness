import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "../desktop/renderer-browser-fixture.js";

test(
  "记忆设置共享版本跨项目保留，旧响应不回退且通知与焦点刷新同步页面",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {useRuntimeStore} from "./apps/desktop/src/renderer/runtime.ts";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {UserMemorySettingsPage} from "./apps/desktop/src/renderer/pages/UserMemorySettingsPage.tsx";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(condition,message)=>{if(!condition)throw Error(message);};
const success=value=>({ok:true,value});
let settings={enabled:true,autoExtract:true,recallEnabled:true,version:1};
let store, holdGlobal=false, holdWorkspace=false, releaseGlobal, releaseWorkspace;
let lists=0, settingsReads=0;
const listeners=new Map();
window.pico={
  runtime:new Proxy({},{get:(_target,method)=>async params=>{
    if(method==="runtime.ping")return success({picoHome:"/state/settings",capabilities:["session-conversation-v1","workspace-memory-v1"]});
    if(method==="workspace.list")return success({workspaces:[]});
    if(method==="workspace.status")return success({mode:"folder",temporary:false});
    if(method==="workspace.trustStatus")return success({trusted:true});
    if(method==="session.list")return success({sessions:[]});
    if(method==="runs.list")return success({runs:[]});
    if(method==="events.replay")return success({events:[],hasMore:false});
    if(method==="memory.list"){lists++;return success({items:[]});}
    if(method==="memory.settings.get"){
      settingsReads++;
      const captured={...settings};
      if(!params.workspacePath&&holdGlobal){holdGlobal=false;return new Promise(resolve=>{releaseGlobal=()=>resolve(success({settings:captured}));});}
      if(params.workspacePath&&holdWorkspace){holdWorkspace=false;return new Promise(resolve=>{releaseWorkspace=()=>resolve(success({settings:captured}));});}
      return success({settings:captured});
    }
    if(method==="memory.settings.update"){
      if(params.expectedVersion!==settings.version)return {ok:false,error:{code:"CONFLICT",message:"changed",retryable:false}};
      for(const key of ["enabled","autoExtract","recallEnabled"])if(params[key]!==undefined)settings[key]=params[key];
      settings={...settings,version:settings.version+1};
      return success({settings:{...settings}});
    }
    return {ok:false,error:{code:"METHOD_NOT_FOUND",message:method+" unavailable",retryable:false}};
  }}),
  platform:{getLaunchAtLogin:async()=>success(false)},
  lifecycle:{getBackgroundMode:async()=>success(false)},
  onUnavailable:()=>()=>{},onRecovered:()=>()=>{},
  events:{subscribe:(params,listener)=>{
    listeners.set(params.workspacePath,listener);
    return {ready:Promise.resolve(success({subscribed:true,events:[],hasMore:false})),dispose(){listeners.delete(params.workspacePath);}};
  }},
  sessionFrames:{subscribe:()=>({dispose(){}})},
};
function Harness(){store=useRuntimeStore();return <PicoTheme><MemoryRouter><RuntimeContext value={store}><UserMemorySettingsPage/></RuntimeContext></MemoryRouter></PicoTheme>;}
const root=createRoot(document.getElementById("app"));
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});};
const until=async (condition,label)=>{for(let i=0;i<30&&!condition();i++)await settle();check(condition(),label+" did not settle: "+JSON.stringify({connection:store.connection,memory:store.data.memory,listeners:[...listeners.keys()],settingsReads}));};
const checkbox=label=>[...document.querySelectorAll('input[type="checkbox"]')].find(input=>input.getAttribute('aria-label')===label||[...input.labels].some(element=>element.textContent.includes(label)));
const checked=label=>{const input=checkbox(label);check(input,"Missing checkbox "+label);return input.checked;};
const event=(workspacePath,entityType,id)=>({protocolVersion:1,eventId:id,topic:"memory.changed",scope:{workspacePath},resourceVersion:settings.version,at:Date.now(),payload:{entityType,entityId:entityType==="settings"?"settings":"private-item",version:settings.version,change:"updated"}});
(async()=>{
  try {
    localStorage.clear();
    await act(async()=>root.render(<Harness/>));
    await until(()=>store.connection.kind==="ready"&&store.data.memory.settings,"bootstrap");
    check(checked("会话召回"),"initial policy missing");
    holdGlobal=true;
    let oldGlobal;
    await act(async()=>{oldGlobal=store.actions.loadUserMemorySettings();});
    await act(async()=>{await store.actions.updateUserMemorySettings(1,{recallEnabled:false});});
    await act(async()=>{releaseGlobal();await oldGlobal;});
    check(store.data.memory.settings.version===2&&!checked("会话召回"),"late global read reverted the page");

    const a="/project/a",b="/project/b";
    await act(async()=>{await store.actions.selectWorkspace(a);});
    await until(()=>listeners.has(a),"project A subscription");
    check(store.data.memory.settings.version===2,"workspace reset lost policy");
    holdWorkspace=true;
    let oldWorkspace;
    await act(async()=>{oldWorkspace=store.actions.refreshMemory();});
    await act(async()=>{await store.actions.updateUserMemorySettings(2,{enabled:false});});
    await act(async()=>{releaseWorkspace();await oldWorkspace;});
    check(store.data.memory.settings.version===3&&!checked("启用记忆"),"late workspace read reverted policy");
    await act(async()=>{await store.actions.selectWorkspace(b);});
    await until(()=>listeners.has(b),"project B subscription");
    check(store.data.memory.settings.version===3&&!checked("启用记忆"),"switching projects reverted policy");

    settings={...settings,recallEnabled:true,version:4};
    const beforeLists=lists;
    await act(async()=>listeners.get(b)(event(b,"settings","settings-4")));
    await until(()=>store.data.memory.settings.version===4,"settings notice");
    check(checked("会话召回")&&lists===beforeLists,"settings notice must refresh shared policy without loading project items");
    await act(async()=>listeners.get(b)(event(a,"item","foreign-item")));
    await settle();
    check(lists===beforeLists,"foreign project item escaped workspace filter");

    settings={...settings,autoExtract:false,version:5};
    const beforeFocus=settingsReads;
    await act(async()=>window.dispatchEvent(new Event("focus")));
    await until(()=>store.data.memory.settings.version===5,"focus refresh");
    check(!checked("自动提取长期信息")&&settingsReads>beforeFocus,"focus did not refresh shared policy");
    settings={...settings,enabled:true,version:6};
    let conflict=false;
    await act(async()=>{try{await store.actions.updateUserMemorySettings(5,{autoExtract:true});}catch{conflict=true;}});
    check(conflict&&store.data.memory.settings.version===6&&checked("启用记忆"),"conflict did not reload current policy");
    await act(async()=>root.unmount());
    await fetch("/result",{method:"POST",body:"ok"});
  } catch(error) {await fetch("/result",{method:"POST",body:error.stack||String(error)});}
})();
`);
    assert.equal(result, "ok");
  },
);
