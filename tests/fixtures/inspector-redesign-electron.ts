import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
const root = process.argv[2]!;
app.setPath("userData", join(root, "electron"));
let window: BrowserWindow;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (script: string) => window.webContents.executeJavaScript(script);
async function wait(script: string) {
  for (let index = 0; index < 150; index++) {
    if (await js(script)) return;
    await pause(20);
  }
  throw new Error(`Timeout: ${script}\n${await js("document.body.innerText")}`);
}
const click = (selector: string) =>
  js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing ${selector}');e.click()})()`,
  );
const openRun = (id: string) => `[data-run-toggle="${id}"]`;
const selected = (id: string) => `[data-step-id="${id}"]`;
async function main() {
  await app.whenReady();
  window = new BrowserWindow({
    show: true,
    width: 640,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(join(root, "index.html"));
  await wait("document.querySelector('[data-step-id=newest-model]')!==null");
  assert.equal(
    await js("document.querySelector('[data-tab=timeline]').getAttribute('aria-selected')"),
    "true",
  );
  assert.equal(
    await js("document.querySelector('[data-run-toggle=earlier]').getAttribute('aria-expanded')"),
    "false",
  );
  let requestCount = await js("window.requests.length");
  await click(selected("newest-model"));
  await wait(
    "document.querySelector('[data-step-id=newest-model]').getAttribute('aria-expanded')==='true'",
  );
  await click('[aria-label="查看 Token 用量总览"]');
  await wait(
    "document.querySelector('[data-tab=overview]').getAttribute('aria-selected')==='true'",
  );
  const ring = '.inspector-overview__chart[aria-label="会话 Token 组成"]';
  await js(`document.querySelector('${ring} .inspector-overview__legend > div').focus()`);
  await wait(`document.querySelector('${ring} [data-segment="缓存输入"]').dataset.active==='true'`);
  assert.equal(
    await js(
      `document.querySelector('${ring} .inspector-overview__ring-label strong').textContent`,
    ),
    "21,000",
  );
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await wait(
    `document.querySelector('${ring} [data-segment="非缓存输入"]').dataset.active==='true'`,
  );
  await js(
    `document.querySelector('${ring} [data-segment="输出（含推理）"]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`,
  );
  await wait(
    `document.querySelector('${ring} .inspector-overview__ring-label strong').textContent==='1,000'`,
  );
  assert.equal(
    await js(
      `document.querySelector('${ring} .inspector-overview__legend > div:last-child').dataset.active`,
    ),
    "true",
  );
  await js(
    `document.querySelector('${ring} [data-segment="输出（含推理）"]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))`,
  );
  await wait(
    `document.querySelector('${ring} [data-segment="非缓存输入"]').dataset.active==='true'`,
  );
  await js("document.activeElement.blur()");
  await wait(
    `document.querySelector('${ring} .inspector-overview__ring-label strong').textContent==='31,000'`,
  );
  assert.match(
    await js(`document.querySelector('${ring} .inspector-overview__legend').textContent`),
    /67.7%/,
  );
  const modelLegend =
    '.inspector-overview__chart[aria-label="累计记录耗时组成"] [data-slice="model"]';
  await js(
    `document.querySelector('${modelLegend}').focus();window.update({...window.page,summary:{...window.page.summary,modelCalls:6,latencyMs:2000}})`,
  );
  await wait(`document.querySelector('${modelLegend}').textContent.includes('模型 · 6 次')`);
  assert.equal(
    await js("window.requests.length"),
    requestCount + 3,
    "live update refreshes the three resources",
  );
  requestCount += 3;
  assert.equal(
    await js(`document.activeElement===document.querySelector('${modelLegend}')`),
    true,
    "live totals retain legend keyboard focus",
  );
  await js("document.activeElement.blur()");
  await click('[data-tab="timeline"]');
  assert.equal(await js("window.requests.length"), requestCount, "tabs make no RPC");
  await click('[aria-label="查看 Token 用量总览"]');
  await wait(
    "document.querySelector('[data-tab=overview]').getAttribute('aria-selected')==='true'",
  );
  await click('[data-tab="timeline"]');
  assert.equal(
    await js("document.querySelector('[data-step-id=newest-model]').getAttribute('aria-expanded')"),
    "true",
    "selected inline step survives tabs",
  );
  await click(selected("newest-model"));
  await wait("!document.querySelector('[aria-label=\"执行步骤详情\"]')");
  await click(openRun("earlier"));
  await click(selected("earlier-tool"));
  await wait(
    "document.querySelector('[data-step-id=earlier-tool]').getAttribute('aria-expanded')==='true'",
  );
  await js("window.refresh()");
  await wait(`window.requests.length===${requestCount + 3}`);
  assert.equal(
    await js("document.querySelector('[data-step-id=earlier-tool]').getAttribute('aria-expanded')"),
    "true",
    "refresh preserves selected step",
  );
  await js(
    "window.update({...window.page,runs:[{...window.page.runs[0],runId:'live',status:'running',steps:[{...window.page.runs[0].steps[0],id:'live-model',status:'running'}]},...window.page.runs]})",
  );
  await wait(
    "document.querySelector('[data-run-toggle=live]')?.getAttribute('aria-expanded')==='true'",
  );
  assert.equal(
    await js("document.querySelector('[data-run-toggle=earlier]').getAttribute('aria-expanded')"),
    "true",
    "manual expansion survives a new run",
  );
  assert.equal(
    await js("document.querySelector('[data-run-toggle=newest]').getAttribute('aria-expanded')"),
    "false",
    "old automatic expansion closes",
  );
  await click(openRun("earlier"));
  await wait("!document.querySelector('[aria-label=\"执行步骤详情\"]')");
  // Empty success runs remain reachable, without cluttering default navigation.
  await js(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('无步骤记录')).click()",
  );
  await wait("document.querySelectorAll('[data-run-id]').length===33");
  await js("document.querySelector('[data-tab=timeline]').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await wait(
    "document.activeElement?.getAttribute('data-tab')==='overview' && document.activeElement?.getAttribute('aria-selected')==='true'",
  );
  window.setContentSize(480, 500);
  await pause(40);
  const overviewScroll = await js(
    "(()=>{const p=document.querySelector('[data-tab=overview]').getAttribute('aria-controls');const e=document.getElementById(p);e.scrollTop=150;return e.scrollTop})()",
  );
  await click('[data-tab="timeline"]');
  const timelineScroll = await js(
    "(()=>{const p=document.querySelector('[data-tab=timeline]').getAttribute('aria-controls');const e=document.getElementById(p);e.scrollTop=200;return e.scrollTop})()",
  );
  assert.ok(
    timelineScroll > 0 && overviewScroll > 0,
    "both pages independently overflow vertically",
  );
  await click('[data-tab="overview"]');
  assert.equal(
    await js(
      "document.getElementById(document.querySelector('[data-tab=overview]').getAttribute('aria-controls')).scrollTop",
    ),
    overviewScroll,
  );
  await click('[data-tab="timeline"]');
  assert.equal(
    await js(
      "document.getElementById(document.querySelector('[data-tab=timeline]').getAttribute('aria-controls')).scrollTop",
    ),
    timelineScroll,
  );
  await click('[data-tab="overview"]');
  await js("window.mount('s')");
  await pause(50);
  assert.equal(
    await js("document.querySelector('[data-tab=overview]').getAttribute('aria-selected')"),
    "true",
    "same scope keeps tab",
  );
  await js("window.delayQueries=true;window.refresh()");
  await wait("window.pending.length===3");
  await js("window.mount('other')");
  await wait("window.pending.length===6");
  assert.equal(
    await js("document.querySelector('[data-tab=timeline]').getAttribute('aria-selected')"),
    "true",
    "other scope resets tab",
  );
  assert.equal(
    await js("document.querySelectorAll('[data-run-id]').length"),
    0,
    "other scope immediately clears previous data",
  );
  await js("window.pending.splice(0,3).forEach(resolve=>resolve())");
  await pause(50);
  assert.equal(
    await js("document.querySelectorAll('[data-run-id]').length"),
    0,
    "old scope late responses discarded",
  );
  await js("window.delayQueries=false;window.pending.splice(0).forEach(resolve=>resolve())");
  await wait("document.querySelector('[data-run-toggle=live]')!==null");
  // Pending context must not prevent the next trace/summary refresh, or erase the old snapshot.
  await js("window.delayContext=true;window.refresh()");
  await wait("window.contextPending.length===1");
  const summaryRequests = await js(
    "window.requests.filter(x=>x.startsWith('session.execution.summary:')).length",
  );
  await js("window.refresh()");
  await wait(
    `window.requests.filter(x=>x.startsWith('session.execution.summary:')).length>${summaryRequests}`,
  );
  assert.equal(await js("window.contextPending.length"), 1, "context reads are coalesced");
  await click('[aria-label="查看 Token 用量总览"]');
  await wait("document.body.innerText.includes('正在更新')");
  assert.equal(
    await js("document.body.innerText.includes('≈1,000')"),
    true,
    "old history remains visible",
  );
  await js(
    "window.delayContext=false;window.failContext=true;window.contextPending.splice(0).forEach(resolve=>resolve())",
  );
  await wait("document.body.innerText.includes('更新失败，显示上次记录')");
  assert.equal(
    await js("document.body.innerText.includes('≈1,000')"),
    true,
    "failed refresh retains history",
  );
  await pause(150);
  await js("window.failContext=false;window.refresh()");
  await wait("!document.body.innerText.includes('上下文读取失败')");
  const checks: unknown[] = [];
  const failures: unknown[] = [];
  for (const width of [320, 480, 640]) {
    window.setContentSize(width, 800);
    await pause(40);
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const tab of ["timeline", "overview"]) {
        await click(`[data-tab="${tab}"]`);
        await pause(20);
        const result = await js(`(()=>{
          const panel=document.querySelector('[role=tabpanel]:not([hidden])');
          const rgba=s=>(s.match(/[\\d.]+/g)||[]).map(Number);
          const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
          const ratios=[];
          for(const e of document.querySelectorAll('.tool-panel--inspector *')){
            if(!e.getClientRects().length || ![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) || e.closest('svg'))continue;
            const fg=rgba(getComputedStyle(e).color); let b=e,bg;
            while(b){const c=rgba(getComputedStyle(b).backgroundColor);if(c.length===3||c[3]===1){bg=c;break;}b=b.parentElement;}
            if(!bg)bg=[255,255,255]; const a=lum(fg),z=lum(bg);const ratio=(Math.max(a,z)+.05)/(Math.min(a,z)+.05);
            ratios.push({text:e.textContent.trim().slice(0,60),ratio,fg:getComputedStyle(e).color,bg});
          }
          return {width:innerWidth,overflow:Math.max(document.documentElement.scrollWidth,panel.scrollWidth)-innerWidth,min:Math.min(...ratios.map(x=>x.ratio)),failures:ratios.filter(x=>x.ratio<4.5)};
        })()`);
        if (result.overflow > 1 || result.min < 4.5)
          failures.push({ width, theme, tab, ...result });
        checks.push({ width, theme, tab, minimumContrast: result.min });
      }
    }
  }
  assert.deepEqual(failures, [], `Layout/contrast failures: ${JSON.stringify(failures)}`);
  console.log(
    "INSPECTOR_REDESIGN_ELECTRON_OK",
    JSON.stringify({ checks, requests: await js("window.requests.length") }),
  );
}
void main()
  .then(() => {
    window?.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    window?.destroy();
    app.exit(1);
  });
