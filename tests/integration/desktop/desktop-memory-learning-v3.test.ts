import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";
import { memoryLearningV3Fixture } from "./memory-learning-v3-fixture.js";

const imports = `
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
import {TaskExperiencePanel} from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';
import {ExperienceUsagePanel} from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {useTaskExperience} from './apps/desktop/src/renderer/useTaskExperience.ts';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const button=label=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
const root=createRoot(document.getElementById('app'));
const wrap=child=><PicoTheme><MemoryRouter initialEntries={['/settings/memory?tab=saved']}>{child}</MemoryRouter></PicoTheme>;
const input=value=>{const node=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};
`;

test("v3 建议与案例无需批准，普通修订、明确决定和暂停锁分别生效", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(
    imports +
      memoryLearningV3Fixture +
      `
let current=method;const reviews=[];
const onReview=async request=>{reviews.push(request);current={...current,recordRevision:current.recordRevision+1,...(request.action==='disable'?{enabled:false}:request.action==='revise'?{content:request.content,contentVersion:current.contentVersion+1,usagePolicy:'suggestion',enabled:true}:request.action==='keep_case'?{representation:'case',usagePolicy:'case_only',enabled:false,state:'ready'}:request.action==='accept'?{usagePolicy:'suggestion',review:'approved',enabled:true}:request.action==='defer'?{review:'deferred'}:{})};return current};
const detail=async()=>({learningVersion:3,candidate:current,observations:[{observationId:'o',kind:'tool-result',summary:'实际结果：检查产物通过。',source}],reuse:[]});
const panel=(mode='memory',filter='saved')=><TaskExperiencePanel learningVersion={3} mode={mode} filter={filter} workspacePath='/project' sessionId='session' items={[current]} reuse={[]} onDetail={detail} onReview={onReview} onFeedback={async()=>current}/>;
(async()=>{
 current={...method,itemId:undefined,state:'working'};await act(async()=>root.render(wrap(panel('conversation'))));
 check(document.body.textContent.includes('正在整理，尚未保存')&&!document.body.textContent.includes('1 条可用建议'),'uncommitted candidate never claims saved');
 current=method;await act(async()=>root.render(wrap(panel('conversation'))));
 check(document.body.textContent.includes('1 条可用建议')&&!document.body.textContent.includes('1/2')&&!document.querySelector('[aria-label="任务经验审核卡片"]'),'low risk method is a usable suggestion without approval or promotion progress');
 current=taskCase;await act(async()=>root.render(wrap(panel('conversation'))));
 check(document.body.textContent.includes('保留 1 条任务案例')&&document.body.textContent.includes('尚不能推出通用方法')&&!document.querySelector('[aria-label="任务经验审核卡片"]'),'unknown cause stays case without a review request');
 current=method;await act(async()=>root.render(wrap(panel())));await act(async()=>document.querySelector('.task-experience__row').click());
 check(document.body.textContent.includes('实际引用 2 次')&&document.body.textContent.includes('范围 command'),'detail separates concrete evidence from approval');
 await act(async()=>button('编辑更正').click());await act(async()=>input('按新的限定线索检查结果。'));
 await act(async()=>{button('保存更正').click();button('保存更正').click()});
 check(reviews.length===2&&reviews[0].action==='disable'&&reviews[1].action==='revise'&&reviews[1].content==='按新的限定线索检查结果。','ordinary correction stops old version and submits revise once');
 current=blocked;await act(async()=>root.render(wrap(panel())));await act(async()=>document.querySelector('.task-experience__row').click());
 check(document.body.textContent.includes('已暂停')&&!button('重新启用建议')&&!button('恢复'),'corrected old content cannot show a restore action');
 current=decision;await act(async()=>root.render(wrap(panel('conversation'))));
 check(document.body.textContent.includes('将高影响操作作为默认做法')&&document.body.textContent.includes(decision.reviewReason)&&document.body.textContent.includes('实际结果：检查产物通过。'),'decision exposes concrete change, scope and source');
 check(reviews.length===2,'opening a decision does not submit anything');
 await act(async()=>button('稍后决定').click());check(reviews.at(-1).action==='defer','defer preserves undecided record');
 await act(async()=>button('保留为案例').click());check(reviews.at(-1).action==='keep_case'&&!reviews.some(review=>review.action==='reject'),'keeping case never deletes candidate');
 current={...decision,candidateId:'accept',recordRevision:10};await act(async()=>root.render(wrap(panel('conversation'))));
 await act(async()=>button('允许在所列范围使用').click());check(reviews.at(-1).action==='accept'&&current.validation==='unknown','approval permits scope without claiming validation');
 current={...taskCase,candidateId:'convert-case',recordRevision:20};await act(async()=>root.render(wrap(panel())));await act(async()=>document.querySelector('.task-experience__row').click());await act(async()=>button('编辑更正').click());
 const form=document.querySelector('.task-experience__editor [role="combobox"]');await act(async()=>form.click());await act(async()=>[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()==='保存为方法').click());
 await act(async()=>document.querySelector('.task-experience__editor button[type="submit"]').click());check(reviews.at(-1).action==='revise'&&reviews.at(-1).representation==='method','case becomes a method only through explicit edit choice');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: v3 decisions'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`,
  );
  assert.equal(result, "PASS: v3 decisions", result);
});

