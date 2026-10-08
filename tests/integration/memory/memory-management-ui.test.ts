import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageSettingsPage } from "../../../apps/desktop/src/renderer/usage/UsageSettingsPage.js";
import { runRendererBrowserScenario } from "../desktop/renderer-browser-fixture.js";

Object.assign(globalThis, { React });

test(
  "记忆更正保留时间及失败输入，预览拒绝旧响应，用户统计正确区分未知与零",
  { timeout: 45_000 },
  async () => {
    const result = await runRendererBrowserScenario(`
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {MemoryPage} from "./apps/desktop/src/renderer/MemoryPage.tsx";
import {UserMemorySettingsPage} from "./apps/desktop/src/renderer/pages/UserMemorySettingsPage.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const check=(condition,message)=>{if(!condition)throw Error(message);};
const root=createRoot(document.getElementById("app"));
const updates=[],previews=[],metricsRequests=[];
let failUpdate=true;
const item={...previewData.memory.items[0],itemId:"dated-item",content:"Original project fact.",statementType:"plan",temporalType:"interval",eventStartedAt:1700000000000,eventEndedAt:1701000000000,updatedAt:1702000000000};
const actions={
  refreshMemory:async()=>{},loadUserMemorySettings:async()=>{},
  updateMemoryItem:async(id,version,patch)=>{
    updates.push({id,version,patch});
    if(failUpdate)return undefined;
    return {...item,...patch,origin:"user_requested",sources:[],version:version+1};
  },
  queryMemoryContext:query=>new Promise(resolve=>previews.push({query,resolve})),
  queryMemoryMetrics:input=>new Promise(resolve=>metricsRequests.push({input,resolve})),
};
let runtime={preview:true,connection:{kind:"ready"},data:{...previewData,workspacePath:"/project/a",trusted:true,memory:{...previewData.memory,workspacePath:"/project/a",status:"ready",items:[item]}},actions};
const mount=async(page="memory")=>{await act(async()=>root.render(<PicoTheme><MemoryRouter><RuntimeContext value={runtime}>{page==="memory"?<MemoryPage runtime={runtime} forceNarrow={false}/>:<UserMemorySettingsPage/>}</RuntimeContext></MemoryRouter></PicoTheme>));};
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});};
const click=async(label)=>{const element=[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")===label||button.textContent.trim()===label);check(element,"missing button "+label);await act(async()=>element.click());};
const field=label=>[...document.querySelectorAll('input,textarea,[role="combobox"]')].find(element=>element.getAttribute("aria-label")===label||[...(element.labels||[])].some(node=>node.textContent===label)||(element.getAttribute("aria-labelledby")||"").split(" ").some(id=>document.getElementById(id)?.textContent===label));
const input=async(label,value)=>{const element=field(label);check(element,"missing field "+label);const prototype=element.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});};
const select=async(label,text)=>{const element=field(label);check(element,"missing selector "+label);await act(async()=>element.click());await settle();const option=[...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.trim()===text);check(option,"missing option "+text);await act(async()=>option.click());};
const previewResult=(content="LATEST_EXCERPT")=>({items:[{...item,content:"FULL_BODY_MUST_NOT_APPEAR"}],budget:{maxItems:3,maxTokens:320,usedItems:1,usedTokens:200,truncated:true},references:[{itemId:"dated-item",content,source:"assistant-note",excerpt:true,range:{start:12,end:30,total:100},match:"content"}],diagnostics:[{itemId:"dated-item",reason:"selected",match:"content"},{itemId:"duplicate-item",reason:"duplicate",match:"key"},{itemId:"budget-item",reason:"budget",match:"key"}]});
const metricsResult=count=>({metrics:{scope:"user",from:1000,to:2000,unknownReceiptCount:count,groups:[{trigger:"extract",settledCount:3,evaluatedCount:2,createdItemCount:4,modelCallCount:5,emptyCount:1,emptyRate:0.5,durationMs:6000},{trigger:"remember",settledCount:0,evaluatedCount:0,createdItemCount:0,modelCallCount:0,emptyCount:0,emptyRate:null,durationMs:0},{trigger:"compaction",settledCount:1,evaluatedCount:1,createdItemCount:1,modelCallCount:2,emptyCount:0,emptyRate:0,durationMs:1000}]}});
(async()=>{
  try {
    await mount();
    await click("更正 Original project fact.");
    await input("记忆内容","Corrected project fact.");
    await click("保存更正");
    check(updates.length===1&&updates[0].version===item.version,"editor must retain the originally loaded CAS version");
    check(!Object.hasOwn(updates[0].patch,"temporalType")&&!Object.hasOwn(updates[0].patch,"eventStartedAt"),"default correction changed event time");
    check(field("记忆内容").value==="Corrected project fact."&&document.body.textContent.includes("输入已保留"),"failed correction discarded input");
    await select("更正事件时间","指定时间区间");
    await input("更正事件开始时间","");
    await click("保存更正");
    check(updates.length===1&&document.body.textContent.includes("请填写有效"),"invalid event time was submitted");
    await select("更正事件时间","清除事件时间（未注明）");
    await select("更正后的陈述类型","事实");
    failUpdate=false;
    await click("保存更正");
    check(updates.length===2&&updates[1].patch.statementType==="fact"&&updates[1].patch.temporalType==="undated"&&updates[1].patch.eventStartedAt===null&&updates[1].patch.eventEndedAt===null,"explicit clear did not send the complete null-bound patch");
    check(!field("记忆内容"),"successful correction did not close editor");

    await input("召回预览问题","old question");await click("查询召回");
    await input("召回预览问题","new question");await click("查询召回");
    check(previews.length===2,"preview requests missing");
    await act(async()=>previews[1].resolve(previewResult()));
    check(document.body.textContent.includes("LATEST_EXCERPT")&&!document.body.textContent.includes("FULL_BODY_MUST_NOT_APPEAR"),"preview must show actual excerpt instead of persisted full body");
    check(document.body.textContent.includes("未经独立核实")&&document.body.textContent.includes("[12, 30)")&&document.body.textContent.includes("重复展示已省略")&&document.body.textContent.includes("超过 Token 预算"),"preview omitted source, range or diagnostics");
    await act(async()=>previews[0].resolve(previewResult("STALE_EXCERPT")));
    check(!document.body.textContent.includes("STALE_EXCERPT"),"late old preview overwrote current result");
    await input("召回预览问题","workspace question");await click("查询召回");
    runtime={...runtime,data:{...runtime.data,workspacePath:"/project/b",memory:{...runtime.data.memory,workspacePath:"/project/b"}}};
    await mount();
    await act(async()=>previews[2].resolve(previewResult("FOREIGN_WORKSPACE_EXCERPT")));
    check(!document.body.textContent.includes("FOREIGN_WORKSPACE_EXCERPT")&&field("召回预览问题").value==="","workspace switch kept an old preview");
    await input("召回预览问题","policy question");await click("查询召回");
    runtime={...runtime,data:{...runtime.data,memory:{...runtime.data.memory,settings:{...runtime.data.memory.settings,recallEnabled:false,version:99}}}};
    await mount();
    await act(async()=>previews[3].resolve(previewResult("OLD_POLICY_EXCERPT")));
    check(!document.body.textContent.includes("OLD_POLICY_EXCERPT"),"changed policy kept an old preview");

    await mount("settings");
    check(metricsRequests.length===1&&metricsRequests[0].input.to-metricsRequests[0].input.from===7*86400000&&!Object.hasOwn(metricsRequests[0].input,"workspacePath"),"metrics must query the last seven days at user scope");
    await act(async()=>metricsRequests[0].resolve(metricsResult(7)));
    check(document.body.textContent.includes("历史创建数")&&document.body.textContent.includes("不代表当前已保存")&&document.body.textContent.includes("50.0%")&&document.body.textContent.includes("未知（无有效评估）")&&document.body.textContent.includes("0.0%"),"metrics confused historical creation, unknown and zero");
    await click("刷新");await click("刷新");
    check(metricsRequests.length===3,"refresh requests missing");
    await act(async()=>metricsRequests[2].resolve(metricsResult(9)));
    await act(async()=>metricsRequests[1].resolve(metricsResult(88)));
    check(document.body.textContent.includes("有 9 段")&&!document.body.textContent.includes("有 88 段"),"late metrics response overwrote the refreshed user statistics");
    await act(async()=>root.unmount());
    await fetch("/result",{method:"POST",body:"ok"});
  } catch(error) {await fetch("/result",{method:"POST",body:error.stack||String(error)});}
})();
`);
    assert.equal(result, "ok");
  },
);

