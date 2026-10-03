import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "桌面审阅重开与刷新保留未知操作，原键重试并导航 Rewind 目标",
  { timeout: 45_000 },
  async (t) => {
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
        contents: reviewScenario,
        resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
        loader: "tsx",
      },
      outdir: "/virtual-pico-pages",
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
      assert.match(result, /^PASS: review recovery and rewind navigation$/, result);
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
  },
);

const reviewScenario = String.raw`
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter,useLocation} from "react-router-dom";
import {ReviewPage} from "./apps/desktop/src/renderer/pages/ReviewPage.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {previewData} from "./apps/desktop/src/renderer/fixture.ts";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
Object.assign(globalThis,{React,IS_REACT_ACT_ENVIRONMENT:true});
const root=createRoot(document.getElementById("app"));
const check=(value,message)=>{if(!value)throw new Error(message);};
const button=name=>{
 const el=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()===name||el.getAttribute("aria-label")===name);
 check(el,"Missing button "+name);return el;
};
const click=async name=>act(async()=>{button(name).click();});
const writes=[];
let supported=true;
const workspacePath=previewData.workspacePath;
const sessionId="session-atlas";
const runtime={preview:false,busy:undefined,data:{...previewData,runs:previewData.runs.map(run=>({...run,status:"succeeded"}))},actions:{
 queryReview:async()=>({changes:[{path:"a.ts",status:"modified",additions:1,deletions:1,patch:"-old\n+new"}],fingerprint:"review-fingerprint"}),
 supportsReviewIdempotency:()=>supported,
 reviewChanges:async(decision,message,target)=>{
   writes.push({decision,message,target});
   if(writes.length===1)throw new Error("Host accepted; reply lost");
   return true;
 },
 applyChanges:async()=>{},
 previewRewind:async()=>({checkpointId:"checkpoint",fingerprint:"rewind-fingerprint",changeCount:1}),
 applyRewind:async()=>({workspacePath,sessionId:"rewound-session"}),
}};
const initial="/review?"+new URLSearchParams({workspace:workspacePath,sessionId});
function Probe(){const location=useLocation();return <output id="location">{location.pathname+location.search}</output>;}
let generation=0;
const mount=()=>act(async()=>{root.render(<PicoTheme><MemoryRouter key={++generation} initialEntries={[initial]}><RuntimeContext.Provider value={runtime}><Probe/><ReviewPage/></RuntimeContext.Provider></MemoryRouter></PicoTheme>);});
async function run(){
 localStorage.clear();
 await mount();
 await act(async()=>{
  const input=document.querySelector(".review-composer input");check(input,"Missing comment");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"原评论");
  input.dispatchEvent(new Event("input",{bubbles:true}));
 });
 await click("发送意见");
 check(writes.length===1,"One initial dispatch");
 check(document.querySelector(".review-composer input").value==="原评论","Unknown result preserves comment");
 await mount();
 check(writes.length===1,"Remount never automatically resends");
 check(document.querySelector(".review-composer input").value==="原评论","Remount restores original comment");
 await click("刷新审阅");
 check(button("使用原操作重试确认"),"Refresh preserves unknown intent");
 supported=false;
 await mount();
 check(button("使用原操作重试确认").disabled,"Old Host cannot retry an unknown request");
 supported=true;
 await mount();
 await click("使用原操作重试确认");
 check(writes.length===2,"One explicit retry");
 check(JSON.stringify(writes[0])===JSON.stringify(writes[1]),"Retry preserves complete original payload and key");
 check(document.getElementById("location").textContent.startsWith("/session/session-atlas?"),"Accepted revision returns to source conversation");
 await mount();
 await click("批准更改");
 check(writes[2].target.idempotencyKey!==writes[1].target.idempotencyKey,"A new intent gets a new UUID");
 await click("Rewind");
 await click("预览 Rewind");
 await click("确认 Rewind");
 check(document.getElementById("location").textContent.startsWith("/session/rewound-session?"),"Rewind follows returned Session target");
 return "PASS: review recovery and rewind navigation";
}
run().then(async result=>{document.getElementById("result").textContent=result;await fetch("/result",{method:"POST",body:result});}).catch(async error=>{const result="FAIL: "+(error.stack||error.message);document.getElementById("result").textContent=result;await fetch("/result",{method:"POST",body:result});});
`;
