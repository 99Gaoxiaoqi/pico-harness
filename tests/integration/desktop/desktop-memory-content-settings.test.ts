import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "设置内记忆统一列表支持范围、搜索、审核及独立使用记录，保留更正草稿",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {TaskExperiencePanel} from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const workspace='/project';
const ordinary={...previewData.memory.items[0],itemId:'ordinary',content:'项目发布前运行集成测试',scopeType:'workspace',version:3,lifecycleState:'active'};
const globalItem={...ordinary,itemId:'global',content:'默认使用中文回答',scopeType:'global'};
const archived={...ordinary,itemId:'archived',content:'过时的发布命令',lifecycleState:'archived'};
const base={kind:'task-lesson',workspaceKey:workspace,sessionId:'source',runId:'run',taskId:'task',taskVersion:1,contentVersion:2,recordRevision:4,validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
let saved={...base,candidateId:'saved',itemId:'saved-memory',goal:'确认完整范围',content:'先核对范围再计算总数',review:'approved'};
let pending={...base,candidateId:'pending',itemId:'pending-memory',goal:'待审核经验',content:'记录命令退出码',review:'pending'};
const use={useId:'receipt',workspaceKey:workspace,source:{kind:'reviewed-reference',candidateId:'saved',contentVersion:1},itemId:'saved-memory',itemVersion:1,contentHash:'hash',taskId:'task',taskVersion:1,sessionId:'session',runId:'run',referenceHash:'frozen',referenceContent:'历史实际引用内容',delivery:'carried',historical:false,managementRevision:1,settingsVersion:1,deletionRevision:0,adoption:'unknown',validation:'unknown',validationScope:'unknown',excluded:false,deleted:false,sources:[],createdAt:1,updatedAt:1};
const writes=[],drafts=[];let refreshes=0;
const detail=candidate=>({learningVersion:2,candidate,observations:[],reuse:[]});
const actions={
 queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:workspace,revision:1,items:[saved,pending],reuse:[]}),
 detailTaskExperience:async(_,id)=>detail(id==='pending'?pending:saved),
 reviewTaskExperience:async(_,request)=>{writes.push(request);pending={...pending,review:'approved',recordRevision:5,enabled:true};return pending;},
 feedbackTaskExperience:async()=>saved,
 queryExperienceUses:async()=>({uses:[use],diagnostics:[]}),
 refreshMemory:async()=>{refreshes++},
 updateMemoryItem:async(id,version,patch)=>{writes.push({id,version,patch});return {...ordinary,...patch,version:version+1}},
};
let runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:true,actions,data:{...previewData,workspacePath:workspace,trusted:true,memory:{...previewData.memory,workspacePath:workspace,status:'ready',items:[ordinary,globalItem,archived],pageInfo:undefined}}};
const root=createRoot(document.getElementById('app'));let scope='workspace';
const onDraft=editing=>drafts.push(editing);
const mount=()=>act(async()=>root.render(<PicoTheme><MemoryRouter><MemoryPage runtime={runtime} embedded scopeFilter={scope} onDraftStateChange={onDraft}/></MemoryRouter></PicoTheme>));
const click=async(label)=>{const node=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===label||n.getAttribute('aria-label')===label);check(node,'missing button '+label);await act(async()=>node.click())};
const tab=async(id)=>act(async()=>document.getElementById('memory-tab-'+id).click());
const row=async(content)=>{const node=[...document.querySelectorAll('.task-experience__row')].find(n=>n.textContent.includes(content));check(node,'missing row '+content);await act(async()=>node.click())};
const input=async(label,value)=>{const node=[...document.querySelectorAll('input,textarea')].find(n=>n.getAttribute('aria-label')===label||[...(n.labels||[])].some(l=>l.textContent===label));check(node,'missing input '+label);await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))})};
(async()=>{
 await mount();
 check(!document.querySelector('#memory-page-title')&&![...document.querySelectorAll('a')].some(n=>n.textContent.includes('用户级记忆设置')),'embedded view repeats page title or settings link');
 check(document.querySelectorAll('[role=tab]').length===4&&document.getElementById('memory-tab-saved').getAttribute('aria-selected')==='true','four tabs start on saved');
 check(document.querySelectorAll('.task-experience__list').length===1&&document.querySelector('.task-experience__list').textContent.includes(ordinary.content)&&document.querySelector('.task-experience__list').textContent.includes(saved.goal),'ordinary and experience share a list');
 check(!document.body.textContent.includes(globalItem.content)&&!document.querySelector('.task-experience__usage'),'workspace filters global memory and keeps usage out of content tab');
 check(!document.querySelector('.memory-content__preview').open,'recall preview starts collapsed');
 await row(ordinary.content);await click('更正 '+ordinary.content);await input('记忆内容','编辑中的项目约定');
 check(drafts.at(-1)===true,'ordinary correction reports active draft');
 await tab('usage');check(document.getElementById('memory-panel-saved')&&document.querySelector('textarea').value==='编辑中的项目约定','tab switch cannot discard an editor');
 await click('取消');check(drafts.at(-1)===false,'cancel clears draft guard');
 await input('搜索记忆内容','确认完整');
 check(document.querySelector('.task-experience__list').textContent.includes(saved.goal)&&!document.querySelector('.task-experience__list').textContent.includes(ordinary.content),'search filters ordinary and experience rows together');
 await input('搜索记忆内容','');await row(saved.goal);await click('编辑并确认');
 check(drafts.at(-1)===true,'experience correction reports active draft');await click('取消更正');check(drafts.at(-1)===false,'experience cancel releases draft guard');
 await tab('pending');await row(pending.goal);await click('确认并启用');
 check(writes[0].candidateId==='pending'&&writes[0].expectedContentVersion===2&&writes[0].expectedRecordRevision===4,'review uses original version safeguards');
 await tab('archived');check(document.querySelector('.task-experience__list').textContent.includes(archived.content),'archive tab contains archived ordinary memory');
 await tab('usage');check(document.querySelector('.task-experience__usage')&&!document.querySelector('.task-experience__list'),'usage has its own panel');
 check(use.referenceContent==='历史实际引用内容'&&use.source.contentVersion===1,'review leaves original usage receipt unchanged');
 await tab('saved');scope='global';await mount();
 check(document.querySelector('.task-experience__list').textContent.includes(globalItem.content)&&!document.querySelector('.task-experience__list').textContent.includes(ordinary.content)&&!document.body.textContent.includes(saved.goal),'global scope excludes workspace memories and experience');
 scope='all';await mount();check(document.querySelector('.task-experience__list').textContent.includes(globalItem.content)&&document.querySelector('.task-experience__list').textContent.includes(ordinary.content),'all is limited to the current workspace result plus its global entries');
 await act(async()=>root.render(<PicoTheme><MemoryRouter key='summary' initialEntries={['/conversation?workspace=%2Fproject&session=active']}><TaskExperiencePanel mode='conversation' workspacePath={workspace} items={[pending]} reuse={[]} onDetail={async()=>detail(pending)} onReview={async()=>pending} onFeedback={async()=>pending}/></MemoryRouter></PicoTheme>));
 const management=[...document.querySelectorAll('a')].find(n=>n.textContent==='管理工作区记忆');
 check(management?.getAttribute('href')?.startsWith('/settings/memory?'),'conversation management opens memory inside settings');
 await act(async()=>management.click());check(sessionStorage.getItem('pico.settings-return-to')==='/conversation?workspace=%2Fproject&session=active','settings remembers exact conversation return route');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: embedded memory content'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: embedded memory content", result);
  },
);
