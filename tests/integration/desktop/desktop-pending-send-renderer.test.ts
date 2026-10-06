import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "Desktop renderer 重建后通过全局列表恢复原请求并保留变更草稿",
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
        contents: recoveryScenario,
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
    const profile = await mkdtemp(join(tmpdir(), "pico-send-recovery-ui-"));
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
      assert.match(result, /^PASS: send recovery$/, result);
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

const recoveryScenario = `
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useRuntimeStore } from "./apps/desktop/src/renderer/runtime.ts";
import { PendingSendList } from "./apps/desktop/src/renderer/PendingSendNotice.tsx";
import { usePersistentDraft, writePersistentDraft, readPersistentDraft } from "./apps/desktop/src/renderer/conversation/usePersistentDraft.ts";
window.IS_REACT_ACT_ENVIRONMENT = true;
const calls = [];
let sendMode = "unknown";
let supportReplay = true;
let currentHome = "/state/a";
let store;
let draftControls;
let root;
const check = (condition, message) => { if (!condition) throw Error(message); };
window.pico = {
 runtime: new Proxy({}, {get: (_target, method) => async params => {
   if (method === "runtime.ping") return {ok:true,value:{picoHome:currentHome,capabilities:["session-conversation-v1","structured-skills-v1",...(supportReplay?["session-send-replay-v1"]:[])]}};
   if (method === "workspace.list") return {ok:true,value:{workspaces:[]}};
   if (method === "session.send") {
     calls.push(JSON.parse(JSON.stringify(params)));
     if (sendMode === "unknown") return {ok:false,error:{code:"RUNTIME_REQUEST_TIMEOUT",message:"response lost",retryable:false}};
     if (sendMode === "unavailable") return {ok:false,error:{code:"SEND_RECOVERY_UNAVAILABLE",message:"expired",retryable:false,outcome:"unknown"}};
     return {ok:true,value:{session:{sessionId:"accepted-original"}}};
   }
   return {ok:false,error:{code:"NOT_FOUND",message:"original session unavailable",retryable:false}};
 }}),
 platform:{getLaunchAtLogin:async()=>({ok:true,value:false})},
 lifecycle:{getBackgroundMode:async()=>({ok:true,value:false})},
 onUnavailable:()=>()=>{},onRecovered:()=>()=>{},
 events:{subscribe:()=>({ready:Promise.resolve({ok:false,error:{code:"NOT_FOUND",message:"missing",retryable:false}}),dispose(){}})},
 sessionFrames:{subscribe:()=>({dispose(){}})},
};
function Harness() {
 store = useRuntimeStore();
 const draft = usePersistentDraft("new:unbound");
 draftControls = draft;
 const location = useLocation();
 return <><textarea aria-label="draft" value={draft.value} onChange={event=>draft.update(event.target.value)}/><PendingSendList runtime={store}/><p id="route">{location.pathname+location.search}</p><p id="message">{store.message}</p></>;
}
const settle = async () => { await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));}); };
const mount = async () => {
 root=createRoot(document.getElementById("app"));
 await act(async()=>root.render(<MemoryRouter><Harness/></MemoryRouter>));
 for (let i=0;i<30&&store.connection.kind!=="ready";i++) await settle();
 check(store.connection.kind==="ready", "Renderer bootstrap failed "+JSON.stringify(store.connection));
 await settle();
};
const remount = async () => { await act(async()=>root.unmount()); await mount(); };
(async()=>{
 localStorage.clear();
 writePersistentDraft("new:unbound","original raw /skill draft");
 await mount();
 const original={workspacePath:"/state/temporary-original",sourceKey:"new:unbound",draftSnapshot:"original raw /skill draft",text:"任务正文",skills:[{name:"review",sourceId:"user:review",sourcePath:"/skills/review"}],initialSettings:{modelRouteId:"test/original",permissionMode:"auto",collaborationMode:"agent",orchestrationMode:"default",thinkingEffort:"high"},behavior:"replace",expectedRunId:"original-run"};
 let first;
 await act(async()=>{first=await store.actions.sendMessage(original);});
 check(!first.succeeded && calls.length===1,"Initial unknown must preserve pending");
 const frozen=calls[0];
 check(!("replayOnly" in frozen)&&frozen.workspacePath==="/state/temporary-original","Initial send is ordinary and has resolved temporary workspace");
 await remount();
 check(store.pendingSends.length===1,"Renderer reconstruction must load localStorage pending");
 check(document.querySelector("textarea").value==="original raw /skill draft","Draft survived reconstruction");
 await act(async()=>{check(!(await store.actions.sendMessage({...original,text:"changed",initialSettings:{modelRouteId:"test/changed"}})).succeeded,"New send blocked");});
 check(calls.length===1,"Pending composer cannot send a new logical request");
 supportReplay=false;await remount();
 check(document.querySelector(".pending-send-notice button").disabled,"Old host must disable recovery");
 await act(async()=>{await store.actions.recoverPendingSend("new:unbound");});
 check(calls.length===1&&store.pendingSends.length===1,"No fallback RPC without replay capability");
 supportReplay=true;await remount();
 // Keep other sources pending so recovery is accessible even without those panels.
 for(const sourceKey of ['side:["/project","parent","panel"]','research-implement:["/project","research"]']) {
   await act(async()=>{await store.actions.sendMessage({...original,sourceKey,draftSnapshot:sourceKey});});
 }
 check(store.pendingSends.length===3,"Three entry scopes coexist");
 check(document.querySelector("summary").textContent.includes("3"),"Global list exposes closed side/research entries");
 currentHome="/state/b";await remount();
 check(store.pendingSends.length===0,"Different picoHome must not expose or replay previous records");
 currentHome="/state/a";await remount();
 sendMode="unavailable";
 await act(async()=>{await store.actions.recoverPendingSend("new:unbound");});
 check(store.pendingSends.length===3&&store.message.includes("500"),"Missing Host receipt remains pending with window guidance");
 await act(async()=>draftControls.update("new draft after lost response"));
 check(document.querySelector("textarea").value==="new draft after lost response","Changed draft is visible before recovery");
 await remount();
 sendMode="success";
 await act(async()=>document.querySelector('[data-pending-source="new:unbound"] button').click());
 await settle();
 check(JSON.stringify(calls.at(-1))===JSON.stringify({...frozen,replayOnly:true}),"Recovery must use every frozen field and original key: "+JSON.stringify({actual:calls.at(-1),expected:{...frozen,replayOnly:true}}));
 check(document.querySelector("textarea").value==="new draft after lost response","Recovery cannot clear a changed draft");
 check(readPersistentDraft("new:unbound")==="new draft after lost response","Changed draft persists");
 check(store.pendingSends.length===2,"Confirmed recovery removes only its scope");
 check(document.getElementById("route").textContent.includes("accepted-original"),"Recover navigates to original confirmed session");
 check(store.message.includes("已确认"),"Transcript refresh failure keeps acknowledged success visible");
 const before=calls.length;
 const realSetItem=Storage.prototype.setItem;
 Storage.prototype.setItem=function(key,value){if(key.startsWith("pico.pending-send:"))throw Error("storage blocked");return realSetItem.call(this,key,value);};
 await act(async()=>{check(!(await store.actions.sendMessage({...original,text:"unsaved"})).succeeded,"Storage failure fails closed");});
 Storage.prototype.setItem=realSetItem;
 check(calls.length===before,"Storage failure makes zero RPCs");
 // Explicit abandonment preserves text and permits a fresh key.
 const sideKey=store.pendingSends.find(entry=>entry.scope.sourceKey.startsWith("side:")).scope.sourceKey;
 writePersistentDraft(sideKey,"side draft preserved");
 const sideOriginal=store.pendingSends.find(entry=>entry.scope.sourceKey===sideKey).record.params.idempotencyKey;
 await act(async()=>store.actions.abandonPendingSend(sideKey));
 check(readPersistentDraft(sideKey)==="side draft preserved","Abandon keeps text");
 await act(async()=>{check((await store.actions.sendMessage({...original,sourceKey:sideKey,text:"new side task",draftSnapshot:"side draft preserved"})).succeeded,"New send after abandonment");});
 check(calls.at(-1).idempotencyKey!==sideOriginal&&!calls.at(-1).replayOnly,"New attempt has a fresh ordinary key");
 check(readPersistentDraft(sideKey)==="","Unchanged acknowledged draft clears");
 await act(async()=>root.unmount());
 const result="PASS: send recovery";document.getElementById("result").textContent=result;await fetch("/result",{method:"POST",body:result});
})().catch(async error=>{const result="FAIL: "+error.stack;document.getElementById("result").textContent=result;await fetch("/result",{method:"POST",body:result});});
`;