test("用量日志标注记忆触发阶段且未知费用保留为未知", () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageSettingsPage, {
      usage: {
        providerCallCount: 1,
        usageReportCount: 1,
        details: {
          activities: [
            {
              id: "memory-call",
              kind: "model",
              name: "memory-model",
              purpose: "memory_review",
              memory: { trigger: "extract", stage: "canonicalize", operationId: "memory-op" },
              workspacePath: "/project/a",
              at: 1000,
              status: "success",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 15,
              costStatus: "unknown",
              costCNY: 99,
              costUnknownReason: "厂商未提供定价",
            },
          ],
          activityCount: 1,
          activitiesTruncated: false,
          providers: [],
          models: [],
          tools: [],
          pricing: [],
          unavailableWorkspaces: [],
          knownCacheReadTokens: 0,
          knownCacheWriteTokens: 0,
          cacheReadReportedCallCount: 0,
          cacheWriteReportedCallCount: 0,
          warnings: [],
        },
      },
      selection: { range: "7d", workspacePath: "" },
      workspaces: [],
      loading: false,
      onQuery: async () => {},
      onOpenSession: () => {},
    }),
  );
  assert.match(html, /记忆提取/u);
  assert.match(html, /自动提取 · 证据核实/u);
  assert.match(html, /操作：memory-op/u);
  assert.match(html, /厂商未提供定价/u);
  assert.doesNotMatch(html, /¥99/u);
});
