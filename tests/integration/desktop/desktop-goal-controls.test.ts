import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("Goal 对话框和共享状态栏执行 CAS 控制、抑制重复并保留终态", { timeout: 45_000 }, async (t) => {
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
      contents: goalScenario,
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
          : '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>',
    );
  });
  const profile = await mkdtemp(join(tmpdir(), "pico-goal-ui-"));
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
    assert.match(result, /^PASS: goal controls$/, result);
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

const goalScenario = `
import "./apps/desktop/src/renderer/layers.css";
import * as React from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ConversationPage } from "./apps/desktop/src/renderer/pages/ConversationPage.tsx";
import { RuntimeContext } from "./apps/desktop/src/renderer/runtime-context.tsx";
import { previewData } from "./apps/desktop/src/renderer/fixture.ts";
import { workspaceSessionKey } from "./apps/desktop/src/renderer/workspace-session.ts";

import { PicoTheme } from "./apps/desktop/src/renderer/astryx-provider.tsx";
import { ConversationComposerMenu } from "./apps/desktop/src/renderer/conversation/ConversationComposerMenu.tsx";
import { useConversationGoal } from "./apps/desktop/src/renderer/conversation/ConversationGoalControls.tsx";
import { controlGoalRequest } from "./apps/desktop/src/renderer/conversation/goal-control.ts";
import { ConversationTranscript } from "./apps/desktop/src/renderer/conversation/ConversationTranscript.tsx";
import { SideChatWorkbarPanel } from "./apps/desktop/src/renderer/workbar-panels/SideChatWorkbarPanel.tsx";
import { parseGoalItem, parseConversation } from "./apps/desktop/src/renderer/conversation/runtime-projection.ts";
import "./apps/desktop/src/renderer/conversation/conversation.css";
window.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
let latest = {stateVersion:3, currentGoal:null, controlLease:null, coordinator:{pendingContinuation:null,currentExecution:null,workTokens:0,accountedRunIds:[]}};
let conflict = false;
let side = false;
let renderApp;
let reportConflict = false;
function check(value, message) { if (!value) throw Error(message); }
const request = async (method, params) => {
  requests.push({method, params});
  await new Promise(resolve => setTimeout(resolve, 10));
  if (method === "goal.get") return {goal:latest};
  if (conflict) { conflict = false; latest = {...latest,currentGoal:{...latest.currentGoal,revision:8,status:"waiting",lastReason:"等待外部构建"}}; throw Object.assign(new Error("stale"),{code:"CONFLICT"}); }
  if (params.action === "arm") latest = {...latest,currentGoal:{id:"g1",revision:1,condition:params.condition,status:"active",createdAt:1,maxIterations:params.maxIterations,blockCap:8,tokenBudget:params.tokenBudget,iterations:0,tokensAtStart:0,tokensNow:0,tokensBaselinePending:true,consecutiveNoProgress:0,armedAt:1}};
  else latest = {...latest,currentGoal:{...latest.currentGoal,revision:latest.currentGoal.revision+1,status:params.action === "pause" ? "paused" : params.action === "clear" ? "cleared" : "active",lastReason:params.action === "clear" ? "由用户清除" : latest.currentGoal.lastReason}};
  return {goal:latest};
};
function App() {
 const [snapshot,setSnapshot] = useState(latest);
 const [history,setHistory] = useState([]);
 const controls = useConversationGoal({snapshot,costCNY:0.1234,
   onArm: draft => controlGoalRequest(request,{workspacePath:"/project",sessionId:"s1"},{action:"arm",expectedRevision:snapshot.currentGoal?.revision ?? 0,...draft},next=>setSnapshot(next)),
   onAction: async (action,goal) => {
     const ok = await controlGoalRequest(request,{workspacePath:"/project",sessionId:"s1"},{action,goalId:goal.id,expectedRevision:goal.revision},next=>{setSnapshot(next); const item=parseGoalItem({goal:next});if(item){ const goal=next.currentGoal; const canonical=parseConversation({items:[{id:item.id,kind:"goal",title:goal.condition,detail:goal.lastReason,state:goal.status,data:{goalId:goal.id,iterations:goal.iterations,maxIterations:goal.maxIterations,tokensUsed:goal.tokensNow-goal.tokensAtStart,tokenBudget:goal.tokenBudget}}]},"/project","s1").items[0];setHistory(current=>[...current,canonical]); }});
     reportConflict = !ok;
     return ok;
   }
 });
 renderApp = () => setSnapshot({...latest});
 if(side) return <SideChatWorkbarPanel child={{panelId:"p",sourceSessionId:"parent",targetSessionId:"s1",state:"live"}} items={history} draft="" active running={false} loading={false} onSend={()=>{}} onStop={()=>{}} onDraftChange={()=>{}} onRetryCreate={()=>{}} onClose={()=>{}} onSetGoal={controls.openDialog} goalDisabled={!controls.canSetGoal} goalStatus={controls.statusBar} goalDialog={controls.dialog}/>;
 return <><ConversationComposerMenu onSetGoal={controls.openDialog} goalDisabled={!controls.canSetGoal}/>{controls.statusBar}{controls.dialog}<ConversationTranscript items={history}/></>;
}
function find(label) { return [...document.querySelectorAll('button,[role="menuitem"]')].find(el => el.getAttribute("aria-label") === label || el.textContent.trim() === label); }
async function click(label) { const target=find(label);check(target,"missing control: "+label);await act(async()=>{target.click();await new Promise(resolve=>setTimeout(resolve,35));}); }
function field(label) { const target = [...document.querySelectorAll('label[for]')].find(el=>el.textContent.startsWith(label)); return target ? document.getElementById(target.htmlFor) : null; }
async function fill(label,value) { const input=field(label);check(input,"missing field: "+label);await act(async()=>{Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));}); }

(async()=>{
 try {
  const root=createRoot(document.getElementById("app"));
  await act(async()=>root.render(<PicoTheme><App/></PicoTheme>));
  await click("添加上下文与模式");await click("设置 Goal");
  await fill("Goal 完成条件","所有登录集成测试通过");
  check(field("最大迭代次数").value === "50","iteration default");
  await fill("最大迭代次数","201");
  check(document.querySelector('.conversation-goal-dialog button[type="submit"]').disabled,"iteration upper bound");
  await fill("最大迭代次数","50");
  await fill("Goal 完成条件","x".repeat(501));
  check(document.querySelector('.conversation-goal-dialog button[type="submit"]').disabled,"condition upper bound");
  await fill("Goal 完成条件","所有登录集成测试通过");
  await fill("Goal token 限额","999");
  check(document.querySelector('.conversation-goal-dialog button[type="submit"]').disabled,"budget lower bound");
  await fill("Goal token 限额","2000");
  await act(async()=>{const form=document.querySelector('.conversation-goal-dialog');form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,50));});
  check(requests.filter(x=>x.method === "goal.control").length === 1,"duplicate arm sent");
  check(requests[0].params.expectedRevision === 0 && requests[0].params.maxIterations === 50 && requests[0].params.tokenBudget === 2000,"arm contract");
  check(document.body.textContent.includes("等待下一条消息") && document.body.textContent.includes("会话账单 ¥0.1234（含评估）"),"armed status and separate billing");
  await act(async()=>{const pause=find("暂停 Goal");pause.click();pause.click();await new Promise(resolve=>setTimeout(resolve,50));});
  check(requests.filter(x=>x.method === "goal.control").length === 2,"duplicate pause sent");
  check(find("继续 Goal"),"paused goal cannot resume");
  await click("添加上下文与模式");
  check(find("设置 Goal").getAttribute("aria-disabled") === "true" || find("设置 Goal").disabled,"paused goal may be overwritten");
  await click("添加上下文与模式");
  await click("继续 Goal");
  const resume=requests.filter(x=>x.params.action === "resume")[0];check(resume.params.goalId === "g1" && resume.params.expectedRevision === 2,"resume CAS");
  conflict=true;await click("暂停 Goal");
  check(reportConflict && requests.at(-1).method === "goal.get","conflict did not refresh");
  check(requests.filter(x=>x.params.action === "pause").length === 2,"conflict auto-retried");
  check(document.body.textContent.includes("等待外部构建"),"conflict snapshot not visible");
  side=true;await act(async()=>renderApp());
  check(document.querySelector('.tool-panel--side-chat .conversation-goal'),"side chat missing shared status");
  await click("清除 Goal");
  const clear=requests.find(x=>x.params.action === "clear");check(clear.params.expectedRevision === 8,"clear used stale revision");
  check(document.querySelector('.conversation-transcript [data-kind="goal"]')?.textContent.includes("所有登录集成测试通过"),"terminal transcript missing");
  check(document.querySelector('.conversation-transcript [data-kind="goal"]')?.textContent.includes("已清除"),"terminal status missing");
  check(requests.every(x=>x.method === "goal.get" || x.method === "goal.control"),"arming started an execution");
  const creationCalls=[];
  const newRef={workspacePath:"/goal-fixture",sessionId:"new-goal-session"};
  const actions=new Proxy({
    ensureTemporaryWorkspace:async()=>{creationCalls.push("workspace");return newRef.workspacePath;},
    createGoalSession:async(path,settings)=>{creationCalls.push(["create",path,settings]);return newRef;},
    controlGoal:async(ref,input)=>{creationCalls.push(["control",ref,input]);return true;},
    sendMessage:async()=>{throw Error("Goal setup must not send a message");},
  },{get:(target,key)=>target[key] ?? (()=>Promise.resolve())});
  const runtime={preview:true,connection:{kind:"ready"},busy:undefined,message:undefined,data:{...previewData,providerConfig:{...previewData.providerConfig,defaultModelRouteId:"test/a",userDefaults:{modelRouteId:"test/a"},providers:[{id:"test",origin:"user",protocol:"openai",baseURL:"https://fixture.invalid",models:["a"],availableModels:["a"],disabledModels:[]}]}},actions};
  localStorage.setItem("pico.composer-draft:new:unbound","保留输入草稿");
  await act(async()=>root.render(<PicoTheme><RuntimeContext value={runtime}><MemoryRouter initialEntries={["/task/new"]}><Routes><Route path="/task/new" element={<ConversationPage/>}/><Route path="/session/:sessionId" element={<div>Goal 会话就绪</div>}/></Routes></MemoryRouter></RuntimeContext></PicoTheme>));
  await click("添加上下文与模式");await click("设置 Goal");await fill("Goal 完成条件","完成新任务验证");
  await act(async()=>{document.querySelector('.conversation-goal-dialog').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,50));});
  check(creationCalls[0] === "workspace" && creationCalls[1][0] === "create" && creationCalls[2][0] === "control","new task setup order");
  check(creationCalls[2][2].expectedRevision === 0 && creationCalls[2][2].condition === "完成新任务验证","new session Goal arm contract");
  check(localStorage.getItem("pico.composer-draft:"+workspaceSessionKey(newRef)) === "保留输入草稿","Goal setup lost draft");
  check(document.body.textContent.includes("Goal 会话就绪"),"Goal setup did not navigate to new session");
  await fetch("/result",{method:"POST",body:"PASS: goal controls"});
 } catch(error) { await fetch("/result",{method:"POST",body:String(error.stack ?? error)}); }
})();
`;