test(
  "v3 案例独立加载融合、类型筛选、会话真实回执去重与旧 Host 降级",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(
      imports +
        memoryLearningV3Fixture +
        `
const reads=[];let legacy=false;let latest;
const actions={queryTaskExperiences:async(path,options)=>{reads.push(options);return{learningVersion:legacy?2:3,workspaceKey:path,revision:1,items:options.representation==='case'?[taskCase]:[method],reuse:[],receipts:[receipt,receipt]}},queryExperienceUses:async()=>({experienceVersion:1,uses:[],diagnostics:[]}),detailTaskExperience:async(path,id)=>({learningVersion:3,candidate:id==='case'?taskCase:method,observations:[],reuse:[]}),reviewTaskExperience:async()=>method,feedbackTaskExperience:async()=>method,refreshMemory:async()=>{}};
const runtime=()=>({preview:false,connection:{kind:'ready'},taskExperienceSupported:true,memoryLearningVersion:legacy?2:3,experienceFeedbackSupported:false,executionLearningRevision:0,actions,data:{...previewData,workspacePath:'/project',trusted:true,memory:{...previewData.memory,workspacePath:'/project',status:'ready',items:[]}}});
function Hook(){latest=useTaskExperience(runtime(),{workspacePath:'/project',sessionId:'session'});return <TaskExperiencePanel learningVersion={latest.learningVersion} receipts={latest.receipts} mode='conversation' sessionId='session' items={[]} reuse={[]} onDetail={latest.onDetail} onReview={latest.onReview} onFeedback={latest.onFeedback}/>}
(async()=>{
 await act(async()=>root.render(wrap(<Hook/>)));
 check(reads.length===2&&reads.some(read=>read.representation==='case')&&latest.items.length===2,'case and method query independently and merge');
 check(document.querySelector('[aria-label="本会话最近保存"]').textContent.includes('已保存 2 条事实')&&!document.body.textContent.includes('4 条事实'),'committed receipts deduplicate operationId and remain session scoped');
 await act(async()=>root.render(wrap(<MemoryPage embedded runtime={runtime()}/>)));
 check(document.querySelectorAll('.task-experience__row').length===2,'saved memory board includes case without memory_item');
 const chooser=document.querySelector('.memory-content__search [role="combobox"]');check(chooser,'saved board exposes record type filter');
 await act(async()=>chooser.click());await act(async()=>[...document.querySelectorAll('[role="option"]')].find(node=>node.textContent.trim()==='案例').click());
 check(document.querySelectorAll('.task-experience__row').length===1&&document.querySelector('.task-experience__row').textContent.includes('一次偶然恢复'),'case filter uses independent candidate projection');
 legacy=true;reads.length=0;await act(async()=>root.render(wrap(<Hook/>)));
 check(reads.length===1&&!reads[0].representation&&latest.learningVersion===2,'legacy Host receives the original v2 query only');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: v3 case and receipts'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`,
    );
    assert.equal(result, "PASS: v3 case and receipts", result);
  },
);

test("v3 使用反馈绑定 useId 与内容版本，旧 Host 不显示新反馈", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(
    imports +
      memoryLearningV3Fixture +
      `
const calls=[];let version=3,current=use;
const render=()=>root.render(wrap(<ExperienceUsagePanel learningVersion={version} uses={[current]} workspacePath='/project' onDetail={async()=>({experienceVersion:1,use:current,effects:[]})} onFeedback={async request=>{calls.push(request);current={...current,updatedAt:current.updatedAt+1};return current}}/>));
(async()=>{
 await act(async()=>render());await act(async()=>{button('这条有用').click();button('这条有用').click()});
 check(calls.length===1&&calls[0].useId==='use-1'&&calls[0].expectedContentVersion===1&&calls[0].action==='helpful','helpful is deduplicated and bound to the actual delivery and content version');
 await act(async()=>button('纠正这条').click());
 check(calls.length===2&&calls[1].useId==='use-1'&&calls[1].action==='correct'&&button('纠正这条').disabled,'correction stops exact version immediately');
 version=2;await act(async()=>render());check(!button('这条有用')&&!button('纠正这条'),'legacy Host does not expose v3 feedback');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: v3 exact feedback'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`,
  );
  assert.equal(result, "PASS: v3 exact feedback", result);
});

