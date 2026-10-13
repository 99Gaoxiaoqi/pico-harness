import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test(
  "新任务切换已有项目或打开文件夹时移交附件与错误，合并目标草稿且不重复",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ConversationPage } from './apps/desktop/src/renderer/pages/ConversationPage.tsx';
import { RuntimeContext } from './apps/desktop/src/renderer/runtime-context.tsx';
import { previewData } from './apps/desktop/src/renderer/fixture.ts';
import { newSessionHref } from './apps/desktop/src/renderer/workspace-session.ts';
import { readPersistentDraft } from './apps/desktop/src/renderer/conversation/usePersistentDraft.ts';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const sends = [];
let route, failure, mounts = 0, folderChoices = 0;
const project = '/fixture', folder = '/chosen-folder';
const data = {...previewData,picoHome:'/fixture-home',workspacePath:project,trusted:true,
  workspaces:[{path:project,name:'Existing project',mode:'git',registered:true,trusted:true},{path:folder,name:'Chosen folder',mode:'git',registered:true,trusted:true}],
  sessions:[],runs:[],timeline:[],approvals:[],prompts:[],conversations:{},providerRetries:{},
  modelRoutes:[{id:'test/a',label:'test/a'}],providerConfig:{...previewData.providerConfig,defaultModelRouteId:'test/a',userDefaults:{modelRouteId:'test/a'},providers:[{id:'test',origin:'user',protocol:'openai',baseURL:'https://fixture.invalid',models:['a']}]}};
