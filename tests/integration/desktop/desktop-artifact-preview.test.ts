import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { build } from "esbuild";
import {
  FilesWorkbarPanel,
  type WorkbarArtifact,
} from "../../../apps/desktop/src/renderer/workbar-panels/FilesWorkbarPanel.js";
import {
  appendArtifactStreamChunk,
  artifactContentView,
} from "../../../apps/desktop/src/renderer/workbar-panels/FilesPanelController.js";
import {
  ARTIFACT_TEXT_PREVIEW_BYTES,
  artifactHtmlDocument,
  decodeArtifactBinary,
  validateArtifactBinary,
} from "../../../apps/desktop/src/renderer/workbar-panels/artifact-preview-model.js";

Object.assign(globalThis, { React });
const artifact = (mimeType: string, name = "report.md"): WorkbarArtifact => ({
  id: "artifact",
  name,
  mimeType,
  size: 50,
  createdAt: "2026-09-21",
});
function contentFor(text: string, item: WorkbarArtifact) {
  const bytes = Buffer.from(text);
  const split = Math.min(7, bytes.length);
  const first = appendArtifactStreamChunk(undefined, item, {
    contentBase64: bytes.subarray(0, split).toString("base64"),
    offsetBytes: 0,
    endOffsetBytes: split,
    totalBytes: bytes.length,
    truncated: true,
    nextOffsetBytes: split,
  });
  return artifactContentView(
    appendArtifactStreamChunk(first, item, {
      contentBase64: bytes.subarray(split).toString("base64"),
      offsetBytes: split,
      endOffsetBytes: bytes.length,
      totalBytes: bytes.length,
      truncated: false,
    }),
  );
}

test("产物分块经过工作栏渲染为 Markdown、隔离 HTML 和 diff，跨块 Unicode/Base64 保持完整", () => {
  for (const [mime, name, text, expected] of [
    [
      "text/markdown",
      "report.md",
      "# 中文报告 🧪\n\n**验收通过**",
      /<h1><span>中文报告 🧪<\/span><\/h1>/,
    ],
    [
      "text/html",
      "report.html",
      "<h1>报告</h1><script>document.body.dataset.ready='yes'</script>",
      /sandbox="allow-scripts"/,
    ],
    ["text/x-diff", "report.patch", "@@ -1 +1 @@\n-old\n+new", /artifact-preview__added/],
  ] as const) {
    const item = artifact(mime, name);
    const content = contentFor(text, item);
    assert.equal(content.content, text);
    const markup = renderToStaticMarkup(
      createElement(FilesWorkbarPanel, {
        artifacts: [item],
        selectedArtifactId: item.id,
        content,
        loading: false,
        onRefresh() {},
        onSelectArtifact() {},
        onBack() {},
        onLoadChunk() {},
      }),
    );
    assert.match(markup, expected);
  }
  const image = artifact("image/png", "image.png");
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 12, 44, 66]);
  let stream = appendArtifactStreamChunk(undefined, image, {
    contentBase64: bytes.subarray(0, 5).toString("base64"),
    offsetBytes: 0,
    endOffsetBytes: 5,
    totalBytes: bytes.length,
    truncated: true,
    nextOffsetBytes: 5,
  });
  stream = appendArtifactStreamChunk(stream, image, {
    contentBase64: bytes.subarray(5).toString("base64"),
    offsetBytes: 5,
    endOffsetBytes: bytes.length,
    totalBytes: bytes.length,
    truncated: false,
  });
  assert.deepEqual(
    decodeArtifactBinary(artifactContentView(stream).content),
    new Uint8Array(bytes),
  );
  assert.equal(validateArtifactBinary(stream.bytes, image.mimeType), "image/png");
  assert.equal(
    validateArtifactBinary(new TextEncoder().encode("%PDF-1.7\n"), "application/pdf"),
    "application/pdf",
  );
});

