import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("试用、人工审核和停用分别展示，审核只在显式操作后提交", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {TaskExperiencePanel,experienceNeedsReview} from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import {ExperienceUsagePanel} from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const root=createRoot(document.getElementById('app'));
const source={sessionId:'session',runId:'run',turnId:'turn',eventId:'source'};
let candidate={kind:'task-lesson',candidateId:'lesson',itemId:'memory',workspaceKey:'/project',workDir:'/project',sessionId:'session',runId:'run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'限定范围读取',content:'读取指定目录后再检查结果。',review:'unneeded',risk:'low',maturity:'trial',promotionReason:'none',positiveReuseCount:1,validation:'unknown',enabled:true,lifecycleState:'active',state:'saved',sources:[source],applicability:{taskFamily:'coding',toolNames:['read_file'],conditions:['只在指定目录']} };
let reviewPending;const reviews=[];
const onReview=async input=>{reviews.push(input);if(reviewPending)return reviewPending;candidate={...candidate,recordRevision:candidate.recordRevision+1,...(input.action==='disable'?{enabled:false}:input.action==='restore'?{enabled:true}:input.action==='reject'?{review:'rejected',state:'discarded',enabled:false,content:''}:input.action==='defer'?{review:'deferred',enabled:false}:{review:'approved',enabled:true,maturity:'active',promotionReason:'human_approved'})};return candidate};
const onDetail=async()=>({learningVersion:2,candidate,observations:[{observationId:'o',kind:'user-input',correction:true,summary:'用户纠正了需要检查的目录',source}],reuse:[]});
const render=(mode='conversation')=>root.render(<PicoTheme><MemoryRouter><TaskExperiencePanel mode={mode} filter='saved' workspacePath='/project' sessionId='session' items={[candidate]} reuse={[]} onDetail={onDetail} onReview={onReview} onFeedback={async()=>candidate}/></MemoryRouter></PicoTheme>);
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
const body=()=>document.body.textContent;
(async()=>{
 await act(async()=>render());
 check(body().includes('1 条试用中')&&body().includes('正向复用 1/2 次'),'trial receipt preserves evidence progress');
 check(!document.querySelector('[aria-label="任务经验审核卡片"]')&&!button('确认并启用')&&reviews.length===0,'low risk trial never asks for approval');
 await act(async()=>render('memory'));await act(async()=>document.querySelector('.task-experience__row').click());
 await act(async()=>button('停用').click());await act(async()=>render('memory'));
 check(document.querySelector('.task-experience__row').textContent.includes('已停用')&&document.querySelector('[aria-label="经验状态和晋级依据"]').textContent.includes('已停用'),'disabled trial does not appear reusable');
 check(button('恢复受限试用')&&candidate.maturity==='trial'&&candidate.positiveReuseCount===1,'manual stop preserves trial maturity and progress');
 await act(async()=>button('恢复受限试用').click());check(candidate.maturity==='trial'&&candidate.review==='unneeded','restore keeps trial rather than confirming it');
 candidate={...candidate,review:'approved',maturity:'active',promotionReason:'two_positive_reuses',positiveReuseCount:2,enabled:false,recordRevision:9};
 await act(async()=>render());
 check(body().includes('已停用')&&!body().includes('条已启用')&&!body().includes('已晋级并启用'),'disabled mature experience is not reported enabled');
 candidate={...candidate,itemId:undefined,review:'pending',risk:'high',maturity:'unassessed',enabled:false,recordRevision:10,reviewReason:'可能涉及外部发布，请确认来源和适用条件。'};
 await act(async()=>render());
 check(document.querySelector('[aria-label="任务经验审核卡片"]')&&body().includes(candidate.reviewReason)&&body().includes('用户纠正了需要检查的目录')&&body().includes('审核前不会用于后续任务'),'risk review exposes reason and sources');
 check(reviews.length===2,'opening and ignoring a risky candidate never confirms it');
 let resolveReview;reviewPending=new Promise(resolve=>resolveReview=resolve);
 await act(async()=>{button('拒绝').click();button('拒绝').click();});
 check(reviews.length===3&&reviews.at(-1).action==='reject','synchronous repeated click submits once');
 candidate={...candidate,review:'rejected',state:'discarded',enabled:false,content:'',recordRevision:11};
 await act(async()=>{resolveReview(candidate);await Promise.resolve();});
 check(!experienceNeedsReview(candidate)&&!button('确认并启用')&&!button('拒绝'),'rejected experience cannot be reviewed again from stale card');
 const use={useId:'trial-use',workspaceKey:'/project',itemId:'memory',itemVersion:1,contentHash:'hash',source:{kind:'reviewed-reference',candidateId:'trial',contentVersion:1},taskId:'reuse',taskVersion:1,sessionId:'session',runId:'reuse-run',referenceHash:'ref',referenceContent:'待验证提示',delivery:'carried',historical:false,adoption:'unknown',validation:'unknown',validationScope:'unknown',excluded:false,deleted:false,sources:[],managementRevision:1,settingsVersion:1,deletionRevision:0,createdAt:1,updatedAt:1};
 await act(async()=>root.render(<PicoTheme><MemoryRouter><ExperienceUsagePanel uses={[use]} workspacePath='/project' onDetail={async()=>({experienceVersion:1,use,effects:[]})} onFeedback={async()=>use}/></MemoryRouter></PicoTheme>));
 check(body().includes('任务经验参考')&&!body().includes('用户确认：已确认此版本')&&!body().includes('用户确认的任务经验'),'reference source type never implies human approval');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: memory risk review'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
  assert.equal(result, "PASS: memory risk review", result);
});

test(
  "整理历史展示原因、期限和真实撤销结果，并隔离切换工作区后的迟到结果",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const now=Date.now();const item={itemId:'memory',fromVersion:1,archivedVersion:2,reason:'superseded'};
let receipts=[{batchId:'recent',status:'undoable',consideredCount:8,createdAt:now-1000,expiresAt:now+3600000,items:[item]},{batchId:'expired',status:'undoable',consideredCount:2,createdAt:now-3000,expiresAt:now-1,items:[item]},{batchId:'old',status:'undone',consideredCount:1,createdAt:now-4000,expiresAt:now+3600000,undoneAt:now-2000,items:[item]}];
let refreshes=0,mode='conflict',resolveUndo;const undos=[];
const actions={queryMemoryConsolidationHistory:async()=>({receipts}),undoMemoryConsolidation:async(path,batchId)=>{undos.push([path,batchId]);if(mode==='pending')return new Promise(resolve=>resolveUndo=resolve);if(mode==='conflict')return{status:'conflict',batchId,conflicts:[{itemId:'memory',expectedVersion:2,actualVersion:3,reason:'version_changed'}]};receipts=receipts.map(receipt=>receipt.batchId===batchId?{...receipt,status:'undone',undoneAt:now}:receipt);return{status:'undone',receipt:receipts[0]}},refreshMemory:async()=>{refreshes++}};
let path='/project';const root=createRoot(document.getElementById('app'));
const render=()=>root.render(<PicoTheme><MemoryRouter><MemoryPage runtime={{preview:false,connection:{kind:'ready'},actions,data:{...previewData,workspacePath:path,trusted:true,memory:{...previewData.memory,workspacePath:path,status:"ready",items:[]}}}}/></MemoryRouter></PicoTheme>);
const batch=id=>[...document.querySelectorAll('.memory-maintenance__batch')].find(node=>node.textContent.includes(id));
const undo=()=>document.querySelector('.memory-maintenance__batch button');
(async()=>{
 await act(async()=>render());
 check(document.querySelectorAll('.memory-maintenance__batch').length===3&&document.body.textContent.includes('已被新记忆替代 1 条')&&document.body.textContent.includes('每批整理可在 30 天内撤销'),'history explains changed quantity, reason and undo window');
 const batches=[...document.querySelectorAll('.memory-maintenance__batch')];check(batches[1].querySelector('button').disabled&&!batches[2].querySelector('button'),'expired and undone batches cannot submit another undo');
 await act(async()=>undo().click());
 check(document.body.textContent.includes('没有部分恢复')&&refreshes===0&&receipts[0].status==='undoable','conflict is shown as no restore and keeps batch undoable');
 mode='success';await act(async()=>undo().click());
 check(document.body.textContent.includes('恢复 1 条记忆')&&refreshes===1&&receipts[0].status==='undone','successful undo refreshes memory and updates history');
 receipts=[{...receipts[0],batchId:'pending',status:'undoable'}];mode='pending';
 await act(async()=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='刷新记录').click());
 await act(async()=>undo().click());
 path='/another';await act(async()=>render());path='/project';await act(async()=>render());
 await act(async()=>{resolveUndo({status:'conflict',batchId:'pending',conflicts:[{itemId:'memory',expectedVersion:2,reason:'old-workspace'}]});await Promise.resolve();});
 check(!document.body.textContent.includes('没有部分恢复')&&!document.body.textContent.includes('恢复 1 条记忆'),'late undo outcome never revives after leaving and returning to a workspace');
 check(undos.every(([workspace])=>workspace==='/project'),'undo uses workspace frozen at explicit click');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: memory maintenance UI'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: memory maintenance UI", result);
  },
);
