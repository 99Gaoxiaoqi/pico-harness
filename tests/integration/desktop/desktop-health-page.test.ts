import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SystemSettingsPage } from "../../../apps/desktop/src/renderer/pages/SettingsPage.js";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import { emptyData } from "../../../apps/desktop/src/renderer/model.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("健康页区分配置与验证，高级诊断只列正式项目和当前临时任务", { timeout: 45_000 }, async (t) => {
  // tsx uses the desktop's JSX-preserve config; provide the classic JSX runtime for SSR.
  const globals = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = globals.React;
  globals.React = React;
  t.after(() => {
    if (previousReact) globals.React = previousReact;
    else Reflect.deleteProperty(globals, "React");
  });
  const store = {
    connection: { kind: "ready" },
    data: {
      ...emptyData,
      workspacePath: "/tmp/current",
      workspaces: [
        { path: "/project", name: "项目", temporary: false },
        { path: "/tmp/current", temporary: true },
        { path: "/tmp/old", temporary: true },
      ],
      modelRoutes: [{ id: "test/model", label: "model" }],
      mcpScope: {
        userItems: [{ id: "user-mcp", name: "用户 MCP", state: "ready", description: "已配置" }],
        workspacePath: "/other",
      },
      mcpServers: [{ id: "project-mcp", name: "其他项目 MCP", state: "attention" }],
      runs: [{ id: "run", workspacePath: "/tmp/current", status: "failed", updatedAt: 1 }],
    },
    actions: {},
  } as unknown as RuntimeStore;
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RuntimeContext.Provider, { value: store }, createElement(SystemSettingsPage)),
    ),
  );
  assert.match(html, /已配置/);
  assert.match(html, /未验证/);
  assert.doesNotMatch(html, /最近一次任务失败|其他项目 MCP/);
  assert.match(html, /用户 MCP/);
  assert.match(html, /<details[^>]*><summary>高级诊断<\/summary>/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /当前无项目任务/);
  assert.doesNotMatch(html, /macOS 系统授权/);
  assert.match(html, /操作系统授权/);

  const result = await runRendererBrowserScenario(`
import "./apps/desktop/src/renderer/layers.css";
import * as React from "react";
import {act} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import {SystemSettingsPage} from "./apps/desktop/src/renderer/pages/SettingsPage.tsx";
import {RuntimeContext} from "./apps/desktop/src/renderer/runtime-context.tsx";
import {PicoTheme} from "./apps/desktop/src/renderer/astryx-provider.tsx";
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const root=createRoot(document.getElementById("app"));
const checks=[];
let workspaceChanges=0;
const store=${JSON.stringify(store)};
store.actions={
  runDiagnostics:async(kind,path)=>{checks.push([kind,path]);return undefined;},
  selectWorkspace:()=>{workspaceChanges++;},
};
const check=(value,message)=>{if(!value)throw new Error(message);};
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const click=async(el)=>{check(el,"Missing control");await act(async()=>el.click());await frame();};
const option=(text)=>[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.trim()===text);
const report=(body)=>fetch('/result',{method:'POST',body});
(async()=>{
try{
  await act(async()=>root.render(<PicoTheme><MemoryRouter><RuntimeContext.Provider value={store}><SystemSettingsPage/></RuntimeContext.Provider></MemoryRouter></PicoTheme>));
  const details=document.querySelector('details');
  await click(details.querySelector('summary'));
  const selector=()=>document.querySelector('[role="combobox"]');
  check(selector().textContent.trim()==="当前无项目任务","Current temporary workspace must be selected");
  await click(selector());
  const options=[...document.querySelectorAll('[role="option"]')].map(el=>el.textContent.trim());
  check(JSON.stringify(options)===JSON.stringify(["选择项目","项目","当前无项目任务"]),"Unexpected diagnostic workspace options: "+JSON.stringify(options));
  await click(option("项目"));
  check(selector().textContent.trim()==="项目","Project selection must update the trigger");
  const start=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==="开始检查");
  await click(start);
  await click(selector());
  await click(option("当前无项目任务"));
  await click(start);
  check(JSON.stringify(checks)===JSON.stringify([["runtime","/project"],["runtime","/tmp/current"]]),"Diagnostics must receive the selected workspace path: "+JSON.stringify(checks));
  check(workspaceChanges===0,"Diagnostic selection must not switch the conversation workspace");
  await act(async()=>root.unmount());
  await report('PASS: health workspace selection');
}catch(error){await report('FAIL: '+(error.stack??error.message));}
})();
`);
  assert.equal(result, "PASS: health workspace selection", result);
});
