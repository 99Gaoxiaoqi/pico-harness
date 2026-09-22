import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "用量页面以同一条件状态处理初始范围、项目/时间切换、刷新与乱序响应",
  { skip: !process.env.PICO_TEST_ELECTRON },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-usage-query-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await build({
      stdin: {
        contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {MemoryRouter,Routes,Route} from 'react-router-dom';
        import {renderToStaticMarkup} from 'react-dom/server';
        import {ConversationPage} from './apps/desktop/src/renderer/pages/ConversationPage.tsx';
        import {previewData} from './apps/desktop/src/renderer/fixture.ts';
        import {RuntimeContext} from './apps/desktop/src/renderer/runtime-context.tsx';
        import {UsagePage} from './apps/desktop/src/renderer/usage/UsagePage.tsx';
        window.renderConversation=(usage)=>{
          const conversations=Object.fromEntries(Object.entries(previewData.conversations).map(([key,value])=>[key,{...value,usage}]));
          return renderToStaticMarkup(<MemoryRouter initialEntries={['/sessions/session-atlas?workspace='+encodeURIComponent(previewData.workspacePath)]}><RuntimeContext.Provider value={{data:{...previewData,conversations},actions:{},preview:true}}><Routes><Route path='/sessions/:sessionId' element={<ConversationPage/>}/></Routes></RuntimeContext.Provider></MemoryRouter>);
        };
        window.pending=[];
        const runtime={ data:{ usage:{ workspacePath:'/first',totalTokens:777,cacheAlerts:['旧项目诊断'] },workspaces:[{path:'/first',name:'项目一'},{path:'/second',name:'项目二'}] },actions:{queryUsage:input=>new Promise((resolve,reject)=>window.pending.push({input,resolve,reject}))}};
        createRoot(document.getElementById('root')).render(<MemoryRouter><RuntimeContext.Provider value={runtime}><UsagePage /></RuntimeContext.Provider></MemoryRouter>);
      `,
        resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
        loader: "tsx",
      },
      loader: { ".css": "empty" },
      bundle: true,
      platform: "browser",
      jsx: "automatic",
      format: "iife",
      outfile: join(root, "renderer.js"),
      banner: { js: "const __fixtureGlob = () => ({});" },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.glob": "__fixtureGlob" },
    });
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.env.PICO_TEST_ELECTRON!,
        [fileURLToPath(new URL("../../fixtures/usage-query-electron.mjs", import.meta.url)), root],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += String(data);
      });
      child.stderr.on("data", (data) => {
        output += String(data);
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron timeout: ${output}`));
      }, 20000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(output);
        else reject(new Error(output));
      });
    });
    assert.match(output, /usage query scope and response race passed/);
  },
);
