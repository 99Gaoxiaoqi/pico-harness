import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "旧执行经验在记忆页、预览和旧链接不可见，历史追踪仅留移除或更新提示",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';
import {MemoryRouter,useNavigate} from 'react-router-dom';
import {MemoryPage} from './apps/desktop/src/renderer/MemoryPage.tsx';
import {RuntimeInvocationError} from './apps/desktop/src/renderer/runtime.ts';
import {ExecutionTraceTimeline} from './apps/desktop/src/renderer/workbar-panels/ExecutionTraceTimeline.tsx';
import {previewData} from './apps/desktop/src/renderer/fixture.ts';
import {PicoTheme} from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;const check=(value,message)=>{if(!value)throw new Error(message)};
const workspace='/project';
const base={...previewData.memory.items[0],scopeType:'workspace',scopeKey:workspace,sources:[]};
const legacy={...base,itemId:'legacy',sourceType:'execution-evidence',content:'LEGACY_SAVED_BODY',lifecycleState:'active'};
const edited={...base,itemId:'edited-legacy',sourceType:'manual',executionEvidence:{candidateId:'old-candidate',verificationCount:3},content:'LEGACY_EDITED_BODY',lifecycleState:'archived'};
const previewOnlyEdited={...edited,itemId:'unloaded-legacy',content:'LEGACY_UNLOADED_BODY'};
const native={...base,itemId:'native',sourceType:'execution-validated',content:'当前原生执行方案',taskAcceptance:{targetLabel:'BuildCheck',claimHash:'native-claim',scopeHash:'native-scope'}};
const reviewed={kind:'task-lesson',candidateId:'reviewed',itemId:'reviewed-item',workspaceKey:workspace,sessionId:'source',runId:'source-run',taskId:'task',taskVersion:1,contentVersion:1,recordRevision:1,goal:'当前审核经验',content:'经用户确认的任务方法',review:'approved',validation:'unknown',enabled:true,lifecycleState:'active',state:'saved',sources:[],applicability:{taskFamily:'general',toolNames:[],conditions:[]}};
const reference=(item,source=item.sourceType)=>({itemId:item.itemId,content:item.content,source,excerpt:false,range:{start:0,end:item.content.length,total:item.content.length},match:'content'});
let exactReads=0;
const actions={refreshMemory:async()=>{},queryTaskExperiences:async()=>({learningVersion:2,workspaceKey:workspace,revision:1,items:[reviewed],reuse:[]}),detailTaskExperience:async()=>({learningVersion:2,candidate:reviewed,observations:[],reuse:[]}),reviewTaskExperience:async()=>reviewed,feedbackTaskExperience:async()=>reviewed,listExecutionLearning:async()=>({workspaceKey:workspace,revision:1,items:[{candidateId:'native-pending',revision:1,workspaceKey:workspace,sessionId:'source',runId:'source-run',state:'waiting',predicateId:'test-target-pass.v1',targetId:'test-target',targetLabel:'当前原生验收候选',updatedAt:1,sources:[]}]}),getExperienceMemoryItem:async(_,id)=>{exactReads++;if(id==='retired')throw new RuntimeInvocationError('NOT_FOUND','旧版经验已移除',false);return id==='legacy'?legacy:id==='edited-legacy'?edited:undefined},queryMemoryContext:async()=>({items:[legacy,edited,native,previewOnlyEdited],references:[reference(legacy),reference(edited),reference(native),reference(previewOnlyEdited)],diagnostics:[legacy,edited,native].map(item=>({itemId:item.itemId,reason:'selected',match:'content'})),budget:{maxItems:3,maxTokens:320,usedItems:3,usedTokens:90,truncated:false}})};
const runtime={preview:false,connection:{kind:'ready'},taskExperienceSupported:true,experienceFeedbackSupported:false,actions,data:{...previewData,workspacePath:workspace,trusted:true,memory:{...previewData.memory,workspacePath:workspace,status:'ready',items:[legacy,edited,native],pageInfo:{counts:{active:2,archived:1,total:3},revision:1}}}};
function Navigation(){const navigate=useNavigate();return <><button id='legacy-link' onClick={()=>navigate('/memory?item=legacy&tab=saved')}>legacy link</button><button id='edited-link' onClick={()=>navigate('/memory?item=edited-legacy&tab=archived')}>edited link</button><button id='retired-link' onClick={()=>navigate('/memory?item=retired&tab=saved')}>retired link</button><button id='removed-link' onClick={()=>navigate('/memory?item=removed&tab=saved')}>removed link</button></>}
const root=createRoot(document.getElementById('app'));const text=()=>document.body.textContent;
const click=async(selector)=>{await act(async()=>document.querySelector(selector).click())};
(async()=>{
 await act(async()=>root.render(<PicoTheme><MemoryRouter initialEntries={['/memory?tab=saved']}><MemoryPage runtime={runtime} forceNarrow/><Navigation/></MemoryRouter></PicoTheme>));
 check(!text().includes('LEGACY_')&&!document.getElementById('memory-legacy')&&!document.getElementById('memory-edited-legacy'),'saved and manually edited legacy records never appear');
 check(text().includes('当前原生执行方案')&&text().includes('当前审核经验')&&text().includes('当前原生验收候选'),'both current sources and native candidate panel remain available');
 check(document.querySelector('#memory-tab-saved .memory-tab__count').textContent==='2'&&document.querySelector('#memory-tab-archived .memory-tab__count').textContent==='0','old Host list counts exclude loaded legacy entries');
 await click('#memory-tab-archived');check(!text().includes('LEGACY_')&&!document.getElementById('memory-edited-legacy'),'archived tab cannot expose manually edited legacy record');
 const input=document.querySelector('input[type=search]');await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'BuildCheck');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>[...document.querySelectorAll('button')].find(node=>node.textContent==='查询召回').click());
 const preview=document.querySelector('[aria-label="召回预览结果"]');check(preview&&!preview.textContent.includes('LEGACY_')&&!preview.textContent.includes('edited-legacy')&&!preview.textContent.includes('legacy：'),'preview removes old excerpts and diagnostics, including edited-source metadata');
 check(preview.textContent.includes('显示 1 条可用引用')&&preview.textContent.includes('当前原生执行方案'),'preview does not count retired references or hide native references');
 await click('#legacy-link');check(exactReads===1&&text().includes('旧版经验不可用，请更新电脑端完成清理。')&&!text().includes('LEGACY_')&&!text().includes('旧版经验已移除'),'old Host deep link is unavailable without claiming deletion');
 await click('#edited-link');check(exactReads===2&&!text().includes('LEGACY_')&&!document.getElementById('memory-edited-legacy'),'edited old deep link cannot restore the archived body');
 await click('#removed-link');check(exactReads===3&&text().includes('该经验已删除或不可用')&&!text().includes('LEGACY_'),'missing old deep link stays unavailable without stale content');
 await click('#retired-link');check(exactReads===4&&text().includes('旧版经验已移除')&&!text().includes('LEGACY_'),'Host-confirmed retirement keeps its precise missing-item message');
 const source=(eventId)=>({sessionId:'source',runId:'source-run',turnId:'turn',eventId});
 const selected=(id,kind)=>({itemId:id,itemVersion:1,contentHash:id+'-hash',referenceHash:id+'-reference',range:{start:0,end:10,total:10},excerpt:false,match:'content',source:kind,sourceCount:1,sources:[source(id+'-source')]});
 const memory={trace:{version:1,mode:'automatic',workspaceKey:workspace,queryHash:'query',outcome:'selected',stages:{exact:0,prefix:0,content:3,compound:0,candidates:3},budget:{maxItems:3,maxTokens:320,usedItems:3,usedTokens:90,truncated:false},counts:{selected:3,duplicate:0,budget:0,item_limit:0},selected:[selected('retired-trace','execution-evidence'),selected('old-host-trace','execution-evidence'),selected('native-trace','execution-validated')],diagnostics:[],elapsedMs:1,traceTruncated:false,omittedDiagnosticCount:0,omittedSourceCount:0},items:[{itemId:'retired-trace',state:'deleted',linkAvailable:false},{itemId:'old-host-trace',state:'unchanged',linkAvailable:true},{itemId:'native-trace',state:'unchanged',linkAvailable:true}],sources:['retired-trace','old-host-trace','native-trace'].map(id=>({...source(id+'-source'),available:true})),requests:[{attemptId:'attempt',evidenceLevel:'response_observed',referencePresentCount:3,referenceCount:3,blockPresent:true}]};
 const execution={schemaVersion:1,sessionId:'session',summary:{scope:'session',modelCalls:0,failedCalls:0,meteredCalls:0,unpricedCalls:0,inputTokens:0,outputTokens:0,costCNY:0},coverage:{modelAttempts:'physical',oversizedRunIds:[],missingModelCallRunIds:[],incompleteRunIds:[]},runs:[{runId:'run',invocationId:'invocation',at:'2026-10-13T00:00:00Z',status:'completed',steps:[{id:'recall',eventId:'recall',turnId:'turn',kind:'memory',title:'记忆召回',at:'2026-10-13T00:00:00Z',status:'completed',memory}]}]};
 await act(async()=>root.render(<PicoTheme><ExecutionTraceTimeline execution={execution} selectedTraceId='recall' onSelectTrace={()=>{}}/></PicoTheme>));
 const trace=document.querySelector('[aria-label="记忆召回诊断"]');check(trace&&trace.textContent.includes('旧版经验已移除')&&trace.textContent.includes('旧版经验不可用，请更新电脑端完成清理。'),'execution inspector distinguishes migrated deletion from old Host unavailability');
 check(!trace.textContent.includes('retired-trace')&&!trace.textContent.includes('old-host-trace')&&!trace.textContent.includes('execution-evidence')&&!trace.textContent.includes('3/3'),'legacy trace has no source, hash, link or reference count');
 check(trace.textContent.includes('显示 1 条召回记录')&&trace.textContent.includes('native-trace')&&trace.querySelector('a[href*="native-trace"]'),'native trace and management link remain available');
 await act(async()=>root.unmount());await fetch('/result',{method:'POST',body:'PASS: legacy experience retirement'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: legacy experience retirement", result);
  },
);
