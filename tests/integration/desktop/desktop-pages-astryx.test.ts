import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("Astryx 页面控件保留任务表单、模型切换和审批交互", { timeout: 45_000 }, async (t) => {
  const candidates = [
    process.env.PICO_TEST_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
  let chrome: string | undefined;
  for (const candidate of candidates) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      chrome = candidate;
      break;
    }
  }
  if (!chrome) {
    t.skip("需要 Chrome/Chromium，可通过 PICO_TEST_CHROME 指定浏览器");
    return;
  }
  const bundle = await build({
    stdin: {
      contents: pagesScenario,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "tsx",
    },
    outdir: "/virtual-pico-pages",
    plugins: [
      {
        name: "vite-brand-assets",
        setup(bundler) {
          bundler.onLoad({ filter: /ComposerModelPicker\.tsx$/ }, async ({ path }) => ({
            contents: (await readFile(path, "utf8")).replace(
              /const marks = import\.meta\.glob<string>\([\s\S]*?\n\}\);/u,
              "const marks: Record<string, string> = {};",
            ),
            loader: "tsx",
          }));
        },
      },
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  assert.ok(script);
  const outcome = Promise.withResolvers<string>();
  const server = createServer((request, response) => {
    if (request.url === "/result") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        response.end("ok");
        outcome.resolve(body);
      });
      return;
    }
    response.setHeader(
      "content-type",
      request.url === "/bundle.js"
        ? "text/javascript"
        : request.url === "/bundle.css"
          ? "text/css"
          : "text/html",
    );
    response.end(
      request.url === "/bundle.js"
        ? script
        : request.url === "/bundle.css"
          ? css
          : request.url === "/scenario"
            ? '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>'
            : '<!doctype html><html><body><iframe title="Desktop renderer scenario" src="/scenario" width="1280" height="900" style="border:0"></iframe></body></html>',
    );
  });
  const profile = await mkdtemp(join(tmpdir(), "pico-pages-ui-"));
  let browser: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--window-size=1280,900",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${address.port}`,
      ],
      { stdio: "ignore" },
    );
    browser.once("error", outcome.reject);
    timer = setTimeout(
      () => outcome.reject(new Error("Browser UI scenario did not finish in 30 seconds")),
      30_000,
    );
    const result = await outcome.promise;
    assert.match(result, /^PASS: pages forms model picker and approval$/, result);
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
      browser.kill("SIGTERM");
      await closed;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

