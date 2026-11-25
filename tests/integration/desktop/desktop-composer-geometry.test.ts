import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("运行状态与诊断徽标都不改变输入框和页脚几何", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import './apps/desktop/src/renderer/layers.css';
import './apps/desktop/src/renderer/styles.css';
import './apps/desktop/src/renderer/motion.css';
import './apps/desktop/src/renderer/astryx-controls.css';
import './apps/desktop/src/renderer/ExperienceUsagePanel.css';
import './apps/desktop/src/renderer/conversation/conversation.css';
import './apps/desktop/src/renderer/conversation/astryx-chat.css';
import { ConversationComposer } from './apps/desktop/src/renderer/conversation/ConversationComposer.tsx';
import { ConversationSurface } from './apps/desktop/src/renderer/conversation/ConversationSurface.tsx';
import { ExperienceDiagnostics } from './apps/desktop/src/renderer/ExperienceUsagePanel.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const host=document.getElementById('app');
host.style.cssText='position:fixed;inset:0;width:1000px;height:700px';
const root=createRoot(host);
const diagnostics=[{diagnosticId:'diagnostic-1',workspaceKey:'/project',sessionId:'session-1',runId:'run-1',phase:'effect',reason:'collection_deadline',createdAt:1}];
const frame=()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise};
const render=(value,status,tag)=>root.render(
  <PicoTheme>
    <ConversationSurface
      composer={
        <ConversationComposer
          value={value}
          status={status}
          onValueChange={()=>{}}
          onSubmit={()=>{}}
          onPause={()=>{}}
          onStop={()=>{}}
          leadingAccessory={<div style={{width:520,height:28,flex:'none'}}/>}
          overlay={tag?<ExperienceDiagnostics diagnostics={diagnostics}/>:undefined}
        />
      }
    >
      <div style={{height:600}}>会话内容</div>
    </ConversationSurface>
  </PicoTheme>
);
const rect=(node)=>{const r=node.getBoundingClientRect();return {x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)}};
const snapshot=()=>({
  dock:rect(document.querySelector('.conversation-surface__composer')),
  form:rect(document.querySelector('.conversation-composer')),
  input:rect(document.querySelector('.pico-chat-input [contenteditable]')),
  footer:rect(document.querySelector('.pico-astryx-composer > div > div:last-child')),
});
const stable=(left,right,label)=>{
  for(const key of ['dock','form','input','footer']){
    check(Math.abs(left[key].h-right[key].h)<=0.5&&Math.abs(left[key].y-right[key].y)<=0.5,label+' changes '+key+': '+JSON.stringify({left:left[key],right:right[key]}));
  }
};
(async()=>{
 await act(async()=>render('','idle',false));
 const idleEmpty=snapshot();
 await act(async()=>render('','idle',true));
 await frame();
 const idleEmptyTag=snapshot();
 stable(idleEmpty,idleEmptyTag,'diagnostics badge');
 const tag=document.querySelector('.conversation-composer__overlay [aria-label="最近记录诊断"]');
 check(tag,'diagnostics badge renders above the composer');
 check(!document.querySelector('.conversation-surface__content [aria-label="最近记录诊断"]'),'diagnostics badge leaves the transcript flow');
 check(rect(tag).y+rect(tag).h<=idleEmptyTag.form.y-4,'badge sits above the composer card: '+JSON.stringify({tag:rect(tag),form:idleEmptyTag.form}));
 await act(async()=>render('','running',true));
 await frame();
 const runningEmptyTag=snapshot();
 check(document.querySelector('.conversation-composer__status')?.textContent?.includes('正在处理'),'running status renders in the footer');
 stable(idleEmptyTag,runningEmptyTag,'run status and controls');
 const multiline='这是一段很长的草稿文字，用来验证输入框在文字换行变高时仍然保持页脚和诊断徽标的几何位置。'.repeat(14);
 await act(async()=>render(multiline,'running',true));
 await frame();
 const runningMultilineTag=snapshot();
 check(runningMultilineTag.form.h>runningEmptyTag.form.h+20,'multi-line draft grows the composer: '+JSON.stringify({empty:runningEmptyTag.form,multiline:runningMultilineTag.form}));
 const footerBottomGapEmpty=runningEmptyTag.form.y+runningEmptyTag.form.h-(runningEmptyTag.footer.y+runningEmptyTag.footer.h);
 const footerBottomGapMultiline=runningMultilineTag.form.y+runningMultilineTag.form.h-(runningMultilineTag.footer.y+runningMultilineTag.footer.h);
 check(Math.abs(footerBottomGapMultiline-footerBottomGapEmpty)<=0.5,'footer stays anchored to the card bottom while the draft grows: '+JSON.stringify({empty:footerBottomGapEmpty,multiline:footerBottomGapMultiline}));
 await act(async()=>render(multiline,'running',false));
 await frame();
 const runningMultilineNoTag=snapshot();
 stable(runningMultilineTag,runningMultilineNoTag,'diagnostics badge with a multi-line draft');
 await act(async()=>root.unmount());
 await fetch('/result',{method:'POST',body:'PASS: composer geometry'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+(error.stack||error)}));
`);
  assert.equal(result, "PASS: composer geometry", result);
});

test("运行态状态放进独立底栏行，不挤走 max 等控件", { timeout: 45_000 }, async () => {
  const result = await runRendererBrowserScenario(`
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import './apps/desktop/src/renderer/layers.css';
import './apps/desktop/src/renderer/styles.css';
import './apps/desktop/src/renderer/motion.css';
import './apps/desktop/src/renderer/astryx-controls.css';
import './apps/desktop/src/renderer/conversation/conversation.css';
import './apps/desktop/src/renderer/conversation/astryx-chat.css';
import { ConversationComposer } from './apps/desktop/src/renderer/conversation/ConversationComposer.tsx';
import { ConversationSurface } from './apps/desktop/src/renderer/conversation/ConversationSurface.tsx';
import { SelectField } from './apps/desktop/src/renderer/ui-controls.tsx';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(value,message)=>{if(!value)throw new Error(message)};
const host=document.getElementById('app');
host.style.cssText='position:fixed;inset:0;width:1000px;height:700px';
const root=createRoot(host);
const levels=['off','minimal','low','medium','high','xhigh','max'];
const leadingAccessory=(
  <>
    <span className="conversation-context-label"><span>pico-harness</span></span>
    <button type="button" className="composer-model-trigger pico-page-control"><span>claude-sonnet-4-5-thinking-max-preview</span></button>
    <span className="conversation-context-gauge"><span>52%</span></span>
    <div className="conversation-context-option" data-control="permission">
      <SelectField name="permission-mode" label="权限模式" value="ask"
        options={[{value:'ask',label:'权限：请求批准'},{value:'auto',label:'权限：帮我批准'}]}
        onValueChange={()=>{}} />
    </div>
    <div className="conversation-context-option" data-control="thinking">
      <SelectField name="thinking-effort" label="Thinking" value="max"
        options={levels.map(level=>({value:level,label:level}))}
        onValueChange={()=>{}} />
    </div>
  </>
);
const modes={planActive:true,graphActive:false,onPlanChange:async()=>{},onGraphChange:async()=>{}};
const render=(status,busy,statusText)=>root.render(
  <PicoTheme>
    <ConversationSurface
      composer={
        <ConversationComposer
          value=""
          status={status}
          busy={busy}
          startedAt={status==='running'?Date.now()-65000:undefined}
          statusText={statusText}
          modes={modes}
          onValueChange={()=>{}}
          onSubmit={()=>{}}
          onAttach={()=>{}}
          onFilesAdd={()=>{}}
          onPause={()=>{}}
          onStop={()=>{}}
          leadingAccessory={leadingAccessory}
        />
      }
    >
      <div style={{height:600}}>会话内容</div>
    </ConversationSurface>
  </PicoTheme>
);
const rect=node=>{const r=node.getBoundingClientRect();return {x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)}};
const memberKey=node=>{
  if(node.matches('button[aria-label="添加文件"]'))return 'attach';
  if(node.matches('button.conversation-plus-trigger'))return 'plus';
  if(node.matches('.conversation-mode-mark'))return 'mode:'+node.textContent.trim();
  if(node.matches('.conversation-context-label'))return 'workspace';
  if(node.matches('.composer-model-trigger'))return 'model';
  if(node.matches('.conversation-context-gauge'))return 'gauge';
  const control=node.closest('[data-control]');
  if(control)return control.dataset.control;
  return 'unknown:'+node.tagName+':'+node.textContent.trim();
};
const snapshot=()=>({
  footer:rect(document.querySelector('.pico-astryx-composer > div > div:last-child')),
  form:rect(document.querySelector('.conversation-composer')),
  input:rect(document.querySelector('.pico-chat-input [contenteditable]')),
  controls:rect(document.querySelector('.conversation-composer__controls')),
  actions:rect(document.querySelector('.conversation-composer__actions')),
  send:rect(document.querySelector('button[aria-label*="发送"], button[aria-label*="引导"], button[aria-label*="排到"], button[aria-label*="停止当前"]')),
  members:[...document.querySelectorAll('.conversation-composer__controls > *')]
    .filter(node=>node.getBoundingClientRect().width>0)
    .map(node=>({key:memberKey(node),rect:rect(node)})),
});
const sameRect=(left,right,label)=>{
  for(const key of ['x','y','w','h'])
    check(Math.abs(left[key]-right[key])<=0.5,label+' changes '+key+': '+JSON.stringify({left,right}));
};
const frame=()=>{const {promise,resolve}=Promise.withResolvers();requestAnimationFrame(()=>requestAnimationFrame(resolve));return promise};
(async()=>{
  await act(async()=>render('idle',false));
  await frame();
  const idle=snapshot();
  check(idle.members.length>=8,'idle footer keeps every control: '+JSON.stringify(idle.members));
  check(idle.members.some(member=>member.key==='thinking'),'thinking (max) control renders');
  check(Math.abs(idle.members.find(member=>member.key==='thinking').rect.y-idle.controls.y)<=0.5,'idle keeps max on the control row');
  await act(async()=>render('running',false,'3 条消息正在排队'));
  await frame();
  const running=snapshot();
  check(document.querySelector('.conversation-composer__status')?.textContent.includes('3 条消息正在排队'),'running status renders');
  check(running.actions.y>=running.controls.y+running.controls.h,'runtime controls use their own row: '+JSON.stringify({controls:running.controls,actions:running.actions}));
  check(Math.abs(running.actions.w-running.footer.w)<=0.5,'runtime row spans the footer width: '+JSON.stringify({footer:running.footer,actions:running.actions}));
  check(running.members.length===idle.members.length,'running keeps the same control members: '+JSON.stringify({idle:idle.members.map(m=>m.key),running:running.members.map(m=>m.key)}));
  idle.members.forEach((member,index)=>{
    check(member.key===running.members[index].key,'member order changes at '+index+': '+JSON.stringify({idle:member.key,running:running.members[index].key}));
    sameRect(member.rect,running.members[index].rect,'running '+member.key);
  });
  sameRect(idle.controls,running.controls,'running control row');
  sameRect(idle.footer,running.footer,'running footer');
  sameRect(idle.form,running.form,'running composer');
  sameRect(idle.input,running.input,'running input');
  sameRect(idle.send,running.send,'running send button');
  await act(async()=>render('idle',true,'正在发送…'));
  await frame();
  const sending=snapshot();
  check(sending.members.length===idle.members.length,'sending keeps the same control members: '+JSON.stringify(sending.members.map(m=>m.key)));
  idle.members.forEach((member,index)=>{
    check(member.key===sending.members[index].key,'sending member order changes at '+index);
    sameRect(member.rect,sending.members[index].rect,'sending '+member.key);
  });
  sameRect(idle.controls,sending.controls,'sending control row');
  sameRect(idle.footer,sending.footer,'sending footer');
  sameRect(idle.form,sending.form,'sending composer');
  sameRect(idle.input,sending.input,'sending input');
  sameRect(idle.send,sending.send,'sending send button');
  await act(async()=>root.unmount());
  await fetch('/result',{method:'POST',body:'PASS: composer runtime row'});
})().catch(async error=>fetch('/result',{method:'POST',body:'FAIL: '+(error.stack||error)}));
`);
  assert.equal(result, "PASS: composer runtime row", result);
});
