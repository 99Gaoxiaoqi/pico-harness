import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "经验管理真实跳转精确打开分页外归档目标，保留旧引用边界并说明删除与未知引用",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {HashRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
import {ExperienceUsagePanel} from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {WorkspaceRoute} from './apps/desktop/src/renderer/workspace-access.tsx';
import {RuntimeContext} from './apps/desktop/src/renderer/runtime-context.tsx';
import {RuntimeInvocationError} from './apps/desktop/src/renderer/runtime.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;const check=(v,m)=>{if(!v)throw new Error(m)};
const workspace='/private/tmp/中文 项目/# rate%20目录&step=1';
const candidate={kind:'task-lesson',candidateId:'lesson',itemId:'memory',workspaceKey:workspace,sessionId:'source',runId:'source-run',taskId:'source-task',taskVersion:1,contentVersion:2,recordRevision:4,goal:'最新归档经验',content:'最新正文 v2',review:'approved',validation:'unknown',enabled:false,lifecycleState:'archived',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
const use={useId:'use',workspaceKey:workspace,source:{kind:'reviewed-reference',candidateId:'lesson',contentVersion:1},itemId:'memory',itemVersion:3,contentHash:'hash',taskId:'task',taskVersion:1,sessionId:'session',runId:'run',referenceHash:'frozen',referenceContent:'冻结的引用 v1',delivery:'unknown',historical:false,managementRevision:1,settingsVersion:1,deletionRevision:0,adoption:'observed',validation:'pass',validationScope:'spreadsheet-range',excluded:false,deleted:false,sources:[],createdAt:1,updatedAt:1};
let reads=0,itemReads=0,pages=0,failOnce=true;const writes=[];
const detail=()=>({learningVersion:2,candidate,observations:[],reuse:[]});
const nativeItem={...previewData.memory.items[0],itemId:'native',version:7,kind:'failure',content:'分页外原生经验',scopeType:'workspace',statementType:'fact',temporalType:'undated',lifecycleState:'archived',origin:'agent_extracted',sources:[],sourceCount:0,createdAt:1,updatedAt:1,observedAt:1,eventStartedAt:null,eventEndedAt:null};
const actions={queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:workspace,revision:1,items:[],reuse:[]}),detailTaskExperience:async(_,id)=>{reads++;if(id==='missing')throw new RuntimeInvocationError('NOT_FOUND','gone',false);if(id==='retry'&&failOnce){failOnce=false;throw new Error('offline')}return detail()},reviewTaskExperience:async(_,input)=>{writes.push(input);return{...candidate,enabled:true,lifecycleState:'active',recordRevision:5}},feedbackTaskExperience:async()=>candidate,refreshMemory:async()=>{},getExperienceMemoryItem:async(_,id)=>{itemReads++;return id==='native'?nativeItem:undefined},loadMoreMemory:async()=>{pages++}};
const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:false,actions,data:{...previewData,workspacePath:workspace,trusted:true,workspaces:[{path:workspace,name:'项目',trusted:true}],memory:{...previewData.memory,workspacePath:workspace,status:'ready',items:[],pageInfo:{counts:{active:10,archived:5,total:15},nextCursor:'page-2',revision:1}}}};
function Probe(){const location=useLocation(),navigate=useNavigate();return <><p id='route'>{JSON.stringify(location)}</p><button id='missing' onClick={()=>navigate('/memory?'+new URLSearchParams({workspace,candidate:'missing',item:'missing',tab:'saved'}))}>missing</button><button id='native' onClick={()=>navigate('/memory?'+new URLSearchParams({workspace,item:'native',tab:'saved'}))}>native</button><button id='retry' onClick={()=>navigate('/memory?'+new URLSearchParams({workspace,candidate:'retry',item:'memory',tab:'saved'}))}>retry</button><button id='back' onClick={()=>navigate('/conversation')}>back</button></>}
const root=createRoot(document.getElementById('app'));
(async()=>{window.location.hash='/conversation';await act(async()=>root.render(<PicoTheme><RuntimeContext.Provider value={runtime}><HashRouter><Routes><Route path='/conversation' element={<ExperienceUsagePanel uses={[use]} workspacePath={workspace} onDetail={async()=>({experienceVersion:1,use,effects:[{effectId:'effect',adoption:'observed',validation:'pass',validationScope:'spreadsheet-range',reason:'独立执行已通过',preparedEventId:'prepared',outcomeEventId:'outcome',sources:[]}]})} onFeedback={async()=>use}/>}/><Route path='/memory' element={<WorkspaceRoute><MemoryPage runtime={runtime} forceNarrow/></WorkspaceRoute>}/></Routes><Probe/></HashRouter></RuntimeContext.Provider></PicoTheme>));
check(document.body.textContent.includes('引用未确认')&&!document.body.textContent.includes('旧记录，注入时序不完整'),'new unknown delivery is never historical');
check(document.body.textContent.includes('不能归因于这条经验')&&!document.querySelector('[data-use-id]').textContent.includes('本次结果：验证通过'),'uncertain carry never attributes independent pass');
await act(async()=>[...document.querySelectorAll('button')].find(n=>n.textContent==='查看使用详情').click());
check(document.body.textContent.includes('独立执行结果：验证通过'),'independent outcome remains inspectable');
await act(async()=>document.querySelector('[data-use-id] a').click());
let route=JSON.parse(document.querySelector('#route').textContent),params=new URLSearchParams(route.search);
check(params.get('workspace')===workspace&&params.get('candidate')==='lesson'&&params.get('item')==='memory'&&params.get('tab')==='archived'&&route.hash==='#memory-memory','stable target, workspace and anchor survive lifecycle redirect');
check(reads===1&&itemReads===0&&pages===0,'precise candidate detail is read once without page scans');
check(document.querySelector('[data-candidate-id=lesson]')&&document.body.textContent.includes('最新正文 v2'),'actual management detail opens outside list');
check(document.body.textContent.includes('引用内容 v1')&&document.body.textContent.includes('当前管理内容 v2')&&document.body.textContent.includes('旧使用记录保持原版本'),'old receipt and current editor boundaries visible');
await act(async()=>[...document.querySelectorAll('button')].find(n=>n.textContent==='恢复').click());
check(writes[0].expectedContentVersion===2&&writes[0].expectedRecordRevision===4,'writes target latest management version');
params=new URLSearchParams(JSON.parse(document.querySelector('#route').textContent).search);check(params.get('tab')==='saved','restoring exact target follows its new active management state');
await act(async()=>document.querySelector('#missing').click());
check(document.body.textContent.includes('该经验已删除或不可用')&&!document.querySelector('[data-candidate-id=lesson]')&&pages===0,'missing target cannot silently display stale target or scan pages');
await act(async()=>document.querySelector('#native').click());
params=new URLSearchParams(JSON.parse(document.querySelector('#route').textContent).search);
check(itemReads===1&&params.get('tab')==='archived'&&document.getElementById('memory-native').textContent.includes('分页外原生经验')&&pages===0,'item-only target uses one exact get and current archive tab');
await act(async()=>document.querySelector('#retry').click());
check(document.body.textContent.includes('无法读取链接目标')&&!document.body.textContent.includes('该经验已删除或不可用'),'read error is distinct from deletion');
await act(async()=>[...document.querySelectorAll('button')].find(n=>n.textContent==='重试打开目标').click());
check(document.querySelector('[data-candidate-id=lesson]'),'explicit retry opens precise target');
await act(async()=>document.querySelector('#back').click());
check(document.querySelector('[data-use-id] > .task-experience__content').textContent==='冻结的引用 v1'&&use.validation==='pass','management leaves frozen receipt and independent outcome unchanged');
await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: precise experience navigation'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: precise experience navigation", result);
  },
);

