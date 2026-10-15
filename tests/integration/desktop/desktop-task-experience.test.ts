import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "任务经验四态：历史审核、失败与冲突保草稿、真实引用及纠正版本",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MemoryPage } from './apps/desktop/src/renderer/MemoryPage.tsx';
import { TaskExperiencePanel } from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import { ConversationTranscript } from './apps/desktop/src/renderer/conversation/ConversationTranscript.tsx';
import { RuntimeInvocationError } from './apps/desktop/src/renderer/runtime.ts';
import { previewData } from './apps/desktop/src/renderer/fixture.ts';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const check=(v,m)=>{if(!v)throw new Error(m)};
const source={sessionId:'source-session',runId:'source-run',turnId:'turn-user',eventId:'user-correction-event'};
let candidate={kind:'task-lesson',candidateId:'lesson-1',contentVersion:1,recordRevision:1,review:'pending',validation:'pass',enabled:false,lifecycleState:'active',taskId:'task-source',taskVersion:1,workspaceKey:'/project',workDir:'/project',sessionId:'source-session',runId:'source-run',failureKey:'task:source',inputEpoch:1,settingsVersion:1,deletionRevision:0,state:'saved',goal:'对无表头数值求和',content:'全部行均属于数据。',sources:[source],observationIds:['observation-user'],createdAt:1,updatedAt:1,applicability:{taskFamily:'spreadsheet',toolNames:['spreadsheet.query'],conditions:['没有表头','仅有限数值'],spreadsheet:{operation:'sum',header:false,dataKind:'finite-numbers'}}};
const observation={observationId:'observation-user',taskId:'task-source',taskVersion:1,kind:'user-input',source,sequence:1,summary:'用户指出首行也是数据',coverage:'complete',correction:true,createdAt:1};
let failure='save', detailCalls=0;
const reviewCalls=[], feedbackCalls=[];
const onDetail=async id=>{detailCalls++;return{learningVersion:2,candidate,observations:[observation],reuse:[]}};
const onReview=async input=>{
  reviewCalls.push(input);
  if(input.action==='disable'){candidate={...candidate,recordRevision:candidate.recordRevision+1,enabled:false};return candidate}
  if(failure==='save'){failure='conflict';throw new Error('disk busy')}
  if(failure==='conflict'){failure='';candidate={...candidate,contentVersion:2,recordRevision:2,content:'最新版本：先确认数据范围。'};throw new RuntimeInvocationError('CONFLICT','changed',false)}
  candidate={...candidate,contentVersion:candidate.contentVersion+1,recordRevision:candidate.recordRevision+1,content:input.content,applicability:input.applicability,review:'approved',validation:'unknown',enabled:true};
  return candidate;
};
const onFeedback=async input=>{feedbackCalls.push(input);if(input.action==='correct')candidate={...candidate,enabled:false,review:'pending',validation:'stale',recordRevision:candidate.recordRevision+1};return candidate};
const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,executionLearningRevision:0,data:{...previewData,workspacePath:'/project',trusted:true,memory:{...previewData.memory,workspacePath:'/project',status:'ready',items:[],pageInfo:undefined,settings:{...previewData.memory.settings,enabled:false,recallEnabled:false,autoExtract:false}}},actions:{queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:'/project',revision:candidate.recordRevision,items:[candidate],reuse:[]}),detailTaskExperience:onDetail,reviewTaskExperience:async(_,input)=>onReview(input),feedbackTaskExperience:async(_,input)=>onFeedback(input),refreshMemory:async()=>{}},busy:undefined};
const root=createRoot(document.getElementById('app'));
const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent===label);
const input=(node,value)=>{Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};
const renderPanel=(props)=>root.render(<PicoTheme><MemoryRouter><TaskExperiencePanel items={[candidate]} reuse={[]} onDetail={onDetail} onReview={onReview} onFeedback={onFeedback} {...props}/></MemoryRouter></PicoTheme>);
(async()=>{
  await act(async()=>root.render(<PicoTheme><MemoryRouter initialEntries={['/memory?tab=pending']}><MemoryPage runtime={runtime}/></MemoryRouter></PicoTheme>));
  check(document.querySelectorAll('[role=tab]').length===3,'real memory page has pending, saved, archived tabs');
  check(text().includes('自动学习已关闭')&&text().includes('记忆召回已关闭'),'disabled settings retain historical management');
  check(document.querySelector('.task-experience__row'),'pending experience loads with automatic learning off');
  check(detailCalls===0,'list never reads detail or grabs focus automatically');
  await act(async()=>document.querySelector('.task-experience__row').click());
  check(text().includes('需审核')&&text().includes('历史验证：验证通过（范围见使用记录）')&&text().includes('确认表示允许作为参考使用，不代表经验正文或整个任务已通过验证。'),'review and bounded validation are independent');
  check(text().includes('没有表头')&&text().includes('用户指出首行也是数据')&&text().includes('user-correction-event'),'conditions and correction provenance are inspectable');
  await act(async()=>button('编辑并确认').click());
  await act(async()=>input(document.querySelector('textarea'),'我的更正草稿：保留第一行。'));
  await act(async()=>button('保存更正并启用').click());
  check(document.querySelector('textarea').value==='我的更正草稿：保留第一行。'&&text().includes('草稿已保留'),'failed save keeps draft');
  await act(async()=>button('保存更正并启用').click());
  check(reviewCalls[0].operationId===reviewCalls[1].operationId,'uncertain retry keeps operation id');
  check(document.querySelector('textarea').value==='我的更正草稿：保留第一行。'&&text().includes('最新版本：先确认数据范围。'),'version conflict displays latest while preserving draft');
  check(button('保存更正并启用').disabled,'conflict requires explicit rebase before save');
  await act(async()=>button('基于最新版本继续更正').click());
  await act(async()=>button('保存更正并启用').click());
  check(reviewCalls[2].expectedContentVersion===2&&reviewCalls[2].expectedRecordRevision===2,'save targets reviewed latest record');
  check(!('spreadsheet' in reviewCalls[2].applicability),'editor only sends public applicability fields');
  check(candidate.contentVersion===3&&candidate.validation==='unknown'&&candidate.enabled,'one save confirms a new version and resets validation');
  check(text().includes('没有待审核的任务经验'),'review completion gives explicit empty state');
  await act(async()=>renderPanel({filter:'saved'}));
  await act(async()=>document.querySelector('.task-experience__row').click());
  await act(async()=>button('开始更正').click());
  check(reviewCalls.at(-1).action==='disable'&&!candidate.enabled&&document.querySelector('textarea'),'memory manager also stops enabled old version before opening correction');
  await act(async()=>button('取消更正').click());
  check(!candidate.enabled&&!document.querySelector('textarea'),'cancelled correction keeps old version disabled');

  candidate={...candidate,sessionId:'session-new',runId:'run-new',review:'approved',contentVersion:1,recordRevision:1,content:'当前内容已变更',enabled:true};
  const reference={reuseId:'reuse-a',workspaceKey:'/project',candidateId:'lesson-1',contentVersion:1,itemId:'memory-real',itemVersion:4,taskId:'task-new',taskVersion:2,sessionId:'session-new',runId:'run-new',referenceHash:'actual-reference-hash',referenceContent:'本次实际引用：全部行均属于数据。',adoption:'unknown',validation:'unknown',excluded:false,sources:[],createdAt:2,updatedAt:2};
  await act(async()=>renderPanel({mode:'conversation',sessionId:'session-new',reuse:[reference]}));
  check(text().includes('本次实际引用：全部行均属于数据。')&&text().includes('旧引用记录 v1（时序不完整）')&&text().includes('采用：未知')&&text().includes('验证：尚未验证'),'reference shows frozen content and distinct reuse states');
  check(!document.querySelector('details.task-experience__summary').open,'task result learning summary starts collapsed');
  await act(async()=>document.querySelector('details.task-experience__summary > summary').click());
  await act(async()=>button('本次不适用').click());
  check(feedbackCalls.at(-1).taskId==='task-new'&&feedbackCalls.at(-1).taskVersion===2&&feedbackCalls.at(-1).action==='not_applicable','not applicable targets current task version only');
  check(candidate.enabled&&text().includes('其他任务仍可使用'),'task exclusion keeps global reference enabled');

  await act(async()=>renderPanel({mode:'conversation',sessionId:'session-new',reuse:[{...reference,reuseId:'reuse-correct',taskId:'task-correct'}]}));
  await act(async()=>button('纠正经验').click());
  check(feedbackCalls.at(-1).action==='correct'&&!candidate.enabled&&document.querySelector('textarea'),'correction stops old version before editing');
  await act(async()=>input(document.querySelector('textarea'),'确认求和范围后包含第一行。'));
  const before=reviewCalls.length;
  await act(async()=>button('保存更正并启用').click());
  check(reviewCalls.length===before+1&&reviewCalls.at(-1).action==='edit_accept','corrected save is a single confirmation');
  check(text().includes('本次旧引用仍已排除')&&candidate.contentVersion===2&&candidate.validation==='unknown','new version remains unvalidated and old task reference stays excluded');

  await act(async()=>root.render(<PicoTheme><MemoryRouter><ConversationTranscript items={[{id:'user',kind:'userMessage',text:'开始任务',at:1},{id:'start',kind:'runBoundary',runId:'run-new',status:'started',label:'',at:1},{id:'tool',kind:'tool',runId:'run-new',name:'shell',target:'test',state:'done',at:2},{id:'answer',kind:'assistantMessage',runId:'run-new',text:'任务结果已完成',at:3},{id:'end',kind:'runBoundary',runId:'run-new',status:'completed',label:'完成',at:4}]} renderRunFooter={runId=><TaskExperiencePanel mode='conversation' sessionId='session-new' items={[candidate]} reuse={[]} onDetail={onDetail} onReview={onReview} onFeedback={onFeedback}/>}/></MemoryRouter></PicoTheme>));
  const turn=document.querySelector('.conversation-turn');
  check(turn.querySelector('.conversation-turn__learning'),'learning summary is anchored below its actual task result');
  check(turn.textContent.indexOf('任务结果已完成')<turn.textContent.indexOf('本轮任务学习'),'result precedes learning summary');
  const summary=document.querySelector('.task-experience__summary');
  summary.querySelector('summary').focus();
  const focused=document.activeElement;
  candidate={...candidate,review:'pending',recordRevision:3};
  await act(async()=>root.render(<PicoTheme><MemoryRouter><ConversationTranscript items={[{id:'user',kind:'userMessage',text:'开始任务',at:1},{id:'answer',kind:'assistantMessage',runId:'run-new',text:'任务结果已完成',at:3},{id:'end',kind:'runBoundary',runId:'run-new',status:'completed',label:'完成',at:4}]} renderRunFooter={runId=><TaskExperiencePanel mode='conversation' sessionId='session-new' items={[candidate]} reuse={[]} onDetail={onDetail} onReview={onReview} onFeedback={onFeedback}/>}/></MemoryRouter></PicoTheme>));
  check(!document.querySelector('.task-experience__summary').open&&document.activeElement===focused,'background update only changes counts and preserves focus and collapse');
  await act(async()=>root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: task experience UX'});
})().catch(async error=>{await fetch('/result',{method:'POST',body:'FAIL: '+error.stack});});
`);
    assert.equal(result, "PASS: task experience UX", result);
  },
);

test("任务经验历史读取隔离工作区与旧Host，错误重试保留当前投影", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTaskExperience } from './apps/desktop/src/renderer/useTaskExperience.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const check=(v,m)=>{if(!v)throw new Error(m)};
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail});return{promise,resolve,reject}};
const a=deferred();let fail=false,calls=0,revision=2;
const result=path=>({learningVersion:2,workspaceKey:path,revision,items:[{kind:'task-lesson',candidateId:path,recordRevision:1,contentVersion:1,content:path+' content'}],reuse:[]});
const actions={queryTaskExperiences:async path=>{calls++;if(path==='/a')return a.promise;if(fail)throw new Error('read failed');return result(path)},detailTaskExperience:async()=>({learningVersion:2,candidate:{kind:'task-lesson',candidateId:'/b',recordRevision:2,contentVersion:2,content:'/b updated'},observations:[],reuse:[]}),reviewTaskExperience:async()=>{},feedbackTaskExperience:async()=>{}};
const make=(path,supported=true)=>({preview:false,connection:{kind:'ready'},taskExperienceSupported:supported,executionLearningRevision:0,actions,data:{workspacePath:path,trusted:true,memory:{settings:{enabled:false,autoExtract:false,recallEnabled:false}}}});
function Host({runtime}){const learning=useTaskExperience(runtime,{workspacePath:runtime.data.workspacePath});return <><p id='items'>{learning.items.map(item=>item.content).join()}</p><p id='error'>{learning.error}</p><button onClick={()=>void learning.refresh()}>retry</button><button id='detail' onClick={()=>void learning.onDetail('/b')}>detail</button></>}
const root=createRoot(document.getElementById('app'));
(async()=>{
  await act(async()=>root.render(<Host runtime={make('/a')}/>));
  await act(async()=>root.render(<Host runtime={make('/b')}/>));
  check(document.querySelector('#items').textContent==='/b content','historical candidate loads with all learning and recall switches off');
  await act(async()=>{a.resolve({...result('/a'),revision:99});await Promise.resolve()});
  check(document.querySelector('#items').textContent==='/b content','late response from old workspace cannot replace current scope');
  fail=true;
  await act(async()=>document.querySelector('button').click());
  check(document.querySelector('#items').textContent==='/b content'&&document.querySelector('#error').textContent.includes('请重试'),'read failure retains existing projection');
  fail=false;revision=3;
  await act(async()=>document.querySelector('button').click());
  check(!document.querySelector('#error').textContent,'explicit retry clears load error');
  await act(async()=>document.querySelector('#detail').click());
  revision=4;
  await act(async()=>document.querySelector('button').click());
  check(document.querySelector('#items').textContent==='/b updated','older candidate content cannot overwrite a newer detail revision');
  const before=calls;
  await act(async()=>root.render(<Host runtime={make('/legacy',false)}/>));
  check(calls===before&&!document.querySelector('#items').textContent,'old Host receives no v2 methods and old workspace projection disappears');
  await act(async()=>root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: task experience scope'});
})().catch(async error=>{await fetch('/result',{method:'POST',body:'FAIL: '+error.stack});});
`);
  assert.equal(result, "PASS: task experience scope", result);
});

