import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("设置内统一管理范围、分页、管理跳转及过期响应隔离", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react'; import {act} from 'react'; import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
import {UserMemorySettingsPage} from './apps/desktop/src/renderer/pages/UserMemorySettingsPage.tsx';
import {RuntimeContext} from './apps/desktop/src/renderer/runtime-context.tsx';
import {LegacyMemoryRoute} from './apps/desktop/src/renderer/App.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(v,m)=>{if(!v)throw Error(m)};const calls=[];let runtime,rerender,held,resolveHeld;
const base={...previewData.memory.items[0],itemId:'global',content:'共享偏好',scopeType:'global',lifecycleState:'active',sources:[],sourceCount:0};
const workspaces=[{path:'/a',name:'项目 A',trusted:true},{path:'/b',name:'项目 B',trusted:true},{path:'/blocked',name:'未信任项目',trusted:false}];
const actions={loadUserMemorySettings:async()=>{},queryMemoryMetrics:async()=>undefined,refreshMemory:async()=>{},
queryMemoryScope:async(path,tab,cursor)=>{calls.push({path,tab,cursor});if(held&&path==='/b')return new Promise(resolve=>resolveHeld=resolve);if(tab==='pending')return {suggestions:{learningVersion:2,items:[],reuse:[]}};return {memory:{items:cursor?[{...base,itemId:'page-two',content:'第二页内容',scopeType:'workspace'}]:[base,{...base,itemId:path,content:'项目内容 '+path,scopeType:'workspace'}],pageInfo:{revision:1,counts:{active:3,archived:0,total:3},...(path==='/a'&&!cursor?{nextCursor:'next'}:{})}}};},
selectWorkspace:async(path)=>{runtime={...runtime,data:{...runtime.data,workspacePath:path,trusted:true,memory:{...runtime.data.memory,workspacePath:path,items:[]}}};rerender(n=>n+1);},
getExperienceMemoryItem:async(path,id)=>({...base,itemId:id,scopeType:id==='global'?'global':'workspace',content:'精确管理 '+id}),
};
function Probe(){const location=useLocation(),navigate=useNavigate();return <><output id='route'>{location.pathname+location.search+location.hash}</output><button id='global' onClick={()=>navigate('/settings/memory?scope=global')}>global</button><button id='all' onClick={()=>navigate('/settings/memory?scope=all')}>all</button></>}
function Harness(){const [,set]=React.useState(0);rerender=set;runtime=runtime||{preview:false,connection:{kind:'ready'},taskExperienceSupported:false,experienceFeedbackSupported:false,actions,data:{...previewData,workspacePath:'/a',trusted:true,workspaces,memory:{...previewData.memory,workspacePath:'/a',items:[],status:'ready',pageInfo:undefined}},busy:undefined};return <PicoTheme><RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={['/memory?scope=all#legacy']}><Routes><Route path='/memory' element={<LegacyMemoryRoute/>}/><Route path='/settings/memory' element={<UserMemorySettingsPage/>}/></Routes><Probe/></MemoryRouter></RuntimeContext.Provider></PicoTheme>}
const root=createRoot(document.getElementById('app'));const button=s=>[...document.querySelectorAll('button')].find(n=>n.textContent.includes(s));
(async()=>{await act(async()=>root.render(<Harness/>));
check(document.querySelector('#route').textContent==='/settings/memory?scope=all#legacy','legacy link redirects while preserving query and anchor');
check(calls.length===2&&!calls.some(c=>c.path==='/blocked'),'only trusted registered scopes read');
check(document.querySelectorAll('.memory-overview-row').length===3,'global item deduplicated across workspaces');
check(document.body.textContent.includes('未信任项目 尚未信任'),'untrusted omission is visible');
await act(async()=>button('加载更多').click());check(document.body.textContent.includes('第二页内容'),'cursor page appended');
await act(async()=>document.querySelector('#global').click());check(document.querySelectorAll('.memory-overview-row').length===1,'global filter hides workspace content');
held=true;await act(async()=>document.querySelector('#all').click());check(resolveHeld,'second workspace held');const stale=resolveHeld;
held=false;await act(async()=>document.querySelector('#global').click());
await act(async()=>{stale({memory:{items:[{...base,itemId:'stale',content:'迟到正文',scopeType:'workspace'}]}});});
check(!document.body.textContent.includes('迟到正文'),'late result cannot escape global scope');
const link=[...document.querySelectorAll('a')].find(n=>n.textContent.includes('共享偏好'));check(link,'global content link exists');
await act(async()=>link.click());check(document.querySelector('#route').textContent.includes('/settings/memory?')&&document.querySelector('#route').textContent.includes('workspace=%2Fa')&&document.querySelector('#route').textContent.includes('item=global'),'management opens inside settings with owning workspace');
await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS unified settings'});
})().catch(async e=>fetch('/result',{method:'POST',body:'FAIL '+e.stack}));
`);
  assert.equal(result, "PASS unified settings", result);
});

test("集中读取只访问已信任范围，权限撤销隔离在途结果", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {useRuntimeStore} from './apps/desktop/src/renderer/runtime.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(v,m)=>{if(!v)throw Error(m)},ok=value=>({ok:true,value});let store,release,hold=false;const reads=[];const trusts={'/a':true,'/blocked':false};
window.pico={runtime:new Proxy({},{get:(_,method)=>async params=>{
 if(method==='runtime.ping')return ok({picoHome:'/test',capabilities:['session-conversation-v1','workspace-memory-v1','memory-learning-v2','memory-experience-feedback-v1']});
 if(method==='workspace.list')return ok({workspaces:Object.keys(trusts).map(workspacePath=>({workspacePath,registered:true,mode:'folder'}))});
 if(method==='workspace.trustStatus')return ok({trusted:trusts[params.workspacePath]});
 if(method==='workspace.trust'){trusts[params.workspacePath]=params.trusted;return ok({trusted:params.trusted});}
 if(method==='session.list')return ok({sessions:[]});if(method==='runs.list')return ok({runs:[]});
 if(method==='memory.settings.get')return ok({settings:{enabled:true,autoExtract:true,recallEnabled:true,version:1}});
 if(method==='memory.list'){reads.push(params);if(hold)return new Promise(resolve=>release=()=>resolve(ok({items:[]})));return ok({items:[]});}
 return {ok:false,error:{code:'METHOD_NOT_FOUND',message:method,retryable:false}};
}}),platform:{getLaunchAtLogin:async()=>ok(false)},lifecycle:{getBackgroundMode:async()=>ok(false)},onUnavailable:()=>()=>{},onRecovered:()=>()=>{}};
function Harness(){store=useRuntimeStore();return <p>{store.connection.kind}</p>}
const root=createRoot(document.getElementById('app'));
(async()=>{localStorage.clear();await act(async()=>root.render(<Harness/>));for(let i=0;i<30&&store.connection.kind!=='ready';i++)await act(async()=>new Promise(r=>setTimeout(r,20)));
check(store.connection.kind==='ready','ready');const prior=store.data.workspacePath;await store.actions.queryMemoryScope('/a','archived');check(reads.at(-1).lifecycleStates[0]==='archived'&&reads.at(-1).learningVersion===2,'scoped query uses compatible projection');check(store.data.workspacePath===prior,'read does not change current task');
for(const path of ['/blocked','/unregistered']){let denied=false;try{await store.actions.queryMemoryScope(path,'saved')}catch{denied=true}check(denied,'untrusted and unknown blocked')}
check(reads.length===1,'blocked reads never reach host');hold=true;const pending=store.actions.queryMemoryScope('/a','saved').then(()=>false,()=>true);check(release,'read held');await act(async()=>store.actions.trustWorkspace('/a',false));release();check(await pending,'revocation invalidates late result');check(!store.data.workspaces.find(w=>w.path==='/a').trusted,'trust remains revoked');
await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS scope authorization'});
})().catch(async e=>fetch('/result',{method:'POST',body:'FAIL '+e.stack}));
`);
  assert.equal(result, "PASS scope authorization", result);
});
