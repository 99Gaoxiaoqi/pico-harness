import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const root = process.argv[2];
const assets = JSON.parse(readFileSync(join(root, "assets.json"), "utf8"));
const server = createServer((req, res) => {
  const name = req.url === "/" ? "index.html" : req.url.slice(1);
  if (!["index.html", "renderer.js", "renderer.css"].includes(name)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html",
  );
  res.end(readFileSync(join(root, name)));
});
let window;
app.whenReady().then(async () => {
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    window = new BrowserWindow({
      show: false,
      width: 980,
      height: 780,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const { installMainFrameMediaPermissions } = createRequire(import.meta.url)(
      join(root, "permissions.cjs"),
    );
    installMainFrameMediaPermissions(window.webContents);
    const run = (script) =>
      Promise.race([
        window.webContents.executeJavaScript(script, true),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`executeJavaScript timeout: ${script.slice(0, 100)}`)),
            8000,
          ),
        ),
      ]);
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await run(
      `window.mediaAssets=${JSON.stringify(assets)};window.queries=[];window.saves=[];window.revoked=[];window.created=[];const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=(blob)=>{const url=create(blob);created.push(url);return url};URL.revokeObjectURL=(url)=>{revoked.push(url);revoke(url)};window.pico={artifacts:{saveAs:async(ref)=>{saves.push(ref);return {ok:true}}},runtime:{'session.artifacts.query':async(params)=>{queries.push(params);if(params.sessionId==='bounded'){window.activeReads=(window.activeReads||0)+1;window.maxReads=Math.max(window.maxReads||0,window.activeReads);await new Promise(r=>setTimeout(r,60));window.activeReads--;}if(params.sessionId==='old')await new Promise(r=>setTimeout(r,300));const item=mediaAssets.find(i=>i.reference.artifactId===params.artifactId);if(!item||params.workspacePath!=='/fixture')return {ok:false,error:{code:'not_found',message:'unknown',retryable:false}};const artifact={artifactId:item.reference.artifactId,title:item.reference.alt,mimeType:item.reference.mimeType,sizeBytes:item.reference.sizeBytes,digest:item.reference.digest};if(params.action==='get')return {ok:true,value:{revision:1,artifacts:[artifact]}};const binary=atob(item.base64),offset=params.offsetBytes,end=Math.min(binary.length,offset+params.limitBytes);let slice=binary.slice(offset,end);if(window.corrupt)slice=slice.slice(0,-1)+String.fromCharCode(slice.charCodeAt(slice.length-1)^1);return {ok:true,value:{artifact,contentBase64:btoa(slice),offsetBytes:offset,endOffsetBytes:end,totalBytes:binary.length,truncated:end<binary.length,...(end<binary.length?{nextOffsetBytes:end}:{})}}}}};void 0;`,
    );
    const waitFor = async (condition, timeout = 6000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await run(condition)) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`Timed out: ${condition}; DOM: ${await run("document.body.textContent")}`);
    };
    const mount = async (reference, text = "", sessionId = "main", side = false) => {
      await run(
        `mediaFixture.mount([{id:'answer',kind:'assistantMessage',text:${JSON.stringify(text)},media:[${JSON.stringify(reference)}]}],{workspacePath:'/fixture',sessionId:${JSON.stringify(sessionId)}},${side})`,
      );
    };
    const png = assets[0].reference;
    await mount({ ...png, source: "/fixture/pixel.png" }, "![图](/fixture/pixel.png)");
    await waitFor("document.querySelector('img')?.naturalWidth===1");
    assert.equal(await run("document.querySelectorAll('.conversation-media').length"), 1);
    await run("document.querySelector('.conversation-media__image-button').click()");
    await waitFor("document.querySelector('dialog')?.open===true");
    await window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    await window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor("!document.querySelector('dialog')");
    await run("document.querySelector('.conversation-media__save').click()");
    assert.deepEqual(await run("saves[0]"), {
      workspacePath: "/fixture",
      sessionId: "main",
      artifactId: png.artifactId,
    });
    await mount(png, "", "sidechild", true);
    await waitFor(
      "queries.some(q=>q.sessionId==='sidechild') && document.querySelector('img')?.naturalWidth===1",
    );
    assert.equal(await run("queries.filter(q=>q.sessionId==='parent').length"), 0);
    const loadedSource = await run("document.querySelector('img').src");
    await run("mediaFixture.clear()");
    await waitFor(`revoked.includes(${JSON.stringify(loadedSource)})`);
    for (const asset of assets.slice(1)) {
      await mount(asset.reference, `[播放](pico://artifact/${asset.reference.artifactId})`);
      await waitFor("document.querySelector('video')?.readyState>=1");
      const metadata = await run(
        "(()=>{const v=document.querySelector('video');return {width:v.videoWidth,duration:v.duration,autoplay:v.autoplay,preload:v.preload}})()",
      );
      assert.equal(metadata.width, 160);
      assert.ok(metadata.duration >= 1);
      assert.equal(metadata.autoplay, false);
      assert.equal(metadata.preload, "metadata");
      await run("document.querySelector('video').play().then(()=>true)");
      await waitFor("document.querySelector('video').currentTime>0.05");
      const seek = await run(
        "new Promise((resolve,reject)=>{const v=document.querySelector('video');v.pause();v.addEventListener('seeked',()=>resolve(v.currentTime),{once:true});v.addEventListener('error',()=>reject(new Error('video error')),{once:true});v.currentTime=0.7})",
      );
      assert.ok(Math.abs(seek - 0.7) < 0.1);
      await run("window.previousVideo=document.querySelector('video');mediaFixture.clear()");
      await waitFor("previousVideo.paused && !previousVideo.hasAttribute('src')");
      console.log(
        `MEDIA_CODEC_OK ${asset.reference.mimeType} ${metadata.width}x90 duration=${metadata.duration}`,
      );
    }
    // Entire offscreen history stays inert until it approaches the viewport.
    const beforeOffscreen = await run("queries.length");
    await run("document.querySelector('#root').style.marginTop='2400px'");
    await mount(png, "", "offscreen");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await run("queries.length"), beforeOffscreen);
    await run("document.querySelector('#root').style.marginTop='0'");
    await waitFor("document.querySelector('img')?.naturalWidth===1");
    // Several visible references share the bounded session read queue.
    await run(
      `const refs=Array.from({length:4},(_,i)=>({...mediaAssets[0].reference,artifactId:'bounded-'+i}));refs.forEach(reference=>mediaAssets.push({reference,base64:mediaAssets[0].base64}));mediaFixture.mount([{id:'batch',kind:'assistantMessage',text:'',media:refs}],{workspacePath:'/fixture',sessionId:'bounded'});void 0;`,
    );
    await waitFor(
      "document.querySelectorAll('img').length===4 && [...document.querySelectorAll('img')].every(image=>image.naturalWidth===1)",
    );
    assert.equal(await run("maxReads"), 2);
    await run("mediaFixture.clear()");
    await waitFor("document.querySelectorAll('.conversation-media').length===0");
    // Late old-session metadata may never create a URL after a session change.
    const createdBefore = await run("created.length");
    await mount(png, "", "old");
    await waitFor("queries.some(q=>q.sessionId==='old')");
    await mount(png, "", "new");
    await waitFor("document.querySelector('img')?.naturalWidth===1");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await run("created.length"), createdBefore + 1);
    assert.equal(
      await run("queries.filter(q=>q.sessionId==='old'&&q.action==='read_chunk').length"),
      0,
    );
    await run("mediaFixture.clear()");
    await waitFor("document.querySelectorAll('.conversation-media').length===0");
    const queriesBefore = await run("queries.length");
    await run(
      `mediaFixture.mount([{id:'inert',kind:'assistantMessage',text:'![remote](https://example.com/image.png)\\n\\n![unsafe](javascript:alert(1))\\n\\n![local](/fixture/no.png)\\n\\n\\x60\\x60\\x60md\\n![code](/fixture/pixel.png)\\n\\x60\\x60\\x60'}],{workspacePath:'/fixture',sessionId:'safe'})`,
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await run("document.querySelectorAll('img,video').length"), 0);
    assert.equal(await run("queries.length"), queriesBefore);
    await run(
      `mediaFixture.mount([{id:'no-context',kind:'assistantMessage',text:'![no](pico://artifact/pixel.png)',media:[${JSON.stringify(png)}]}])`,
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await run("document.querySelectorAll('img,video').length"), 0);
    assert.equal(await run("queries.length"), queriesBefore);
    await run("window.corrupt=true");
    await mount(png, "", "tampered");
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('校验失败')");
    assert.equal(await run("document.querySelectorAll('img,video').length"), 0);
    await run("window.corrupt=false");
    // File pane goes through the same verification and display component.
    await run(
      `mediaFixture.preview(${JSON.stringify(assets[1].reference)},${JSON.stringify(assets[1].base64)})`,
    );
    await waitFor("document.querySelector('video')?.readyState>=1");
    await run("document.querySelector('video').requestFullscreen()");
    await waitFor("document.fullscreenElement?.tagName==='VIDEO'");
    await run("document.exitFullscreen()");
    // Same-origin child frames and unrelated permissions remain denied.
    const childPermissions = await run(
      `(async()=>{const frame=document.createElement('iframe');frame.src='/';document.body.append(frame);await new Promise(resolve=>frame.onload=resolve);let denied=false;try{await frame.contentDocument.documentElement.requestFullscreen()}catch{denied=true}frame.remove();return denied})()`,
    );
    assert.equal(childPermissions, true);
    await run("mediaFixture.clear()");
    await waitFor("created.every(url=>revoked.includes(url))");
    console.log("DESKTOP_CHAT_MEDIA_OK");
    window.destroy();
    server.close();
    app.quit();
  } catch (error) {
    console.error(error);
    window?.destroy();
    server.close();
    app.exit(1);
  }
});