test(
  "筛选、外部审核、归档与删除保留更正草稿，旧详情不解锁冲突，同步双击只保存一次",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TaskExperiencePanel } from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import { RuntimeInvocationError } from './apps/desktop/src/renderer/runtime.ts';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const deferred=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return{promise,resolve}};
let candidate={kind:'task-lesson',candidateId:'lesson',workspaceKey:'/a',sessionId:'session',runId:'run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'选择范围',content:'原始内容',review:'pending',validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
let detailPending,notFound=false,savePending;const saves=[];
const onDetail=async()=>{if(notFound)throw new RuntimeInvocationError('NOT_FOUND','deleted',false);if(detailPending)return detailPending.promise;return{learningVersion:2,candidate,observations:[],reuse:[]}};
const onReview=async input=>{saves.push(input);return savePending.promise};
const root=createRoot(document.getElementById('app'));
let filter='pending',items=()=>[candidate];
const render=()=>root.render(<PicoTheme><MemoryRouter><TaskExperiencePanel workspacePath='/a' filter={filter} items={items()} reuse={[]} onDetail={onDetail} onReview={onReview} onFeedback={async()=>candidate}/></MemoryRouter></PicoTheme>);
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent===label);
const content=()=>document.querySelector('textarea')?.value;
const input=value=>{const node=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};
(async()=>{
 await act(async()=>render());await act(async()=>document.querySelector('.task-experience__row').click());await act(async()=>button('编辑并确认').click());await act(async()=>input('必须保留的草稿'));
 candidate={...candidate,recordRevision:3,contentVersion:3,content:'外部确认的v3',review:'approved'};
 await act(async()=>render());
 check(!document.querySelector('.task-experience__row')&&content()==='必须保留的草稿'&&button('保存更正并启用').disabled,'external confirmation removes only filtered row and preserves editing state');
 detailPending=deferred();await act(async()=>button('重试读取').click());
 await act(async()=>{detailPending.resolve({learningVersion:2,candidate:{...candidate,recordRevision:2,contentVersion:2,content:'迟到的v2'},observations:[],reuse:[]});await Promise.resolve();});
 check(content()==='必须保留的草稿'&&!document.body.textContent.includes('迟到的v2')&&button('基于最新版本继续更正').disabled,'v2 detail cannot overwrite v3 or unlock rebasing');
 detailPending=undefined;await act(async()=>button('重试读取').click());
 check(!button('基于最新版本继续更正').disabled,'fresh detail enables explicit rebase');
 filter='saved';await act(async()=>render());check(content()==='必须保留的草稿','changing tab retains editor');
 candidate={...candidate,recordRevision:4,lifecycleState:'archived',enabled:false};await act(async()=>render());
 check(content()==='必须保留的草稿'&&button('保存更正并启用').disabled,'external archive cannot silently reactivate editing base');
 await act(async()=>button('重试读取').click());await act(async()=>button('基于最新版本继续更正').click());
 savePending=deferred();await act(async()=>{button('保存更正并启用').click();button('保存更正并启用').click();});
 check(saves.length===1&&saves[0].expectedRecordRevision===4&&saves[0].content==='必须保留的草稿','two sync clicks submit one save based on acknowledged archive state');
 candidate={...candidate,recordRevision:5,review:'rejected',state:'discarded',content:'其他客户端拒绝'};await act(async()=>render());
 await act(async()=>{savePending.resolve({...candidate,recordRevision:4,review:'approved',state:'saved',content:'迟到保存'});await Promise.resolve();});
 check(content()==='必须保留的草稿'&&button('保存更正并启用').disabled&&!document.body.textContent.includes('迟到保存'),'older save cannot overwrite rejection or clear draft');
 items=()=>[];await act(async()=>render());notFound=true;await act(async()=>button('重试读取').click());
 check(content()==='必须保留的草稿'&&document.body.textContent.includes('保留供复制')&&button('保存更正并启用').disabled,'deleted or missing candidate retains copyable draft and blocks writes');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: persistent review draft'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: persistent review draft", result);
  },
);