test("生成文件先显示全宽列表，再为五类文件显示独立预览与返回入口", () => {
  const artifacts = [
    artifact("text/markdown", "report.md"),
    artifact("text/x-diff", "change.patch"),
    artifact("text/html", "pelican-ride.html"),
    artifact("image/png", "figure.png"),
    artifact("application/pdf", "report.pdf"),
  ].map((item, index) => ({ ...item, id: `artifact-${index}` }));
  const handlers = {
    loading: false,
    onRefresh() {},
    onSelectArtifact() {},
    onBack() {},
    onLoadChunk() {},
    onOpenArtifact() {},
    onSaveArtifactAs() {},
    onOpenDefaultApp() {},
  };
  const list = renderToStaticMarkup(createElement(FilesWorkbarPanel, { artifacts, ...handlers }));
  assert.match(list, /tool-panel__files-list-page/u);
  assert.match(list, /在 Pico 中查看/u);
  assert.doesNotMatch(list, /tool-panel__preview-page/u);

  for (const item of artifacts) {
    const bytes =
      item.mimeType === "image/png"
        ? "\u0089PNG"
        : item.mimeType === "application/pdf"
          ? "%PDF-1.7"
          : "# 内容";
    const preview = renderToStaticMarkup(
      createElement(FilesWorkbarPanel, {
        artifacts,
        selectedArtifactId: item.id,
        content: { ...contentFor(bytes, item), artifactId: item.id },
        ...handlers,
      }),
    );
    assert.match(preview, /tool-panel__preview-page/u);
    assert.match(preview, /返回生成文件列表/u);
    assert.match(preview, /生成文件操作/u);
    assert.doesNotMatch(preview, /tool-panel__files-list-page/u);
    assert.equal(preview.includes("用默认应用打开"), item.mimeType === "text/html");
  }

  const gone = renderToStaticMarkup(
    createElement(FilesWorkbarPanel, {
      artifacts: artifacts.slice(1),
      selectedArtifactId: artifacts[0]!.id,
      notice: "该生成文件已不存在，已返回列表。",
      ...handlers,
    }),
  );
  assert.match(gone, /该生成文件已不存在，已返回列表。/u);
  assert.match(gone, /tool-panel__files-list-page/u);
});

test("拒绝伪装图片、非法 Base64、越界与不前进的分块", () => {
  assert.equal(
    validateArtifactBinary(new TextEncoder().encode("<svg onload=alert(1)>"), "image/png"),
    undefined,
  );
  assert.throws(() => decodeArtifactBinary("a===junk"));
  const item = artifact("text/plain");
  const bytes = Buffer.alloc(ARTIFACT_TEXT_PREVIEW_BYTES + 1);
  assert.throws(
    () =>
      appendArtifactStreamChunk(undefined, item, {
        contentBase64: bytes.toString("base64"),
        offsetBytes: 0,
        endOffsetBytes: bytes.length,
        totalBytes: bytes.length,
        truncated: false,
      }),
    /预览上限/,
  );
  assert.throws(
    () =>
      appendArtifactStreamChunk(undefined, item, {
        contentBase64: "",
        offsetBytes: 0,
        endOffsetBytes: 0,
        totalBytes: 20,
        truncated: true,
        nextOffsetBytes: 0,
      }),
    /分块范围/,
  );
});

test(
  "Electron 实际 HTML 预览允许内联交互并拒绝父页面、联网、弹窗与子帧导航",
  { skip: !process.env.PICO_TEST_ELECTRON },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-artifact-preview-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = await readFile(
      new URL("../../../apps/desktop/src/main/artifact-preview-security.ts", import.meta.url),
      "utf8",
    );
    await writeFile(
      join(root, "security.cjs"),
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ArtifactPreview} from './apps/desktop/src/renderer/workbar-panels/ArtifactPreview.tsx'; globalThis.mountPreview=(artifact,content)=>{const node=document.createElement('div');document.body.append(node);const root=createRoot(node);root.render(React.createElement(ArtifactPreview,{artifact,content}));globalThis.unmountPreview=()=>{root.unmount();node.remove()}};`,
        resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      jsx: "automatic",
      format: "iife",
      outfile: join(root, "renderer.js"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(
      join(root, "document.json"),
      JSON.stringify(
        artifactHtmlDocument(`<h1>产物预览验收</h1><button onclick="this.textContent='交互成功'">点击</button><script>
    let parentBlocked=false; try { parent.document.body.innerHTML='escaped' } catch { parentBlocked=true }
    parent.postMessage({type:'ready', parentBlocked, rtcBlocked:typeof RTCPeerConnection==='undefined'}, '*');
    document.querySelector('button').click();
    fetch('http://127.0.0.1:PORT/blocked').catch(()=>{});
    new Image().src='http://127.0.0.1:PORT/image';
    window.open('http://127.0.0.1:PORT/popup');
    setTimeout(()=>location.href='http://127.0.0.1:PORT/escape',100);
  </script>`),
      ),
    );
    const fixture = new URL("../../fixtures/artifact-preview-electron.mjs", import.meta.url);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.PICO_TEST_ELECTRON!, [fileURLToPath(fixture), root], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    assert.match(output, /ARTIFACT_PREVIEW_SECURITY_OK/);
  },
);
