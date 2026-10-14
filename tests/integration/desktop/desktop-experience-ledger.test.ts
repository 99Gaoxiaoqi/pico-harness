import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "经验使用账本保留两类来源，旧经验仅占位且反馈不重复或纠正旧版本",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ExperienceUsagePanel } from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import { useExperienceLedger } from './apps/desktop/src/renderer/useExperienceLedger.ts';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
import { RuntimeInvocationError } from './apps/desktop/src/renderer/runtime.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const source={sessionId:'source-session',runId:'source-run',turnId:'turn',eventId:'failure-event'};
const base={workspaceKey:'/project',itemId:'memory',itemVersion:3,contentHash:'hash',taskId:'task',taskVersion:2,sessionId:'current-session',runId:'current-run',referenceHash:'frozen-reference',referenceContent:'冻结的旧引用内容',delivery:'carried',historical:false,managementRevision:1,settingsVersion:1,deletionRevision:0,adoption:'unknown',validation:'unknown',validationScope:'unknown',excluded:false,deleted:false,sources:[source],createdAt:1,updatedAt:1};
const reviewed={...base,useId:'reviewed',source:{kind:'reviewed-reference',candidateId:'lesson',contentVersion:1},delivery:'pending'};
const native={...base,useId:'native',itemId:'native-item',source:{kind:'execution-validated',candidateId:'native-candidate',claimRevision:2,claimHash:'claim',scopeHash:'scope'},validation:'pass',validationScope:'native-claim',adoption:'observed',deliverySequence:8};
const legacy={...base,useId:'legacy',source:{kind:'execution-evidence',candidateId:'legacy-candidate',candidateVersion:1,contentHash:'old'},delivery:'unknown',historical:true,validation:'pass',deleted:true};
const oldHost={...legacy,useId:'old-host',deleted:false,delivery:'carried',historical:false};
let failure=true,pendingResolve;const calls=[];
const onFeedback=async input=>{calls.push(input);if(failure){failure=false;throw new Error('uncertain write')}return new Promise(resolve=>{pendingResolve=()=>resolve({...native,managementRevision:2,updatedAt:2,excluded:true})})};
const onDetail=async id=>({experienceVersion:1,use:id==='native'?native:reviewed,effects:[{effectId:'effect',useId:id,preparedEventId:'prepared-7',outcomeEventId:'outcome-9',preparedSequence:7,outcomeSequence:9,adoption:'observed',validation:'pass',validationScope:'native-claim',reason:'固定目标自然验收通过',sources:[source],trustedContradiction:false,createdAt:2}]});
const diagnostics=[{diagnosticId:'diagnostic',workspaceKey:'/project',sessionId:'current-session',runId:'current-run',phase:'effect',reason:'experience_validation_unavailable',createdAt:1}];
const root=createRoot(document.getElementById('app'));
const render=()=>root.render(<PicoTheme><MemoryRouter><ExperienceUsagePanel uses={[reviewed,native,legacy,oldHost]} diagnostics={diagnostics} workspacePath='/project' onDetail={onDetail} onFeedback={onFeedback}/></MemoryRouter></PicoTheme>);
const card=id=>document.querySelector('[data-use-id="'+id+'"]');
const button=(id,label)=>[...card(id).querySelectorAll('button')].find(node=>node.textContent===label);
(async()=>{
 await act(async()=>render());
 const diagnosis=document.querySelector('[aria-label="最近记录诊断"]');
 check(diagnosis&&!diagnosis.open&&diagnosis.textContent.includes('执行核对')&&diagnosis.textContent.includes('这次执行核对未能完成')&&!document.querySelector('[role=alert]'),'historical diagnosis is collapsed and never presented as current outage');
 const summary=document.querySelector('summary').textContent;
 check(summary.includes('1 条已引用')&&summary.includes('1 条待注入')&&!summary.includes('条旧记录'),'delivery counts never promote pending or historical records');
 check(card('reviewed').textContent.includes('待注入')&&card('reviewed').textContent.includes('用户确认：已确认此版本'),'review confirmation is independent of delivery');
 check(card('native').textContent.includes('保存时验收：限定执行目标通过')&&card('native').textContent.includes('采用：已观察到采用要点')&&card('native').textContent.includes('本次结果：验证通过'),'native saved acceptance, adoption and current outcome are distinct');
 check(card('legacy').textContent==='旧版经验已移除'&&!card('legacy').querySelector('button,a'),'removed legacy use has no body, provenance, results or actions');
 check(card('old-host').textContent==='旧版经验不可用，请更新电脑端完成清理。'&&!card('old-host').querySelector('button,a'),'old Host response never claims deletion or exposes reference content');
 check(!document.body.textContent.includes('纠正经验'),'ledger feedback only excludes or stops references');
 const params=new URLSearchParams(new URL(card('native').querySelector('a').href).search);
 check(params.get('workspace')==='/project'&&params.get('tab')==='saved','management retains workspace and tab');
 await act(async()=>button('native','查看使用详情').click());
 check(card('native').textContent.includes('prepared-7（7）')&&card('native').textContent.includes('outcome-9（9）')&&card('native').textContent.includes('failure-event'),'trusted effect provenance is visible');
 await act(async()=>button('native','本次不适用').click());
 check(calls.length===1&&card('native').textContent.includes('反馈未保存'),'uncertain write stays retryable');
 await act(async()=>{button('native','重试').click();button('native','重试').click();});
 check(calls.length===2&&calls[0].operationId===calls[1].operationId&&calls[1].expectedItemVersion===3,'sync double click sends one retry and retains expected version and operation identity');
 await act(async()=>{pendingResolve();await Promise.resolve();});
 check(card('native').textContent.includes('其他任务仍可使用')&&card('native').textContent.includes('冻结的旧引用内容'),'exclusion retains original receipt content');
 await act(async()=>button('native','归档并停止引用').click());
 check(calls.at(-1).action==='disable','supported sources retain the unified stop action');
 await act(async()=>{pendingResolve();await Promise.resolve();});
 check(button('native','归档并停止引用').disabled&&card('native').textContent.includes('已归档并停止引用'),'successful native stop is visibly archived and cannot repeat');
 let managementReads=0;
 const runtime={preview:false,connection:{kind:'ready'},experienceFeedbackSupported:true,data:{workspacePath:'/project',trusted:true},actions:{queryExperienceUses:async()=>({experienceVersion:1,diagnostics:[],uses:[native]}),detailExperienceUse:onDetail,feedbackExperienceUse:async()=>({experienceVersion:1,use:native}),getExperienceMemoryItem:async()=>{managementReads++;return{itemId:'native-item',version:4,lifecycleState:'archived'}}}};
 function Reopen(){const ledger=useExperienceLedger(runtime,{workspacePath:'/project'});return <ExperienceUsagePanel uses={ledger.uses} workspacePath='/project' onDetail={ledger.onDetail} onFeedback={ledger.onFeedback}/>}
 await act(async()=>root.render(<PicoTheme><MemoryRouter><Reopen/></MemoryRouter></PicoTheme>));
 check(managementReads===0,'list does not read every memory item');
 await act(async()=>button('native','查看使用详情').click());
 check(managementReads===1&&button('native','归档并停止引用').disabled&&card('native').textContent.includes('当前管理记忆版本：v4')&&card('native').textContent.includes('本次使用记录保持记忆版本 v3'),'explicit reopen reads archive management state without mutating frozen version');
 await act(async()=>root.unmount());
 await fetch('/result',{method:'POST',body:'PASS: unified experience ledger'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: unified experience ledger", result);
  },
);

test("经验读取与反馈隔离 A→B→A 旧请求，旧 Host 不调用新接口", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTaskExperience } from './apps/desktop/src/renderer/useTaskExperience.ts';
import { useExperienceLedger } from './apps/desktop/src/renderer/useExperienceLedger.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const deferred=()=>{let resolve;const promise=new Promise(ok=>resolve=ok);return{promise,resolve}};
const oldQuery=deferred(),oldReview=deferred(),oldUse=deferred(),oldFeedback=deferred();
let aQueries=0,feedbackState='';const rejected=[];
const lesson=(content,recordRevision)=>({kind:'task-lesson',candidateId:'lesson',content,recordRevision,contentVersion:1});
const use=(content,revision)=>({useId:'use',referenceContent:content,managementRevision:revision,deletionRevision:0,updatedAt:revision});
const actions={queryTaskExperiences:async path=>{if(path==='/a'&&++aQueries===1)return oldQuery.promise;return{learningVersion:2,workspaceKey:path,revision:2,items:[lesson(path+' new',2)],reuse:[]}},detailTaskExperience:async()=>({}),reviewTaskExperience:async()=>oldReview.promise,feedbackTaskExperience:async()=>{},queryExperienceUses:async path=>{if(path==='/a'&&aQueries===1)return oldUse.promise;return{experienceVersion:1,diagnostics:[],uses:[use(path+' new',2)]}},detailExperienceUse:async()=>({}),feedbackExperienceUse:async()=>oldFeedback.promise};
const make=(path,supported=true)=>({preview:false,connection:{kind:'ready'},taskExperienceSupported:supported,experienceFeedbackSupported:supported,executionLearningRevision:0,actions,data:{workspacePath:path,trusted:true,memory:{settings:{version:1}}}});
function Host({runtime}){const input={workspacePath:runtime.data.workspacePath};const task=useTaskExperience(runtime,input),ledger=useExperienceLedger(runtime,input);return <><p id='task'>{task.items.map(value=>value.content).join()}</p><p id='ledger'>{ledger.uses.map(value=>value.referenceContent).join()}</p><p id='feedback'>{feedbackState}</p><button id='review' onClick={()=>void task.onReview({}).catch(()=>rejected.push('task'))}>review</button><button id='feedback' onClick={()=>void ledger.onFeedback({}).catch(()=>rejected.push('use'))}>feedback</button></>}
const root=createRoot(document.getElementById('app'));
(async()=>{
 await act(async()=>root.render(<Host runtime={make('/a')}/>));
 await act(async()=>{document.querySelector('#review').click();document.querySelector('button#feedback').click();});
 await act(async()=>root.render(<Host runtime={make('/b')}/>));
 await act(async()=>root.render(<Host runtime={make('/a')}/>));
 check(document.querySelector('#task').textContent==='/a new'&&document.querySelector('#ledger').textContent==='/a new','new A projection loads');
 await act(async()=>{oldQuery.resolve({learningVersion:2,workspaceKey:'/a',revision:99,items:[lesson('STALE QUERY',99)],reuse:[]});oldUse.resolve({experienceVersion:1,diagnostics:[],uses:[use('STALE USE',99)]});oldReview.resolve(lesson('STALE REVIEW',99));oldFeedback.resolve({experienceVersion:1,use:use('STALE FEEDBACK',99)});await Promise.resolve();});
 check(document.querySelector('#task').textContent==='/a new'&&document.querySelector('#ledger').textContent==='/a new'&&rejected.includes('task')&&rejected.includes('use'),'old A generation cannot return after route roundtrip');
 const before=aQueries;
 await act(async()=>root.render(<Host runtime={make('/legacy',false)}/>));
 check(aQueries===before&&!document.querySelector('#ledger').textContent&&!document.querySelector('#task').textContent,'legacy capability suppresses newer methods');
 await act(async()=>root.unmount());
 await fetch('/result',{method:'POST',body:'PASS: experience generation'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
  assert.equal(result, "PASS: experience generation", result);
});

test("样式层声明最先导入，记忆标签计数只作用于专属节点", async () => {
  const main = await readFile(
    new URL("../../../apps/desktop/src/renderer/main.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../../../apps/desktop/src/renderer/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(main, /^import "\.\/layers\.css";/u);
  assert.doesNotMatch(styles, /\.memory-tablist button span/u);
  assert.match(styles, /\.memory-tab__count/u);
});

test(
  "通用审核隐藏原生候选，观察不计建议，工作区选择保留审核路由与锚点",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import './apps/desktop/src/renderer/layers.css';
import './apps/desktop/src/renderer/styles.css';
import './apps/desktop/src/renderer/astryx-controls.css';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { MemoryPage } from './apps/desktop/src/renderer/MemoryPage.tsx';
import { TaskExperiencePanel } from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import { WorkspaceRoute } from './apps/desktop/src/renderer/workspace-access.tsx';
import { RuntimeContext } from './apps/desktop/src/renderer/runtime-context.tsx';
import { UserMemorySettingsPage } from './apps/desktop/src/renderer/pages/UserMemorySettingsPage.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
import { previewData } from './apps/desktop/src/renderer/fixture.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
let nativeCalls=0;const discarded=[];
const native={candidateId:'native',revision:1,workspaceKey:'/a',sessionId:'session',runId:'run',state:'waiting',predicateId:'test-target-pass.v1',targetId:'target',targetLabel:'原生目标',sources:[],updatedAt:1};
const lesson={kind:'task-lesson',candidateId:'lesson',workspaceKey:'/a',sessionId:'session',runId:'run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'通用建议',content:'需要确认范围',review:'pending',validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
const observation={...lesson,candidateId:'raw',goal:'未形成的观察',content:'',review:'unneeded',state:'invalidated'};
const actions={queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:'/a',revision:1,items:[lesson,observation],reuse:[]}),detailTaskExperience:async()=>({learningVersion:2,candidate:lesson,observations:[],reuse:[]}),reviewTaskExperience:async()=>lesson,feedbackTaskExperience:async()=>lesson,refreshMemory:async()=>{},listExecutionLearning:async()=>{nativeCalls++;return{workspaceKey:'/a',revision:1,items:[native]}},inspectExecutionLearning:async()=>({reason:'真实原生候选详情'}),discardExecutionLearning:async(_,id,revision)=>discarded.push([id,revision]),chooseWorkspace:async()=>'/b',selectWorkspace:async()=>{},loadUserMemorySettings:async()=>{},queryMemoryMetrics:async()=>undefined};
const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:false,actions,data:{...previewData,workspacePath:'/a',trusted:true,workspaces:[{path:'/a',name:'项目A',trusted:true},{path:'/b',name:'项目B',trusted:true}],memory:{...previewData.memory,workspacePath:'/a',status:'ready',items:[],pageInfo:undefined,settings:{...previewData.memory.settings,autoExtract:false}}}};
const root=createRoot(document.getElementById('app'));
const wrap=child=><PicoTheme><RuntimeContext.Provider value={runtime}><MemoryRouter initialEntries={['/memory?tab=pending&context=keep#anchor']}>{child}</MemoryRouter></RuntimeContext.Provider></PicoTheme>;
function Probe(){const location=useLocation();return <p id='route'>{location.pathname+location.search+location.hash}</p>}
(async()=>{
 await act(async()=>root.render(wrap(<MemoryPage runtime={runtime} forceNarrow/>)));
 check(nativeCalls===0&&!document.querySelector('[data-candidate-id=native]')&&discarded.length===0,'generic management neither reads nor exposes internal native candidates');
 check(document.querySelector('#memory-tab-pending .memory-tab__count').textContent==='1','raw observation is not counted as pending suggestion');
 const tab=document.querySelector('#memory-tab-pending'),count=tab.querySelector('.memory-tab__count');
 check(count.getBoundingClientRect().width>=22&&getComputedStyle(tab).color!==getComputedStyle(tab).backgroundColor,'tabs and counts retain visible computed styles');
 check(document.body.textContent.includes('工具权限、附件和执行范围')&&document.body.textContent.includes('空结果不代表经验未保存'),'preview describes scope and zero result limits');
 await act(async()=>root.render(wrap(<TaskExperiencePanel mode='conversation' workspacePath='/a' sessionId='session' items={[observation]} reuse={[]} onDetail={async()=>({})} onReview={async()=>lesson} onFeedback={async()=>lesson}/>)));
 check(document.body.textContent.includes('未形成经验建议')&&!document.querySelector('a'),'raw only summary has no review CTA');
 await act(async()=>root.render(wrap(<TaskExperiencePanel mode='conversation' workspacePath='/a' sessionId='session' items={[lesson]} reuse={[]} onDetail={async()=>({})} onReview={async()=>lesson} onFeedback={async()=>lesson}/>)));
 let link=document.querySelector('a'),params=new URLSearchParams(new URL(link.href).search);
 check(params.get('workspace')==='/a'&&params.get('tab')==='pending'&&link.textContent==='审核任务经验','summary review CTA retains workspace and intended tab');
 await act(async()=>root.render(wrap(<><WorkspaceRoute><p>content</p></WorkspaceRoute><Probe/></>)));
 const projectLink=document.querySelector('.workspace-picker__item');params=new URLSearchParams(new URL(projectLink.href).search);
 check(params.get('tab')==='pending'&&params.get('context')==='keep'&&params.get('workspace')==='/a'&&projectLink.hash==='#anchor','project selection preserves query and hash');
 await act(async()=>[...document.querySelectorAll('button')].find(node=>node.textContent==='添加项目文件夹').click());
 const route=document.querySelector('#route').textContent;params=new URLSearchParams(route.split('?')[1].split('#')[0]);
 check(params.get('tab')==='pending'&&params.get('context')==='keep'&&params.get('workspace')==='/b'&&route.endsWith('#anchor'),'adding workspace preserves query and hash');
 await act(async()=>root.render(wrap(<UserMemorySettingsPage/>)));
 check(document.body.textContent.includes('关闭只停止新提案')&&document.body.textContent.includes('历史引用、效果记录和经验管理仍可继续')&&document.body.textContent.includes('管理范围'),'settings explain independent automatic learning gate');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: experience management routes'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: experience management routes", result);
  },
);

test(
  "HashRouter真实点击保留工作区、标签与独立锚点，引用卡显示正文并保留原始证据",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, useLocation } from 'react-router-dom';
import { ExperienceUsagePanel } from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import { TaskExperiencePanel } from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const workspacePath='/private/tmp/中文 项目/# rate%20目录&step=1';
const raw='<memory kind="failure" source="reviewed-reference" range="0-40/40">按 B2:B4 求和：18 &amp; 20 &lt; 30。字面量 &amp;lt; 保留。</memory>';
const use={useId:'use-hash',workspaceKey:'scope',source:{kind:'reviewed-reference',candidateId:'lesson',contentVersion:1},itemId:'memory-id',itemVersion:1,contentHash:'content',taskId:'task',taskVersion:1,sessionId:'session',runId:'engine-run',hostRunId:'desktop-run',referenceHash:'raw-hash',referenceContent:raw,delivery:'carried',historical:false,managementRevision:1,settingsVersion:1,deletionRevision:0,adoption:'unknown',validation:'unknown',validationScope:'unknown',excluded:false,deleted:false,sources:[],createdAt:1,updatedAt:1};
const lesson={kind:'task-lesson',candidateId:'lesson',workspaceKey:'scope',sessionId:'session',runId:'desktop-run',content:'建议',goal:'求和',review:'pending',contentVersion:1,recordRevision:1,validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
const root=createRoot(document.getElementById('app'));
function Probe(){const location=useLocation();return <p id='location'>{JSON.stringify(location)}</p>}
const onDetail=async()=>({experienceVersion:1,use,effects:[]});
(async()=>{
 window.location.hash='/memory?workspace='+encodeURIComponent(workspacePath);
 await act(async()=>root.render(<PicoTheme><HashRouter><ExperienceUsagePanel uses={[use]} workspacePath={workspacePath} onDetail={onDetail} onFeedback={async()=>use}/><Probe/></HashRouter></PicoTheme>));
 const link=document.querySelector('[data-use-id] a');
 await act(async()=>link.click());
 let location=JSON.parse(document.querySelector('#location').textContent),params=new URLSearchParams(location.search);
 check(params.get('workspace')===workspacePath&&params.get('tab')==='saved'&&location.hash==='#memory-memory-id','real HashRouter click must preserve decoded workspace and saved tab independently from anchor: '+JSON.stringify(location));
 const content=document.querySelector('[data-use-id] > .task-experience__content');
 check(content.textContent==='按 B2:B4 求和：18 & 20 < 30。字面量 &lt; 保留。'&&!content.textContent.includes('<memory'),'primary card displays a one-pass decoded outer-memory body');
 const detailButton=[...document.querySelectorAll('button')].find(node=>node.textContent==='查看使用详情');
 await act(async()=>detailButton.click());
 check(document.querySelector('.experience-use__raw-reference').textContent===raw&&!document.querySelector('.experience-use__raw-reference memory'),'raw receipt stays exact inert evidence in detail');
 check(document.querySelector('[data-use-id]').textContent.includes('raw-hash'),'reference hash is unchanged');
 await act(async()=>root.render(<PicoTheme><HashRouter><TaskExperiencePanel mode='conversation' workspacePath={workspacePath} sessionId='session' items={[lesson]} reuse={[]} onDetail={async()=>({})} onReview={async()=>lesson} onFeedback={async()=>lesson}/><Probe/></HashRouter></PicoTheme>));
 await act(async()=>document.querySelector('.task-experience__summary a').click());
 location=JSON.parse(document.querySelector('#location').textContent);params=new URLSearchParams(location.search);
 check(params.get('workspace')===workspacePath&&params.get('tab')==='pending'&&!location.hash,'summary review link also preserves HashRouter workspace and tab');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: HashRouter experience links'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: HashRouter experience links", result);
  },
);