test(
  "旧引用冲突跳转保留工作区，路由目标不覆盖更正草稿且迟到详情被隔离",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {HashRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
import {TaskExperiencePanel} from './apps/desktop/src/renderer/TaskExperiencePanel.tsx';import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {RuntimeContext} from './apps/desktop/src/renderer/runtime-context.tsx';import {WorkspaceRoute} from './apps/desktop/src/renderer/workspace-access.tsx';
import {RuntimeInvocationError} from './apps/desktop/src/renderer/runtime.ts';import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';import {previewData} from './apps/desktop/src/renderer/fixture.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;const check=(v,m)=>{if(!v)throw new Error(m)};
const workspace='/project';let candidate={kind:'task-lesson',candidateId:'lesson',itemId:'memory',workspaceKey:workspace,sessionId:'source',runId:'source-run',taskId:'task',taskVersion:1,contentVersion:2,recordRevision:3,goal:'当前经验',content:'最新管理正文',review:'approved',validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
const other={...candidate,candidateId:'other',itemId:'other-memory',goal:'另一个目标',content:'其他正文'};
const reuse={reuseId:'reuse',workspaceKey:workspace,candidateId:'lesson',contentVersion:1,itemId:'memory',itemVersion:1,taskId:'task',taskVersion:1,sessionId:'session',runId:'run',referenceHash:'frozen',referenceContent:'历史正文',adoption:'unknown',validation:'unknown',excluded:false,sources:[],createdAt:1,updatedAt:1};
let lateResolve,reads=0;const late=new Promise(resolve=>{lateResolve=resolve});
const detail=value=>({learningVersion:2,candidate:value,observations:[],reuse:[]});
const actions={queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:workspace,revision:1,items:[candidate],reuse:[]}),detailTaskExperience:async(_,id)=>{reads++;return id==='late'?late:detail(id==='other'?other:candidate)},reviewTaskExperience:async()=>candidate,feedbackTaskExperience:async()=>{throw new RuntimeInvocationError('CONFLICT','changed',false)},refreshMemory:async()=>{}};
const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:false,actions,data:{...previewData,workspacePath:workspace,trusted:true,workspaces:[{path:workspace,name:'项目',trusted:true}],memory:{...previewData.memory,workspacePath:workspace,status:'ready',items:[],pageInfo:undefined}}};
function Probe(){const location=useLocation(),navigate=useNavigate();const to=id=>'/memory?'+new URLSearchParams({workspace,candidate:id,item:id==='other'?'other-memory':'memory',tab:'saved'});return <><p id='route'>{JSON.stringify(location)}</p><button id='same' onClick={()=>navigate(to('lesson'))}>same</button><button id='other' onClick={()=>navigate(to('other'))}>other</button><button id='late' onClick={()=>navigate(to('late'))}>late</button></>}
const root=createRoot(document.getElementById('app'));const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent===label);
(async()=>{window.location.hash='/conversation?workspace='+encodeURIComponent(workspace);await act(async()=>root.render(<PicoTheme><RuntimeContext.Provider value={runtime}><HashRouter><Routes><Route path='/conversation' element={<TaskExperiencePanel mode='conversation' showSummary={false} sessionId='session' workspacePath={workspace} items={[candidate]} reuse={[reuse]} onDetail={async()=>detail(candidate)} onReview={async()=>candidate} onFeedback={async()=>{throw new RuntimeInvocationError('CONFLICT','changed',false)}}/>}/><Route path='/memory' element={<WorkspaceRoute><MemoryPage runtime={runtime} forceNarrow/></WorkspaceRoute>}/></Routes><Probe/></HashRouter></RuntimeContext.Provider></PicoTheme>));
await act(async()=>button('本次不适用').click());await act(async()=>[...document.querySelectorAll('a')].find(n=>n.textContent==='管理最新经验').click());
let params=new URLSearchParams(JSON.parse(document.querySelector('#route').textContent).search);
check(params.get('workspace')===workspace&&params.get('tab')==='saved'&&params.get('candidate')==='lesson'&&!document.querySelector('.workspace-picker'),'old conflict returns directly to correct workspace and target');
await act(async()=>button('编辑并确认').click());const editor=document.querySelector('textarea');
await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,'不可覆盖的草稿');editor.dispatchEvent(new Event('input',{bubbles:true}));});
candidate={...candidate,recordRevision:4,contentVersion:3,content:'其他客户端的新正文'};
await act(async()=>document.querySelector('#same').click());
check(document.querySelector('textarea')===editor&&editor.value==='不可覆盖的草稿'&&button('保存更正并启用').disabled,'same candidate navigation updates revision but preserves editor identity and conflict draft');
await act(async()=>document.querySelector('#late').click());await act(async()=>document.querySelector('#other').click());
check(document.querySelector('textarea')===editor&&editor.value==='不可覆盖的草稿'&&document.body.textContent.includes('已找到链接目标')&&button('打开链接目标').disabled,'different target waits while current correction draft exists');
await act(async()=>{lateResolve(detail({...candidate,candidateId:'late',content:'迟到的错误详情',recordRevision:99}));await Promise.resolve();});
check(editor.value==='不可覆盖的草稿'&&!document.body.textContent.includes('迟到的错误详情'),'late target cannot replace active target or draft');
await act(async()=>button('取消更正').click());check(!button('打开链接目标').disabled,'ending correction enables explicit target switch');
await act(async()=>button('打开链接目标').click());
check(document.querySelector('[data-candidate-id=other]')&&!document.querySelector('textarea'),'explicit switch opens resolved target after correction ends');
check(reuse.referenceContent==='历史正文'&&reuse.contentVersion===1,'legacy reference remains frozen');
await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: protected legacy navigation'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: protected legacy navigation", result);
  },
);
