const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createServer } = require("node:http");
const root = process.argv[2];
const { installArtifactPreviewSecurity } = require(join(root, "security.cjs"));
let networkRequests = 0;
const server = createServer((_request, response) => {
  networkRequests++;
  response.end("escaped");
});
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const html = JSON.parse(readFileSync(join(root, "document.json"), "utf8")).replaceAll(
      "PORT",
      String(port),
    );
    const window = new BrowserWindow({
      show: false,
      width: 960,
      height: 640,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    installArtifactPreviewSecurity(window.webContents);
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let navigationsBlocked = 0;
    window.webContents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && event.defaultPrevented) navigationsBlocked++;
    });
    await window.loadURL('data:text/html,<h1 id="parent">Host shell</h1>');
    await window.webContents.executeJavaScript(
      `window.result=null;window.addEventListener('message',event=>{window.result=event.data});const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.style='width:95%;height:450px';frame.srcdoc=${JSON.stringify(html)};document.body.append(frame);`,
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    const result = await window.webContents.executeJavaScript("window.result");
    assert.equal(result.parentBlocked, true);
    assert.equal(result.rtcBlocked, true);
    assert.equal(
      await window.webContents.executeJavaScript("document.querySelector('#parent').textContent"),
      "Host shell",
    );
    const frame = window.webContents.mainFrame.frames.find((frame) => frame.url === "about:srcdoc");
    assert.ok(frame);
    assert.equal(
      await frame.executeJavaScript("document.querySelector('button').textContent"),
      "交互成功",
    );
    assert.equal(
      await frame.executeJavaScript(
        `(()=>{const child=document.createElement('iframe');document.body.append(child);try{return typeof child.contentWindow.RTCPeerConnection==='function'}catch{return false}finally{child.remove()}})()`,
      ),
      false,
    );
    assert.equal(networkRequests, 0);
    assert.ok(navigationsBlocked > 0);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    if (process.env.PICO_PREVIEW_SCREENSHOT)
      writeFileSync(
        process.env.PICO_PREVIEW_SCREENSHOT,
        (await window.webContents.capturePage()).toPNG(),
      );
    await window.webContents.executeJavaScript(readFileSync(join(root, "renderer.js"), "utf8"));
    await window.webContents.executeJavaScript(
      `window.revoked=[];const originalRevoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=(url)=>{window.revoked.push(url);originalRevoke(url)};void 0;`,
    );
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const mountBinary = async (mimeType, base64) => {
      const artifact = {
        id: "binary",
        name: "preview",
        mimeType,
        size: Buffer.from(base64, "base64").length,
        createdAt: "2026-09-21",
      };
      const content = {
        artifactId: artifact.id,
        encoding: "base64",
        content: base64,
        offset: 0,
        nextOffset: artifact.size,
        totalSize: artifact.size,
        complete: true,
      };
      await window.webContents.executeJavaScript(
        `mountPreview(${JSON.stringify(artifact)},${JSON.stringify(content)})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    };
    await mountBinary("image/png", png);
    const image = await window.webContents.executeJavaScript(
      `({src:document.querySelector('img').src,width:document.querySelector('img').naturalWidth})`,
    );
    assert.equal(image.width, 1);
    assert.ok(image.src.startsWith("blob:"));
    await window.webContents.executeJavaScript("unmountPreview()");
    assert.deepEqual(await window.webContents.executeJavaScript("window.revoked"), [image.src]);
    await mountBinary("image/png", Buffer.from("<html>spoofed image</html>").toString("base64"));
    assert.match(
      await window.webContents.executeJavaScript(
        "document.querySelector('[role=alert]').textContent",
      ),
      /格式不符/,
    );
    await window.webContents.executeJavaScript("unmountPreview()");
    // A valid one-page PDF; exercise the actual embed and Blob lifetime.
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\n\nendstream",
    ];
    bodies.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await mountBinary("application/pdf", Buffer.from(pdf).toString("base64"));
    const pdfSrc = await window.webContents.executeJavaScript(
      "document.querySelector('embed').src",
    );
    assert.ok(pdfSrc.startsWith("blob:"));
    await window.webContents.executeJavaScript("unmountPreview()");
    assert.deepEqual(await window.webContents.executeJavaScript("window.revoked"), [
      image.src,
      pdfSrc,
    ]);
    assert.equal(networkRequests, 0);
    console.log("ARTIFACT_PREVIEW_SECURITY_OK");
    server.close();
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    server.close();
    app.exit(1);
  });