const pagesScenario = `
import "./apps/desktop/src/renderer/layers.css";
import * as React from "react";
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {AutomationsPage} from "./apps/desktop/src/renderer/pages/AutomationsPage.tsx";
import {SessionsPage} from "./apps/desktop/src/renderer/pages/SessionsPage.tsx";
import {ConversationPage} from "./apps/desktop/src/renderer/pages/ConversationPage.tsx";
import {DataSettingsPage} from "./apps/desktop/src/renderer/pages/SettingsPage.tsx";
import {ComposerModelPicker} from "./apps/desktop/src/renderer/ComposerModelPicker.tsx";
import {ConversationInteractionSlot} from "./apps/desktop/src/renderer/conversation/ConversationInteractionSlot.tsx";
import {ConversationTranscript} from "./apps/desktop/src/renderer/conversation/ConversationTranscript.tsx";
import {SideChatWorkbarPanel} from "./apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
import "./apps/desktop/src/renderer/styles.css";
import "./apps/desktop/src/renderer/astryx-controls.css";
import "./apps/desktop/src/renderer/conversation/conversation.css";
import "./apps/desktop/src/renderer/pages-astryx.css";
Object.assign(globalThis, {React, IS_REACT_ACT_ENVIRONMENT:true});
const root=createRoot(document.getElementById("app"));
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const button=name=>{
  const el=[...document.querySelectorAll("button")].find(el=>el.getAttribute("aria-label")===name||el.textContent.trim()===name);
  check(el,"Missing button "+name);return el;
};
const click=async name=>act(async()=>{button(name).focus();button(name).click();});
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const enter=async(selector,value)=>act(async()=>{
  const el=document.querySelector(selector);check(el,"Missing input "+selector);
  const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value").set.call(el,value);
  el.dispatchEvent(new Event("input",{bubbles:true}));
});
const writes=[];
let createSuccess=false;
const runtime={data:previewData,busy:false,actions:{createJob:async value=>{writes.push(value);return createSuccess;}}};
let finishSwitch;
let rejectSwitch;
let setLocked;
const selections=[];
function ModelHarness(){
  const [value,setValue]=useState("test/a");
  const [locked,lock]=useState(false);setLocked=lock;
  return <ComposerModelPicker routes={[{id:"test/a",label:"Alpha"},{id:"test/b",label:"Beta"}]} providers={[]} value={value} disabled={locked} hasHistory onConfigure={()=>{}} onChange={next=>{
    selections.push(next);
    return new Promise((resolve,reject)=>{finishSwitch=()=>{setValue(next);resolve();};rejectSwitch=reject;});
  }}/>;
}
async function scenario(){
  // Keep the desktop media-query contract independent of the runner's physical display.
  check(innerWidth===1280&&innerHeight===900,"Desktop scenario viewport: "+JSON.stringify({width:innerWidth,height:innerHeight}));
  const opened=[];let copied="";
  const storageRuntime={...runtime,data:{...previewData,picoHome:"/custom/Pico data",workspacePath:undefined,workspaces:[]},actions:{openWorkspace:async path=>opened.push(path)}};
  await act(async()=>root.render(<RuntimeContext value={storageRuntime}><DataSettingsPage/></RuntimeContext>));
  check(document.body.textContent.includes("/custom/Pico data/temporary-workspace-<任务 ID>"),"Data settings use the actual root without creating a project");
  check(document.body.textContent.includes("/custom/Pico data/workspaces/<工作区标识>/pico.sqlite"),"Data settings distinguish files from conversation storage");
  await click("打开数据文件夹");check(opened[0]==="/custom/Pico data","Open passes the exact data path");
  const originalExec=document.execCommand;
  document.execCommand=command=>{check(command==="copy","Only copy is requested");copied=document.activeElement.value;return true;};
  await click("复制数据文件夹路径");document.execCommand=originalExec;
  check(copied==="/custom/Pico data"&&document.body.textContent.includes("已复制数据文件夹路径"),"Copy preserves the real usable path and reports success");
  await act(async()=>root.render(<RuntimeContext value={runtime}><AutomationsPage/></RuntimeContext>));
  await click("新建定时任务");
  await enter('[name="name"]',"每周检查");
  await enter('[name="schedule"]',"0 9 * * 1");
  await enter('[name="prompt"]',"检查依赖并总结");
  check(document.querySelector("form").checkValidity(),"Astryx inputs retain required/native validity");
  await act(async()=>document.querySelector("form").requestSubmit());
  check(writes.length===1&&writes[0].name==="每周检查"&&writes[0].prompt==="检查依赖并总结"&&writes[0].schedule==="0 9 * * 1","FormData retains field names and values");
  check(document.querySelector('[name="name"]').value==="每周检查","Save failure preserves draft");
  createSuccess=true;
  await act(async()=>document.querySelector("form").requestSubmit());
  check(!document.querySelector("form"),"Success closes form");
  await click("新建定时任务");
  check(document.querySelector('[name="name"]').value==="","New form resets draft");
  await act(async()=>root.render(<RuntimeContext value={runtime}><MemoryRouter><SessionsPage/></MemoryRouter></RuntimeContext>));
  const before=document.querySelectorAll(".session-row").length;
  await act(async()=>document.querySelector('input[type="checkbox"]').click());
  check(document.querySelectorAll(".session-row").length>before,"Show-archived checkbox works");
  await enter('[name="session-search"]',"重构编辑器");
  check(document.querySelectorAll(".session-row").length===1,"Session search remains controlled");
  await act(async()=>root.render(<ModelHarness/>));
  await click("选择模型：Alpha");await frame();
  check(document.activeElement.getAttribute("aria-checked")==="true","Model menu focuses current choice");
  check(document.querySelector(".composer-model-notice"),"History warning remains visible");
  const radio=label=>{ const found=[...document.querySelectorAll('[role="menuitemradio"]')].find(el=>el.querySelector("strong")?.textContent===label); check(found,"Missing radio "+label+": "+document.querySelector(".composer-model-menu")?.textContent);return found; };
  await act(async()=>document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true})));
  check(document.activeElement.querySelector("strong")?.textContent==="Beta","Model keyboard navigation follows options");
  await act(async()=>document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
  check(button("选择模型：Alpha").getAttribute("aria-disabled") === "true"&&selections[0]==="test/b","Pending selection locks trigger and preserves route id");
  await act(async()=>rejectSwitch(new Error("fixture failure")));
  check(button("选择模型：Alpha").getAttribute("aria-disabled") !== "true","Rejected switch unlocks current selection");
  await click("选择模型：Alpha");await frame();
  await act(async()=>radio("Beta").click());
  await act(async()=>finishSwitch());
  check(button("选择模型：Beta"),"Successful switch updates visible label");
  await act(async()=>setLocked(true));
  check(button("选择模型：Beta").getAttribute("aria-disabled") === "true","Running task prevents switching");
  const longLabel="a-very-long-model-name-with-a-version-and-provider-suffix";
  const manyRoutes=Array.from({length:50},(_,index)=>({id:"test/"+index,label:index===16?longLabel:"model-"+index}));
  await act(async()=>root.render(<PicoTheme><div style={{position:"fixed",bottom:20,left:300}}><ComposerModelPicker routes={manyRoutes} providers={[]} value="test/16" onConfigure={()=>{}} onChange={()=>{}}/></div></PicoTheme>));
  await click("选择模型："+longLabel);await frame();
  await Promise.all(document.getAnimations().map(animation=>animation.finished));await frame();
  const menu=document.querySelector(".composer-model-menu");
  const selected=menu.querySelector('[aria-checked="true"]');
  const rect=element=>element.getBoundingClientRect();
  const icon=selected.querySelector(".composer-model-mark");
  const name=selected.querySelector("strong");
  const mark=selected.querySelector(".composer-model-check");
  check(rect(name).left-rect(icon).right<=12,"Model icon must sit next to its label");
  check(rect(name).right<=rect(mark).left-5,"Long model label must not overlap the selected checkmark");
  check(name.scrollWidth>name.clientWidth&&getComputedStyle(name).textOverflow==="ellipsis","Long model label is ellipsized");
  const bounds=JSON.stringify({menu:rect(menu),selected:rect(selected),trigger:rect(button("选择模型："+longLabel)),scrollTop:menu.scrollTop});
  check(rect(selected).top>=rect(menu).top-1&&rect(selected).bottom<=rect(menu).bottom+1,"Current model remains visible in a long menu: "+bounds);
  check(rect(menu).bottom<=rect(button("选择模型："+longLabel)).top,"Model menu opens above the composer trigger: "+bounds);
  check(rect(menu).height<=328&&menu.scrollHeight>menu.clientHeight,"Long menu stays bounded and scrollable");
  const decisions=[];
  await act(async()=>root.render(<ConversationInteractionSlot approval={{id:"approval",kind:"plan",title:"计划",detail:"说明",planSteps:["步骤"]}} busy={false} onApprovalDecision={(...args)=>decisions.push(args)} onPromptAnswer={()=>{}}/>));
  check(button("继续修改").disabled,"Empty feedback stays disabled");
  await enter("textarea","保留接口");
  await click("继续修改");
  check(decisions[0][0]==="continue_editing"&&decisions[0][1]==="保留接口","Feedback action keeps decision and text");
  const sends=[];
  const taskRuntime={...runtime,preview:true,data:{...previewData,providerConfig:{...previewData.providerConfig,
    defaultModelRouteId:"test/a",userDefaults:{modelRouteId:"test/a",thinkingEffort:"unsupported"},
    providers:[{id:"test",origin:"user",protocol:"openai",baseURL:"https://fixture.invalid",models:["a"],availableModels:["a","b","disabled"],disabledModels:["disabled"],resolvedModelCapabilities:{a:{reasoningLevels:["low","high"]},b:{reasoningLevels:["medium"]}}}]},
  },actions:{...runtime.actions,ensureTemporaryWorkspace:async()=>"/fixture",sendMessage:async request=>{sends.push(request);return {succeeded:false};}}};
  await act(async()=>root.render(<PicoTheme><RuntimeContext value={taskRuntime}><MemoryRouter initialEntries={["/task/new"]}><ConversationPage/></MemoryRouter></RuntimeContext></PicoTheme>));
  const thinking=()=>document.querySelector('[role="combobox"][name="initial-thinking-effort"]') ?? document.querySelector('[name="initial-thinking-effort"]')?.closest('.astryx-field')?.querySelector('[role="combobox"]');
  check(thinking(),"New task must expose thinking before the first message");
  await act(async()=>thinking().click());await frame();
  const option=text=>[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.trim()===text);
  check(option("low")&&option("high")&&!option("unsupported"),"Only supported thinking levels are offered");
  await act(async()=>option("high").click());
  const editor=document.querySelector('[contenteditable="true"]');
  await act(async()=>{editor.focus();document.execCommand("insertText",false,"test first send");});
  await click("发送消息");
  check(sends.length===1&&sends[0].initialSettings.thinkingEffort==="high","First send carries the explicit reasoning selection");
  await click("选择模型：a");await frame();
  check(radio("b")&&!document.querySelector('.composer-model-menu')?.textContent.includes("disabled"),"New task includes discovered models and excludes disabled ones");
  await act(async()=>radio("b").click());
  await act(async()=>thinking().click());await frame();
  check(option("medium")&&!option("high"),"Changing model refreshes supported reasoning levels");
  await act(async()=>option("思考：默认").click());
  await click("发送消息");
  check(sends.length===2&&!Object.hasOwn(sends[1].initialSettings,"thinkingEffort"),"Model change/default selection leaves reconciliation to the Host");

  // Exercise the production transcript's disclosures across live updates and settlement.
  // Host run IDs and canonical execution IDs intentionally differ, as in real sessions.
  const activeRun={id:"host-1",status:"running"};
  const tool=(id,state="done",runId="execution-1")=>({id,kind:"tool",runId,turnId:id,toolName:"grep",title:"grep",detail:JSON.stringify({pattern:"GoalEvaluator".repeat(40),path:"/workspace/"+"long-path/".repeat(30)+"source.ts"}),state,output:state==="failed"?"匹配表达式错误":"完整工具结果"});
  const reasoning={id:"thinking-1",kind:"thinking",runId:"execution-1",text:"检查配置\\n完整推理正文",streaming:true};
  const liveItems=[
    {id:"user-1",kind:"userMessage",text:"检查项目"},
    {id:"start-1",kind:"runBoundary",runId:"host-1",status:"started",label:"运行中"},
    reasoning,tool("tool-1"),tool("tool-2","failed"),
    {id:"commentary",kind:"assistantMessage",runId:"execution-1",text:"正在继续检查"},
    tool("tool-3"),
  ];
  const mountTranscript=async(items,run,width=800)=>act(async()=>root.render(<PicoTheme><div className="conversation-surface" style={{width,display:"block",height:"auto"}}><ConversationTranscript items={items} activeRun={run} onOpenItem={item=>decisions.push(item.id)} renderItem={(item,fallback)=>item.kind==="runBoundary"&&item.status==="failed"?<aside data-recovery="true">重试运行</aside>:fallback}/></div></PicoTheme>));
  await mountTranscript(liveItems,activeRun);
  const process=()=>document.querySelector('.conversation-process');
  const thinkingRow=()=>document.querySelector('.conversation-thinking');
  check(process().open,"Live execution process is expanded even with different canonical IDs");
  check(!thinkingRow().open&&!thinkingRow().querySelector('.conversation-thinking__body').textContent,"Thinking starts collapsed and does not mount its body");
  check(!thinkingRow().querySelector('.conversation-thinking__preview'),"Streaming thinking does not show a changing preview");
  check(document.querySelectorAll('[data-tool-group]').length===1,"Adjacent tools remain grouped inside the process");
  const toolGroup=()=>document.querySelector('[data-tool-group]');
  check(!toolGroup().open&&toolGroup().querySelector('.conversation-tool-group__latest').textContent==="grep","Collapsed group shows its latest action");
  check(toolGroup().querySelector('.conversation-tool-row__target').textContent.length<=120,"Invocation preview is bounded even for long arguments");
  check(getComputedStyle(toolGroup().querySelector('.conversation-tool-group__expanded-title')).display==="none","Generic group heading is hidden while collapsed");
  check(document.querySelector('.conversation-tool-record[data-state="failed"]').open===false,"Errors do not force tool details open");
  check(thinkingRow().querySelector('summary').getBoundingClientRect().height<=28,"Thinking uses the compact tool-row geometry");
  check(getComputedStyle(process().querySelector('.conversation-process__items')).paddingLeft==="0px","Process does not add a nested tree indent");
  check(process().contains([...document.querySelectorAll('.conversation-message--assistant')][0]),"Intermediate commentary stays in the process");
  await act(async()=>process().querySelector('summary').click());
  check(process().open,"Live work cannot be collapsed");
  await act(async()=>thinkingRow().querySelector('summary').click());
  const originalThinking=thinkingRow();
  check(thinkingRow().open&&thinkingRow().textContent.includes("完整推理正文"),"Opening thinking renders the full content");
  const settled=[...liveItems.map(item=>item.id===reasoning.id?{...item,streaming:false,text:item.text+"追加说明"}:item),
    {id:"answer-1",kind:"assistantMessage",runId:"execution-1",text:"最终结论一"},
    {id:"end-1",kind:"runBoundary",runId:"host-1",status:"completed",label:"运行完成",duration:"2 分 15 秒"},
  ];
  await mountTranscript(settled);
  check(!process().open,"Settling collapses the outer process automatically");
  check(thinkingRow()===originalThinking&&thinkingRow().open,"Nested expansion survives settlement");
  check(process().querySelector('summary').textContent.includes("2 分 15 秒"),"Settled header carries Run duration");
  check(process().querySelector('summary').textContent.includes("1 次工具失败"),"Failure summary remains visible when collapsed");
  const answer=[...document.querySelectorAll('.conversation-message--assistant')].find(el=>el.textContent.includes("最终结论一"));
  check(answer&&!answer.closest('.conversation-process'),"Final answer stays outside the process");
  await act(async()=>process().querySelector('summary').click());
  await act(async()=>thinkingRow().querySelector('summary').click());
  check(!thinkingRow().open&&thinkingRow().querySelector('.conversation-thinking__body').textContent.includes("追加说明"),"Closed thinking retains mounted content after first expansion");
  check(thinkingRow().querySelector('.conversation-thinking__preview').textContent==="检查配置","Settled preview uses the first nonempty line");
  await act(async()=>document.querySelector('[data-tool-group] > summary').click());
  check(getComputedStyle(toolGroup().querySelector('.conversation-tool-group__latest')).display==="none","Expanded group switches to the count heading");
  const failedTool=()=>document.querySelector('.conversation-tool-record[data-state="failed"]');
  check(failedTool().querySelector('summary').textContent.includes("匹配表达式错误"),"Collapsed failed call retains its error preview");
  await act(async()=>failedTool().querySelector('summary').click());
  await act(async()=>document.querySelector('.conversation-tool-record[data-state="failed"] button').click());
  check(decisions.includes("tool-2"),"Full failed tool detail is reachable inside nested disclosures");
  const secondRun=[{id:"start-2",kind:"runBoundary",runId:"host-2",status:"started",label:"运行中"},tool("tool-new","done","execution-2"),{id:"answer-2",kind:"assistantMessage",runId:"execution-2",text:"续跑结论"},{id:"end-2",kind:"runBoundary",runId:"host-2",status:"completed",label:"运行完成"}];
  await mountTranscript([...settled,...secondRun]);
  check(document.querySelectorAll('.conversation-process').length===2,"Goal continuation Runs stay separate");
  check(process().open,"Reader expansion survives appended events");
  await act(async()=>process().querySelector('summary').click());
  await mountTranscript([...settled,...secondRun,{id:"info",kind:"status",title:"新通知"}]);
  check(!process().open,"Reader collapse survives appended events");
  await mountTranscript(settled,undefined,360);
  await act(async()=>process().querySelector('summary').click());
  check(toolGroup().getBoundingClientRect().width<=312,"Tool groups fit a narrow side conversation: "+JSON.stringify({viewport:innerWidth,surface:document.querySelector('.conversation-surface').getBoundingClientRect().width,transcript:document.querySelector('.conversation-transcript').getBoundingClientRect().width,group:toolGroup().getBoundingClientRect().width}));
  check(toolGroup().querySelector('summary').scrollWidth<=toolGroup().querySelector('summary').clientWidth+1,"Long arguments do not overflow the compact row");
  await act(async()=>toolGroup().querySelector('summary').click());
  const firstTool=toolGroup().querySelector('.conversation-tool-record');
  check(firstTool.querySelector('summary').getBoundingClientRect().height<=28,"Successful tool is a single compact line");
  check(Math.abs(firstTool.getBoundingClientRect().left-toolGroup().getBoundingClientRect().left)<1,"Expanded calls stay on the group reading column");
  await act(async()=>process().querySelector('summary').click());

  const interrupted=[...liveItems,
    {id:"steer",kind:"userMessage",text:"换一个检查方向"},tool("after-steer"),
    {id:"approval",kind:"approval",title:"执行许可",detail:"需要批准",state:"pending"},tool("after-approval"),
    {id:"question",kind:"prompt",question:"选择目录",state:"pending"},
    {id:"failure",kind:"runBoundary",runId:"host-1",status:"failed",label:"运行失败"},
  ];
  await mountTranscript(interrupted,activeRun);
  for(const kind of ["userMessage","approval","prompt","runBoundary"]){
    check([...document.querySelectorAll('[data-kind="'+kind+'"]')].every(el=>!el.closest('.conversation-process')),"Interaction/recovery records must remain outside: "+kind);
  }
  check(document.querySelector('[data-recovery]')&&!document.querySelector('[data-recovery]').closest('.conversation-process'),"Custom failure recovery remains visible");
  check([...document.querySelectorAll('.conversation-process')].every(el=>!el.open),"Terminal events override a stale active Run prop");
  const steeringLive=interrupted.filter(item=>item.id!=="failure");
  await mountTranscript(steeringLive,activeRun);
  check([...document.querySelectorAll('.conversation-process')].every(el=>el.open),"Steering splits the process while preserving live Run ownership");
  await act(async()=>root.render(<SideChatWorkbarPanel child={{panelId:"side",sourceSessionId:"parent",targetSessionId:"child",state:"live"}} items={liveItems} activeRun={activeRun} draft="" active running loading={false} onSend={()=>{}} onStop={()=>{}} onDraftChange={()=>{}} onRetryCreate={()=>{}} onClose={()=>{}}/>));
  check(process().open&&!thinkingRow().open,"Side chat uses the same live process and thinking disclosures");
  await act(async()=>root.unmount());
}
scenario().then(()=>fetch("/result",{method:"POST",body:"PASS: pages forms model picker and approval"})).catch(error=>fetch("/result",{method:"POST",body:String(error.stack||error)}));
`;
