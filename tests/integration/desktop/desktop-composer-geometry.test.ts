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
