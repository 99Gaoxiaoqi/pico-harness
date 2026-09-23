import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    const documentPath = join(process.argv[2], "index.html");
    writeFileSync(documentPath, "<div id='root'></div>");
    await window.loadFile(documentPath);
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    await evaluate(readFileSync(join(process.argv[2], "renderer.js"), "utf8"));
    const waitFor = async (condition) => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(condition)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out: ${condition}`);
    };
    const snapshot = () =>
      evaluate(
        `({ project: document.querySelector('[aria-label="统计项目"]').value, text: document.body.textContent, busy: document.querySelector('section').getAttribute('aria-busy') })`,
      );
    const select = async (value) => {
      await evaluate(
        `{const el=document.querySelector('[aria-label="统计项目"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));}`,
      );
    };
    const result = (workspace, total, warning) => ({
      scope: workspace ? "workspace" : "all",
      workspacePath: workspace,
      totalTokens: total,
      providerCallCount: 1,
      usageReportCount: 1,
      details: {
        activities: [],
        activityCount: 0,
        activitiesTruncated: false,
        providers: [],
        models: [],
        tools: [],
        pricing: [],
        knownCacheReadTokens: 0,
        knownCacheWriteTokens: 0,
        cacheReadReportedCallCount: 0,
        cacheWriteReportedCallCount: 0,
        warnings: [],
        unavailableWorkspaces: warning ? [{ workspacePath: "/unreadable", error: warning }] : [],
      },
    });
    const resolve = async (index, value) =>
      evaluate(`window.pending[${index}].resolve(${JSON.stringify(value)});void 0`);
    const header = await evaluate(
      "window.renderConversation({totalTokens:29039,inputTokens:9611,outputTokens:939,reasoningTokens:418})",
    );
    assert.match(header, /title="会话累计 Token：29,039"/);
    assert.match(header, /会话累计 Token 2.9万/);
    assert.doesNotMatch(header, /会话累计 Token 1.1万/);
    const missing = await evaluate(
      "window.renderConversation({inputTokens:9611,outputTokens:939})",
    );
    assert.match(missing, /会话累计 Token 未知/);
    await waitFor("window.pending.length === 1");
    assert.deepEqual(await evaluate("window.pending[0].input"), {});
    assert.equal((await snapshot()).project, "");
    assert.doesNotMatch((await snapshot()).text, /777|旧项目诊断/);
    await resolve(0, result("", 300, "全局诊断"));
    await waitFor("document.body.textContent.includes('全局诊断')");
    await select("/first");
    await waitFor("window.pending.length === 2");
    assert.equal((await snapshot()).project, "/first");
    assert.equal((await snapshot()).busy, "true");
    assert.doesNotMatch((await snapshot()).text, /全局诊断/);
    await resolve(1, result("/first", 100));
    await waitFor("document.querySelector('section').getAttribute('aria-busy') === 'false'");
    assert.match((await snapshot()).text, /总 Token100/);
    await select("/second");
    await waitFor("window.pending.length === 3");
    await select("/first");
    await waitFor("window.pending.length === 4");
    await select("");
    await waitFor("window.pending.length === 5");
    await resolve(4, result("", 300, "全局诊断"));
    await waitFor("document.querySelector('section').getAttribute('aria-busy') === 'false'");
    await resolve(2, result("/second", 200, "过期诊断"));
    await evaluate("window.pending[3].reject(new Error('过期错误'));void 0");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await snapshot()).project, "");
    assert.match((await snapshot()).text, /总 Token300/);
    assert.match((await snapshot()).text, /全局诊断/);
    assert.doesNotMatch((await snapshot()).text, /过期诊断|过期错误/);
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='7 天').click()",
    );
    await waitFor("window.pending.length === 6");
    const range = await evaluate("window.pending[5].input");
    assert.equal(range.workspacePath, undefined);
    assert.equal(range.to - range.from, 7 * 86400000);
    await resolve(5, result("", 40));
    await waitFor("document.querySelector('section').getAttribute('aria-busy') === 'false'");
    await evaluate("document.querySelector('[aria-label=\"刷新用量\"]').click()");
    await waitFor("window.pending.length === 7");
    const refresh = await evaluate("window.pending[6].input");
    assert.equal(refresh.to - refresh.from, 7 * 86400000);
    assert.equal(refresh.workspacePath, undefined);
    await evaluate("window.pending[6].reject(new Error('当前范围失败'));void 0");
    await waitFor("document.body.textContent.includes('当前范围失败')");
    assert.doesNotMatch((await snapshot()).text, /总 Token40/);
    console.log("usage query scope and response race passed");
    window.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
