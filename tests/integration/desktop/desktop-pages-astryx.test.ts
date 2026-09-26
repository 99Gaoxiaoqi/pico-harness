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
          : '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>',
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
import * as React from "react";
import {act,useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {AutomationsPage} from "./apps/desktop/src/renderer/pages/AutomationsPage.tsx";
import {SessionsPage} from "./apps/desktop/src/renderer/pages/SessionsPage.tsx";
import {ComposerModelPicker} from "./apps/desktop/src/renderer/ComposerModelPicker.tsx";
import {ConversationInteractionSlot} from "./apps/desktop/src/renderer/conversation/ConversationInteractionSlot.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
import "@astryxdesign/core/astryx.css";
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
  const decisions=[];
  await act(async()=>root.render(<ConversationInteractionSlot approval={{id:"approval",kind:"plan",title:"计划",detail:"说明",planSteps:["步骤"]}} busy={false} onApprovalDecision={(...args)=>decisions.push(args)} onPromptAnswer={()=>{}}/>));
  check(button("继续修改").disabled,"Empty feedback stays disabled");
  await enter("textarea","保留接口");
  await click("继续修改");
  check(decisions[0][0]==="continue_editing"&&decisions[0][1]==="保留接口","Feedback action keeps decision and text");
  await act(async()=>root.unmount());
}
scenario().then(()=>fetch("/result",{method:"POST",body:"PASS: pages forms model picker and approval"})).catch(error=>fetch("/result",{method:"POST",body:String(error.stack||error)}));
`;