const noop = async () => undefined;
const runtime = {data,preview:false,busy:false,pendingSends:[],actions:new Proxy({
  ensureTemporaryWorkspace:async()=>'/fixture-temp',
  chooseWorkspace:async()=>{folderChoices++;data.workspacePath=folder;return folder;},
  sendMessage:async input=>{
    sends.push(input);
    if(failure){const message=failure;failure=undefined;return {succeeded:false,fileError:{file:input.files[0],message}};}
    return {succeeded:true};
  },
},{get:(target,key)=>target[key]??noop})};
function RouteObserver(){const location=useLocation();route=location.pathname+location.search;return null;}
const root=createRoot(document.getElementById('app'));
const mount=async path=>act(async()=>root.render(<PicoTheme><RuntimeContext value={runtime}><MemoryRouter key={++mounts} initialEntries={[path]}><RouteObserver/><Routes><Route path='/task/new' element={<ConversationPage/>}/></Routes></MemoryRouter></RuntimeContext></PicoTheme>));
const editor=()=>document.querySelector('[contenteditable=true]');
const cards=()=>[...document.querySelectorAll('.conversation-composer__file')];
const type=async text=>act(async()=>{editor().focus();document.execCommand('insertText',false,text);});
const pick=async file=>act(async()=>{const input=document.querySelector('input[type=file]');check(input&&!input.disabled,'file picker enabled');const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
const submit=async()=>act(async()=>{const button=document.querySelector('button[aria-label="发送消息"]');check(button&&!button.disabled,'send enabled at '+route+' after '+sends.length+' sends: '+document.body.textContent);button.click();});
const selectProject=async label=>{
  await act(async()=>{const field=document.querySelector('[name=workspace]');check(field,'project field');const button=field.tagName==='BUTTON'?field:field.closest('.astryx-field')?.querySelector('[role=combobox]')??field.parentElement.querySelector('[role=combobox]');check(button,'project selector');button.click();});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  await act(async()=>{const option=[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===label);check(option,'project option '+label);option.click();});
};
(async()=>{
  localStorage.clear();
  const targetFile=new File(['target content'],'target.txt');
  const sourceFile=new File(['source content'],'source.txt');
  await mount(newSessionHref(project));
  await type('Existing target draft');await pick(targetFile);
  failure='target upload failed';await submit();
  await mount('/task/new');
  await type('Source draft');await pick(sourceFile);
  failure='source upload failed';await submit();
  await selectProject('Existing project');
  check(route===newSessionHref(project),'existing project route');
  const merged='Existing target draft\\n\\nSource draft';
  check(readPersistentDraft('new:'+project)===merged&&editor().textContent.includes('Existing target draft')&&editor().textContent.includes('Source draft'),'target and source text retained');
  check(cards().length===2&&cards()[0].textContent.includes('target.txt')&&cards()[1].textContent.includes('source.txt'),'target and source attachments retained in order');
  check(cards()[0].textContent.includes('target upload failed')&&cards()[1].textContent.includes('source upload failed'),'both upload errors retained');
  await mount('/task/new');
  check(cards().length===0&&editor().textContent==='','source draft consumed');
  await mount(newSessionHref(project));
  await selectProject('无项目');
  await selectProject('Existing project');
  check(cards().length===2&&readPersistentDraft('new:'+project)===merged,'round trip does not duplicate files or text');
  await submit();
  const sent=sends.at(-1);
  check(sent.workspacePath===project&&sent.text===merged&&sent.files.length===2,'merged draft sends to selected project');
  check(sent.files[0]===targetFile&&sent.files[1]===sourceFile&&await sent.files[1].text()==='source content','original File objects and bytes retained');
  check(cards().length===0&&editor().textContent==='','successful send consumes merged draft');

  await mount('/task/new');
  const onlyFile=new File(['file only content'],'only.txt');
  await pick(onlyFile);failure='file only upload failed';await submit();
  await selectProject('打开项目文件夹…');
  check(folderChoices===1&&route===newSessionHref(folder),'folder picker switches project');
  check(cards().length===1&&cards()[0].textContent.includes('file only upload failed')&&editor().textContent==='','file-only draft and error survive folder selection');
  await submit();
  check(sends.at(-1).workspacePath===folder&&sends.at(-1).text===''&&sends.at(-1).files[0]===onlyFile,'file-only draft sends original file to chosen folder');
  await mount('/task/new');
  check(cards().length===0,'file-only source is consumed');
  await act(async()=>root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: project file drafts'});
})().catch(error=>fetch('/result',{method:'POST',body:'FAIL: '+error.stack}));
`);
    assert.equal(result, "PASS: project file drafts", result);
  },
);

test(
  "桌面附件选择、粘贴、拖放经分块上传发送，失败保留会话与草稿",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useRuntimeStore } from './apps/desktop/src/renderer/runtime.ts';
import { ConversationComposer } from './apps/desktop/src/renderer/conversation/ConversationComposer.tsx';
import { useFileDraft } from './apps/desktop/src/renderer/conversation/useFileDraft.ts';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const check = (value, message) => { if (!value) throw new Error(message); };
let store, draft, setSource, setDisabledReason, setStatus, sending, lastResult;
let source = 'new:/project', failUpload = false, holdSend, loseReply = false;
let creates = 0, begins = 0, aborted = 0, ledger = 0;
const ingests = new Map(), commits = [], sends = [], settings = [], pendingRecords = [], chunkSizes = [];
const defaults = {modelRouteId:'configured/model',collaborationMode:'plan',orchestrationMode:'default',permissionMode:'auto',thinkingEffort:'high'};
window.pico = {
  runtime: new Proxy({}, {get: (_target, method) => async params => {
    if (method === 'runtime.ping') return {ok:true,value:{picoHome:'/home/test',capabilities:['session-conversation-v1','session-send-replay-v1']}};
    if (method === 'workspace.list') return {ok:true,value:{workspaces:[]}};
    if (method === 'session.create') return {ok:true,value:{session:{sessionId:'created-'+(++creates)}}};
    if (method === 'session.settings.update') { settings.push(params); return {ok:true,value:{}}; }
    if (method === 'session.artifacts.query') return {ok:true,value:{revision:ledger}};
    if (method === 'session.artifacts.command') {
      if (params.action === 'begin') {
        check(params.expectedRevision===ledger,'begin reads current revision');
        const ingestId='ingest-'+(++begins); ingests.set(ingestId,{params,bytes:[]});
        return {ok:true,value:{ingestId,artifactId:'artifact-'+begins,revision:ledger}};
      }
      if (params.action === 'abort') { aborted++; ingests.delete(params.ingestId); return {ok:true,value:{}}; }
      const ingest=ingests.get(params.ingestId);
      check(ingest && ingest.params.sessionId===params.sessionId,'chunks remain bound to session');
      if (params.action === 'append') {
        if (failUpload) { failUpload=false; return {ok:false,error:{code:'CONFLICT',message:'upload interrupted',retryable:false}}; }
        const bytes=[...atob(params.contentBase64)].map(c=>c.charCodeAt(0));
        check(bytes.length<=32768 && params.offsetBytes===ingest.bytes.length,'chunk size and offset');
        chunkSizes.push(bytes.length); ingest.bytes.push(...bytes);
        return {ok:true,value:{acceptedBytes:bytes.length,nextOffsetBytes:ingest.bytes.length}};
      }
      if (params.action === 'commit') {
        check(params.expectedRevision===ledger,'commit refreshes revision');
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(ingest.bytes)))].map(n=>n.toString(16).padStart(2,'0')).join('');
        check(params.expectedSizeBytes===ingest.bytes.length && params.expectedDigest===digest,'host receives exact size and SHA-256');
        const artifact={artifactId:'artifact-'+commits.length,digest};
        commits.push({...artifact,title:ingest.params.title,mimeType:ingest.params.mimeType,bytes:ingest.bytes});
        ingests.delete(params.ingestId); ledger++;
        return {ok:true,value:{artifact,revision:ledger}};
      }
    }
    if (method === 'session.send') {
      sends.push(params);
      pendingRecords.push([...Array(localStorage.length)].map((_,i)=>localStorage.key(i)).filter(k=>k.startsWith('pico.pending-send:')).map(k=>localStorage.getItem(k)).join(''));
      if (loseReply) { loseReply=false; return {ok:false,error:{code:'RUNTIME_REQUEST_TIMEOUT',message:'reply lost',retryable:false,outcome:'unknown'}}; }
      if (holdSend) await holdSend;
      return {ok:true,value:{session:{sessionId:params.sessionId}}};
    }
    return {ok:false,error:{code:'NOT_FOUND',message:'not needed by this scenario',retryable:false}};
  }}),
  platform:{getLaunchAtLogin:async()=>({ok:true,value:false})},
  lifecycle:{getBackgroundMode:async()=>({ok:true,value:false})},
  onUnavailable:()=>()=>{},onRecovered:()=>()=>{},
  events:{subscribe:()=>({ready:Promise.resolve({ok:false,error:{code:'NOT_FOUND',message:'unused',retryable:false}}),dispose(){}})},
  sessionFrames:{subscribe:()=>({dispose(){}})},
};
function Harness(){
  store=useRuntimeStore();
  const [key,changeSource]=React.useState(source);
  const [disabledReason,changeDisabled]=React.useState();
  const [status,changeStatus]=React.useState('idle');
  const [text,setText]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  setSource=changeSource;setDisabledReason=changeDisabled;setStatus=changeStatus;
  draft=useFileDraft(key);
  const submit=async(value)=>{
    const snapshot=draft.files, controls=draft;
    setBusy(true);
    lastResult=await store.actions.sendMessage({workspacePath:'/project',sourceKey:key,text:value.text,files:snapshot.map(item=>item.file),initialSettings:defaults,behavior:value.behavior});
    if(lastResult.succeeded) controls.clearSent(snapshot);
    if(lastResult.fileError) controls.setError(lastResult.fileError.file,lastResult.fileError.message);
    setBusy(false);
  };
  return <PicoTheme><ConversationComposer value={text} onValueChange={setText} onSubmit={value=>{sending=submit(value);}}
    status={status} busy={busy} files={draft.files} fileValidationErrors={draft.validationErrors} onFilesAdd={draft.add} onFileRemove={draft.remove}
    filesDisabledReason={disabledReason}/></PicoTheme>;
}
const root=createRoot(document.getElementById('app'));
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
const input=()=>document.querySelector('input[type=file]');
const form=()=>document.querySelector('form');
const cards=()=>document.querySelectorAll('.conversation-composer__file');
const transfer=(files)=>{const dt=new DataTransfer();for(const file of files)dt.items.add(file);return dt;};
const pick=async(files)=>act(async()=>{input().files=transfer(files).files;input().dispatchEvent(new Event('change',{bubbles:true}));});
const submit=async()=>{await act(async()=>{form().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await act(async()=>await sending);};
(async()=>{
  localStorage.clear();
  await act(async()=>root.render(<Harness/>));
  for(let i=0;i<30&&store.connection.kind!=='ready';i++)await settle();
  check(store.connection.kind==='ready','runtime bootstraps');
  check([...document.querySelectorAll('button')].some(b=>b.textContent.includes('添加文件')),'explicit file entry');
  const code=new File(['const marker = "UPLOAD_CONTENT";\\n'.repeat(2300)],'sample.ts',{type:''});
  const png=new File([new Uint8Array([137,80,78,71,13,10,26,10])],'picture.png',{type:'image/png'});
  await pick([code,new File(['pdf bytes'],'notes.pdf',{type:'application/pdf'})]);
  await act(async()=>form().dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer([png]),bubbles:true,cancelable:true})));
  await act(async()=>form().dispatchEvent(new DragEvent('drop',{dataTransfer:transfer([new File(['docx bytes'],'report.docx'),new File(['xlsx bytes'],'table.xlsx')]),bubbles:true,cancelable:true})));
  check(cards().length===5,'picker paste and drop share file drafts');
  check([...cards()].some(card=>card.textContent.includes('sample.ts')&&card.textContent.includes('KiB')),'name and size');
  await act(async()=>setSource('another-session'));
  check(cards().length===0,'route switch isolates files');
  await pick([new File(['separate'],'separate.txt')]);
  await act(async()=>setSource('new:/project'));
  check(cards().length===5,'route switch restores in-memory draft');
  await act(async()=>setDisabledReason('当前模式暂不支持附件'));
  check(input().disabled && document.querySelector('button[type=submit]').disabled,'unsupported modes cannot lose files');
  await act(async()=>setDisabledReason(undefined));
  await submit();
  check(lastResult.succeeded&&sends.length===1&&cards().length===0,'file-only message uploads and clears sent files');
  check(creates===1&&settings[0].modelRouteId===defaults.modelRouteId&&settings[0].thinkingEffort==='high'&&settings[0].permissionMode==='auto','new session preserves explicit settings');
  check(sends[0].sessionId==='created-1'&&!('initialSettings' in sends[0]),'send targets prepared session without reapplying initial settings');
  check(sends[0].input.text===''&&sends[0].input.attachments.length===5,'file-only input retains every artifact');
  check(sends[0].input.attachments.every(a=>a.type==='artifact'&&a.artifactId&&/^[a-f0-9]{64}$/.test(a.digest)),'only artifact references sent');
  check(chunkSizes.filter(n=>n===32768).length>=2,'large code file split into 32 KiB chunks');
  check(commits.map(c=>c.mimeType).includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')&&commits.map(c=>c.mimeType).includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),'Office MIME normalized');
  check(pendingRecords[0].includes('artifactId')&&!pendingRecords[0].includes('contentBase64')&&!pendingRecords[0].includes('UPLOAD_CONTENT'),'durable pending send has references and no file body');
  // Critical failure: abort partial upload, preserve the File and reuse the already-created session.
  await act(async()=>setSource('failed-upload'));
  await pick([new File(['retry content'],'retry.txt')]);
  failUpload=true;await submit();
  check(!lastResult.succeeded&&cards().length===1&&document.querySelector('[role=alert]').textContent.includes('upload interrupted'),'upload error shown without losing draft');
  check(aborted===1&&creates===2&&sends.length===1,'failure aborts ingest before session.send');
  let release;holdSend=new Promise(resolve=>{release=resolve;});
  await act(async()=>form().dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  for(let i=0;i<30&&sends.length<2;i++)await settle();
  check(input().disabled&&document.querySelector('button[aria-label="移除附件 retry.txt"]').disabled,'sending disables file edits');
  await act(async()=>draft.add([new File(['later draft'],'later.txt')]));
  await act(async()=>{release();await sending;});holdSend=undefined;
  check(lastResult.succeeded&&creates===2&&sends[1].sessionId==='created-2','retry uses same session');
  check(cards().length===1&&cards()[0].textContent.includes('later.txt'),'late-added draft file survives acknowledgement');
  await act(async()=>setStatus('running'));
  check(document.querySelector('button[type=submit]').getAttribute('aria-label')==='将消息排到下一轮','attachments queue during active run');
  await act(async()=>document.querySelector('button[aria-label="移除附件 later.txt"]').click());
  await pick([new File([new Uint8Array(10*1024*1024+1)],'large.png',{type:'image/png'})]);
  check(document.querySelector('[role=alert]').textContent.includes('10 MiB')&&document.querySelector('button[type=submit]').disabled,'oversized image is actionable and cannot send');
  await act(async()=>{setSource('recover-upload');setStatus('idle');});
  await pick([new File(['recover content'],'recover.txt')]);
  loseReply=true;await submit();
  check(!lastResult.succeeded&&store.pendingSends.length===1&&cards().length===1,'lost reply keeps artifact request and draft');
  const original=sends.at(-1);
  await act(async()=>draft.add([new File(['unsent'],'unsent.txt')]));
  await act(async()=>store.actions.recoverPendingSend('recover-upload'));
  check(sends.at(-1).replayOnly&&JSON.stringify(sends.at(-1).input)===JSON.stringify(original.input),'recovery replays references without uploading again');
  check(cards().length===1&&cards()[0].textContent.includes('unsent.txt'),'recovery clears only the original attachment snapshot');
  const beforeCreates=creates;
  await submit();
  check(lastResult.succeeded&&creates===beforeCreates+1,'recovered new-task preparation does not leak into the next task');
  await act(async()=>root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: desktop file upload'});
})().catch(async error=>{await fetch('/result',{method:'POST',body:'FAIL: '+error.stack});});
`);
    assert.equal(result, "PASS: desktop file upload", result);
  },
);

