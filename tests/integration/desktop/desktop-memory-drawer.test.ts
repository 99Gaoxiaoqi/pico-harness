import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "会话经验抽屉保持草稿、滚动和路由，展示冻结版本并隔离迟到详情",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
import {ConversationPage} from './apps/desktop/src/renderer/pages/ConversationPage.tsx';
import {ExperienceUsagePanel} from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import {RuntimeContext} from './apps/desktop/src/renderer/runtime-context.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
import {sessionHref,workspaceSessionKey} from './apps/desktop/src/renderer/workspace-session.ts';
import './apps/desktop/src/renderer/styles.css';import './apps/desktop/src/renderer/conversation/conversation.css';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(v,m)=>{if(!v)throw new Error(m)};const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const scope={workspacePath:previewData.workspacePath,sessionId:'drawer-session'};
const use={useId:'use',workspaceKey:scope.workspacePath,source:{kind:'reviewed-reference',candidateId:'lesson',contentVersion:2},itemId:'memory',itemVersion:3,contentHash:'hash',taskId:'task',taskVersion:1,sessionId:scope.sessionId,runId:'canonical',hostRunId:'desktop-run',referenceHash:'frozen',referenceContent:'实际注入的旧版本正文',delivery:'carried',historical:false,managementRevision:1,settingsVersion:1,deletionRevision:0,adoption:'observed',validation:'pass',validationScope:'spreadsheet-range',excluded:false,deleted:false,sources:[],createdAt:1,updatedAt:1};
const candidate={kind:'task-lesson',candidateId:'lesson',itemId:'memory',workspaceKey:scope.workspacePath,sessionId:scope.sessionId,runId:'desktop-run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'先核对范围',content:'核对用户指定范围',review:'pending',validation:'unknown',enabled:false,lifecycleState:'active',state:'ready',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
let reads=0;const feedback=[];
const effect={effectId:'effect',adoption:'observed',validation:'pass',validationScope:'spreadsheet-range',reason:'仅核对 B2:B3 求和',preparedEventId:'prepared',preparedSequence:2,outcomeEventId:'outcome',outcomeSequence:3,sources:[]};
const actions={queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:scope.workspacePath,revision:1,items:[candidate],reuse:[]}),detailTaskExperience:async()=>({learningVersion:2,candidate,observations:[],reuse:[]}),reviewTaskExperience:async()=>candidate,loadSession:async()=>true,queryExperienceUses:async()=>({experienceVersion:1,diagnostics:[],uses:[use]}),detailExperienceUse:async()=>{reads++;return{experienceVersion:1,use,effects:[effect]}},getExperienceMemoryItem:async()=>({...previewData.memory.items[0],itemId:'memory',version:3,lifecycleState:'active'}),feedbackExperienceUse:async(_,request)=>{feedback.push(request);return{experienceVersion:1,use:{...use,excluded:true,managementRevision:2}}}};
const items=[{id:'user',kind:'userMessage',text:'汇总 B2:B3'},{id:'start',kind:'runBoundary',runId:'desktop-run',status:'started',label:'运行中'},...Array.from({length:25},(_,i)=>({id:'answer'+i,kind:'assistantMessage',text:'保留的任务消息 '+i,runId:'canonical'})),{id:'end',kind:'runBoundary',runId:'desktop-run',status:'completed',label:'完成'}];
const runtime={preview:false,connection:{kind:'ready'},experienceFeedbackSupported:true,taskExperienceSupported:true,actions,data:{...previewData,trusted:true,timeline:[],approvals:[],prompts:[],sessions:[{id:scope.sessionId,workspacePath:scope.workspacePath,title:'汇总本月销售额',status:'active',updatedAt:2}],runs:[{id:'desktop-run',...scope,status:'completed',description:'求和',startedAt:1,updatedAt:2}],conversations:{[workspaceSessionKey(scope)]:{...scope,items,queuedCount:0}}}};
function Probe(){const location=useLocation();return <output id='route'>{location.pathname+location.search}</output>}
const root=createRoot(document.getElementById('app'));const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===label||n.getAttribute('aria-label')===label);
(async()=>{
await act(async()=>root.render(<PicoTheme><RuntimeContext value={runtime}><MemoryRouter initialEntries={[sessionHref(scope)]}><Routes><Route path='/session/:sessionId' element={<ConversationPage/>}/></Routes><Probe/></MemoryRouter></RuntimeContext></PicoTheme>));
await frame();
const composer=document.querySelector('[contenteditable="true"]');check(composer,'real conversation composer exists');
await act(async()=>{composer.focus();composer.textContent='请保留这段草稿，稍后继续。';composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:composer.textContent}));});
const scroller=document.querySelector('.conversation-surface__scroll');scroller.style.height='240px';scroller.style.maxHeight='240px';await frame();
await act(async()=>{scroller.scrollTop=120;scroller.dispatchEvent(new Event('scroll',{bubbles:true}));});
const scroll=scroller.scrollTop,route=document.querySelector('#route').textContent,trigger=document.querySelector('button[data-use-id="use"]');
check(scroll>0&&trigger,'scroll position and completed-run receipt exist');check(reads===0,'collapsed entry performs no detail read');
await act(async()=>{trigger.focus({preventScroll:true});trigger.click();});await frame();
let dialog=document.querySelector('dialog[open]');check(dialog&&reads===1,'one explicit click opens one detail read');
check(dialog.textContent.includes('实际注入的旧版本正文')&&dialog.textContent.includes('任务经验参考 · v2')&&dialog.textContent.includes('本次使用记录保持记忆版本 v3'),'drawer keeps frozen content and version');
check(dialog.textContent.includes('仅核对 B2:B3 求和')&&dialog.textContent.includes('不代表经验正文、根因或整个任务已验证'),'native evidence and result boundary remain visible');
await act(async()=>button('本次不适用').click());
check(feedback.length===1&&feedback[0].expectedItemVersion===3&&dialog.textContent.includes('其他任务仍可使用'),'feedback uses actual referenced version');
await act(async()=>button('关闭经验详情').click());await frame();
check(!document.querySelector('dialog[open]')&&document.activeElement===trigger,'close restores trigger focus');
check(document.querySelector('[contenteditable="true"]')===composer&&composer.textContent==='请保留这段草稿，稍后继续。','conversation draft node and contents survive');
check(scroller.scrollTop===scroll&&document.querySelector('#route').textContent===route,'close preserves scroll and route');
await act(async()=>trigger.click());
await act(async()=>document.querySelector('.experience-drawer[open]').dispatchEvent(new Event('cancel',{cancelable:true})));
check(!document.querySelector('dialog[open]'),'native Escape cancel closes drawer');
await act(async()=>button('审核本轮任务经验').click());
await act(async()=>document.querySelector('.experience-drawer .task-experience__row').click());
check(document.querySelector('.experience-drawer').textContent.includes('核对用户指定范围'),'pending review uses existing review detail inside drawer');
await act(async()=>button('编辑并确认').click());const reviewEditor=document.querySelector('.experience-drawer[open] textarea');check(reviewEditor,'review editor exists');
await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(reviewEditor,'关闭后继续编辑的经验草稿');reviewEditor.dispatchEvent(new Event('input',{bubbles:true}));});
await act(async()=>button('关闭经验详情').click());
await act(async()=>button('审核本轮任务经验').click());check(document.querySelector('.experience-drawer[open] textarea')===reviewEditor&&reviewEditor.value==='关闭后继续编辑的经验草稿','review draft survives close and reopen');
await act(async()=>document.querySelector('.experience-drawer[open]').dispatchEvent(new Event('cancel',{cancelable:true})));
await act(async()=>button('审核本轮任务经验').click());check(document.querySelector('.experience-drawer[open] textarea')===reviewEditor,'Escape preserves review draft');
await act(async()=>button('关闭经验详情').click());
check(composer.textContent==='请保留这段草稿，稍后继续。'&&document.querySelector('#route').textContent===route,'review closes back to unchanged task');
await act(async()=>trigger.click());
await act(async()=>document.querySelector('.experience-drawer[open] a').click());
check(sessionStorage.getItem('pico.settings-return-to')===route,'management preserves exact conversation return route');
// Change scope while an older detail request is still pending; returning to A must not revive it.
let resolveOld;const old=new Promise(resolve=>resolveOld=resolve);let path='/a',session='a';
const render=()=>root.render(<PicoTheme><MemoryRouter><ExperienceUsagePanel presentation='drawer' workspacePath={path} sessionId={session} uses={[use]} onDetail={()=>old} onFeedback={async()=>use}/></MemoryRouter></PicoTheme>);
await act(async()=>render());await act(async()=>document.querySelector('button[data-use-id]').click());
check(document.querySelector('dialog[open]'),'pending detail is open');
path='/b';session='b';await act(async()=>render());check(!document.querySelector('dialog'),'scope change clears old drawer');
path='/a';session='a';await act(async()=>render());
await act(async()=>{resolveOld({experienceVersion:1,use:{...use,referenceContent:'迟到旧详情'},effects:[effect]});await Promise.resolve();});
check(!document.querySelector('dialog')&&!document.body.textContent.includes('迟到旧详情'),'late A response cannot contaminate returned scope');
await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: conversation memory drawer'});
})().catch(error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: conversation memory drawer", result);
  },
);