test(
  "真实 renderer Runtime 仅在能力协商后发送 v3，旧 Host 保持严格原请求",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {useRuntimeStore} from './apps/desktop/src/renderer/runtime.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(v,m)=>{if(!v)throw Error(m)},ok=value=>({ok:true,value});let store,version=3;const calls=[];
${memoryLearningV3Fixture}
window.pico={runtime:new Proxy({},{get:(_,method)=>async params=>{
 if(method==='runtime.ping')return ok({picoHome:'/test',capabilities:['session-conversation-v1','workspace-memory-v1','memory-learning-v2','memory-experience-feedback-v1',...(version===3?['memory-learning-v3']:[])]});
 if(method==='workspace.list')return ok({workspaces:[{workspacePath:'/project',registered:true,mode:'folder'}]});
 if(method==='workspace.trustStatus')return ok({trusted:true});
 if(method==='workspace.status')return ok({workspacePath:'/project',registered:true,mode:'folder',schedulerStatus:'unknown',branch:'',capabilities:{foregroundRuns:true,fileHistory:true,isolatedWorktrees:false,branchMerge:false}});
 if(method==='session.list')return ok({sessions:[]});if(method==='runs.list')return ok({runs:[]});
 if(method==='memory.settings.get')return ok({settings:{enabled:true,autoExtract:true,recallEnabled:true,version:1}});
 if(method==='memory.list'){calls.push([method,params]);return ok({items:[]});}
 if(method==='memory.learning.query'){calls.push([method,params]);if(version===2&&Object.hasOwn(params,'learningVersion'))throw Error('old Host rejects version field');return ok({learningVersion:version,workspaceKey:'/project',revision:1,items:[],reuse:[]});}
 if(method==='memory.learning.detail'){calls.push([method,params]);return ok({learningVersion:version,candidate:method,observations:[],reuse:[]});}
 if(method==='memory.experience.query'){calls.push([method,params]);return ok({experienceVersion:1,uses:[],diagnostics:[]});}
 return {ok:false,error:{code:'METHOD_NOT_FOUND',message:method,retryable:false}};
}}),platform:{getLaunchAtLogin:async()=>ok(false)},lifecycle:{getBackgroundMode:async()=>ok(false)},onUnavailable:()=>()=>{},onRecovered:()=>()=>{}};
function Harness(){store=useRuntimeStore();return <p>{store.connection.kind}</p>}
const root=createRoot(document.getElementById('app'));
(async()=>{
 localStorage.clear();await act(async()=>root.render(<Harness/>));for(let i=0;i<30&&store.connection.kind!=='ready';i++)await act(async()=>new Promise(r=>setTimeout(r,20)));
 check(store.connection.kind==='ready'&&store.memoryLearningVersion===3,'v3 capability selected');
 await act(async()=>store.actions.selectWorkspace('/project'));check(store.data.workspacePath==='/project'&&store.data.trusted,'selected '+JSON.stringify([store.data.workspacePath,store.data.trusted,store.message]));await act(async()=>store.actions.queryTaskExperiences('/project',{representation:'case'}));
 check(calls.at(-1)[1].learningVersion===3&&calls.at(-1)[1].representation==='case','v3 query has negotiated version and case filter');
 await act(async()=>store.actions.queryExperienceUses('/project'));
 check(calls.at(-1)[1].learningVersion===3,'v3 usage query is versioned');
 version=2;await act(async()=>store.actions.reload());
 check(store.memoryLearningVersion===2,'old Host switches UI to v2');await act(async()=>store.actions.selectWorkspace('/project'));
 await act(async()=>store.actions.queryTaskExperiences('/project',{representation:'case'}));
 check(!Object.hasOwn(calls.at(-1)[1],'learningVersion')&&!Object.hasOwn(calls.at(-1)[1],'representation'),'old learning query receives original shape');
 await act(async()=>store.actions.queryExperienceUses('/project'));
 check(!Object.hasOwn(calls.at(-1)[1],'learningVersion'),'old usage query receives original shape');
 let denied=0;for(const request of [{action:'revise',candidateId:'method'},{action:'keep_case',candidateId:'method'}])try{await store.actions.reviewTaskExperience('/project',request)}catch{denied++}
 for(const action of ['helpful','correct'])try{await store.actions.feedbackExperienceUse('/project',{action,useId:'use-1'})}catch{denied++}
 check(denied===4,'old Host never receives new actions');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: runtime v3 negotiation'});
})().catch(async e=>fetch('/result',{method:'POST',body:'FAIL '+e.stack}));
`);
    assert.equal(result, "PASS: runtime v3 negotiation", result);
  },
);
