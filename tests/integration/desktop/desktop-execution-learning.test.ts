import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("统一审核保留原生历史管理，旧入口不读取或计数内部候选", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import {act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(v,m)=>{if(!v)throw new Error(m)};
let candidate={kind:'task-lesson',candidateId:'lesson',workspaceKey:'/project',sessionId:'source',runId:'source-run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'统一审核提案',content:'执行前先检查条件。',review:'pending',validation:'unknown',enabled:false,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'coding',toolNames:['shell'],conditions:[]}};
let saved={...previewData.memory.items[0],itemId:'native-saved',sourceType:'execution-validated',content:'历史保存的执行经验',scopeType:'workspace',scopeKey:'/project',lifecycleState:'active',version:1,sources:[],taskAcceptance:{targetLabel:'node --test test/main.test.js',claimHash:'claim-hash',scopeHash:'scope-hash'}};
const native={kind:'execution-candidate',candidateId:'native-internal',content:'隐藏的原生候选',review:'pending',state:'waiting',targetLabel:'隐藏的原生候选'};
const use={useId:'historic-use',workspaceKey:'/project',itemId:'native-saved',itemVersion:1,source:{kind:'execution-validated',candidateId:'native-internal',claimRevision:1,claimHash:'claim-hash',scopeHash:'scope-hash'},referenceContent:'历史引用内容',referenceHash:'hash',delivery:'carried',adoption:'observed',validation:'pass',validationScope:'native-claim',excluded:false,historical:false,managementRevision:1,deletionRevision:0,sources:[],createdAt:1,updatedAt:1};
let nativeCalls=0,detailCalls=0,rerender;const updates=[];
const actions={
 refreshMemory:async()=>{},
 queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:'/project',revision:candidate.recordRevision,items:[candidate,native],reuse:[]}),
 detailTaskExperience:async()=>{detailCalls++;return{learningVersion:2,candidate,observations:[],reuse:[]}},
 reviewTaskExperience:async(_,input)=>{candidate={...candidate,review:'approved',enabled:true,recordRevision:2};return candidate},
 feedbackTaskExperience:async()=>candidate,
 listExecutionLearning:async()=>{nativeCalls++;return{workspaceKey:'/project',revision:1,items:[native]}},
 inspectExecutionLearning:async()=>{nativeCalls++;throw new Error('must not inspect internal candidates')},
 discardExecutionLearning:async()=>{nativeCalls++},
 getExperienceMemoryItem:async()=>saved,
 updateMemoryItem:async(id,version,patch)=>{updates.push([id,version,patch]);saved={...saved,...patch,version:version+1};rerender();return saved},
 deleteMemoryItem:async(id,version)=>{updates.push([id,version,'delete']);saved=undefined;rerender();return true},
 queryExperienceUses:async()=>({experienceVersion:1,uses:[use],diagnostics:[]}),
 detailExperienceUse:async()=>({experienceVersion:1,use,effects:[]}),
 feedbackExperienceUse:async()=>({use}),
};
function Host(){const[,tick]=useState(0);rerender=()=>tick(n=>n+1);const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:true,actions,data:{...previewData,workspacePath:'/project',trusted:true,memory:{...previewData.memory,workspacePath:'/project',status:'ready',items:saved?[saved]:[],pageInfo:undefined,settings:{...previewData.memory.settings,enabled:false,recallEnabled:false,autoExtract:false}}}};return <MemoryPage runtime={runtime} forceNarrow/>}
function Navigation(){const navigate=useNavigate(),location=useLocation();return <><p id='route'>{location.search}</p><button id='native-link' onClick={()=>navigate('/memory?tab=native&candidate=native-internal')}>native link</button><button id='saved-link' onClick={()=>navigate('/memory?tab=native&candidate=native-internal&item=native-saved')}>saved link</button></>}
const root=createRoot(document.getElementById('app'));const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(n=>n.textContent===label);
const click=async(selector)=>act(async()=>document.querySelector(selector).click());
(async()=>{
 await act(async()=>root.render(<PicoTheme><MemoryRouter initialEntries={['/memory?tab=pending']}><Host/><Navigation/></MemoryRouter></PicoTheme>));
 check(document.querySelectorAll('[role=tab]').length===3&&document.querySelector('#memory-tab-pending .memory-tab__count').textContent==='1','one common review queue counts only generic proposals');
 check(!text().includes('隐藏的原生候选')&&nativeCalls===0,'no internal candidate is displayed, counted or requested');
 check(text().includes('自动学习已关闭')&&text().includes('记忆召回已关闭'),'disabled settings preserve review and history');
 await click('.task-experience__row');
 check(text().includes('审核：待审核')&&text().includes('历史验证：尚未验证'),'review does not imply validation');
 await act(async()=>button('确认并启用').click());
 check(candidate.review==='approved'&&candidate.validation==='unknown','confirmation leaves unvalidated evidence unknown');
 await click('#native-link');
 check(document.querySelector('#memory-tab-saved').getAttribute('aria-selected')==='true'&&text().includes('原生学习入口已合并'),'old native tab directs to shared saved management');
 check(!text().includes('该经验已删除或不可用')&&detailCalls===1&&nativeCalls===0,'old candidate link does not imply deletion or invoke native detail');
 await click('#saved-link');
 check(document.getElementById('memory-native-saved')&&document.querySelector('#route').textContent.includes('tab=saved'),'saved native link opens exact shared memory');
 check(text().includes('仅限定目标验收通过')&&text().includes('这项验收不等于根因或全文已验证'),'saved history retains bounded acceptance');
 const record=document.querySelector('[data-use-id="historic-use"]');
 check(record&&record.textContent.includes('冻结的原生执行目标')&&record.textContent.includes('不代表经验正文、根因或整个任务已验证'),'shared history shows the exact verification boundary');
 await act(async()=>document.querySelector('#memory-native-saved button[aria-label^="归档"]').click());
 check(saved.lifecycleState==='archived'&&document.querySelector('#memory-tab-archived').getAttribute('aria-selected')==='true','archive stays available for historical native memory');
 window.confirm=()=>true;
 await act(async()=>document.querySelector('#memory-native-saved button[aria-label^="删除"]').click());
 check(!saved&&updates.length===2&&document.querySelector('[data-use-id="historic-use"]'),'deleting saved memory preserves usage history');
 check(nativeCalls===0,'management uses no retired candidate RPC');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: unified experience management'});
})().catch(async e=>fetch('/result',{method:'POST',body:'FAIL: '+e.stack}));
`);
  assert.equal(result, "PASS: unified experience management", result);
  // The real conversation page shares the generic summary and ledger without native RPC bindings.
  const conversation = await readFile(
    "apps/desktop/src/renderer/pages/ConversationPage.tsx",
    "utf8",
  );
  const runtime = await readFile("apps/desktop/src/renderer/runtime.ts", "utf8");
  assert.match(conversation, /TaskExperiencePanel/u);
  assert.match(conversation, /ExperienceUsagePanel/u);
  assert.doesNotMatch(conversation, /ExecutionLearningPanel|useExecutionLearning/u);
  assert.doesNotMatch(runtime, /"memory\.learning\.(?:list|inspect|discard)"/u);
});