test(
  "历史附件链接使用当前会话的打开与另存桥接，并阻止丢失附件的编辑",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationTranscript } from './apps/desktop/src/renderer/conversation/ConversationTranscript.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message);};
const calls=[];
window.pico={artifacts:{open:async ref=>{calls.push(['open',ref]);return {ok:true,value:undefined};},saveAs:async ref=>{calls.push(['save',ref]);return {ok:true,value:undefined};}}};
const root=createRoot(document.getElementById('app'));
const items=[{id:'message:source:user',kind:'userMessage',text:'请阅读附件\\n\\n[report.docx](pico://artifact/document-1)\\n\\n[blocked](pico://artifact/../../secret)'},{id:'boundary',kind:'runBoundary',status:'interrupted'}];
const render=(scope)=>root.render(<PicoTheme><ConversationTranscript items={items} mediaScope={scope} onEditUserMessage={()=>{throw new Error('attachment edit must be disabled');}}/></PicoTheme>);
(async()=>{
 await act(async()=>render({workspacePath:'/project',sessionId:'session'}));
 const open=[...document.querySelectorAll('button')].find(b=>b.textContent==='report.docx');
 check(open,'registered artifact link is actionable');
 await act(async()=>open.click());
 await act(async()=>document.querySelector('button[aria-label="另存附件"]').click());
 check(JSON.stringify(calls)===JSON.stringify([['open',{workspacePath:'/project',sessionId:'session',artifactId:'document-1'}],['save',{workspacePath:'/project',sessionId:'session',artifactId:'document-1'}]]),'native operations bound to current transcript scope');
 check(document.querySelector('button[aria-label="编辑并重发"]').disabled,'old attachment edit explicitly disabled');
 check(document.querySelector('button[aria-label="编辑并重发"]').title.includes('含附件'),'disabled edit explains reason');
 check(![...document.querySelectorAll('button')].some(b=>b.textContent==='blocked'),'path-shaped artifact links stay inert');
 check(document.body.textContent.includes('已停止本地等待；远端服务可能仍在处理。'),'interrupted status explains local stop');
 await act(async()=>render(undefined));
 check(!document.querySelector('.conversation-artifact-link'),'no artifact action without session scope');
 await act(async()=>root.unmount());
 await fetch('/result',{method:'POST',body:'PASS: attachment history'});
})().catch(async error=>{await fetch('/result',{method:'POST',body:'FAIL: '+error.stack});});
`);
    assert.equal(result, "PASS: attachment history", result);
  },
);
