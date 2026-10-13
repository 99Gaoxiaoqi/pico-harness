import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { copyDocumentAttachmentWorker } from "../../../apps/desktop/desktop-runtime-resources.js";
import type { queryDocumentAttachment } from "../../../packages/pico-host/src/input/document-attachment.js";
import type { DocumentQuery } from "../../../packages/pico-host/src/input/document-query-contract.js";
import { documentPdf, documentWord } from "../../fixtures/document-attachments.js";

function pagedPdf(pages: readonly string[], width = 200, height = 100): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 14 Tf 20 80 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function jpegOnlyPdf(): Buffer {
  const canvas = createCanvas(200, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 200, 100);
  context.fillStyle = "black";
  context.fillRect(10, 10, 80, 80);
  const jpeg = canvas.toBuffer("image/jpeg");
  const drawing = "q 200 0 0 100 0 0 cm /Im0 Do Q";
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 200 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    size += part.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

test(
  "文档查询集成：完整搜索、定位续读、扫描页图像与取消资源回收",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-document-query-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    copyDocumentAttachmentWorker(join(repo, "apps/desktop"), root);
    await build({
      entryPoints: [join(repo, "packages/pico-host/src/input/document-attachment.ts")],
      outfile: join(root, "parser.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      define: { "import.meta.url": "__picoParserUrl" },
      banner: { js: 'const __picoParserUrl = require("node:url").pathToFileURL(__filename).href;' },
    });
    const parser = (await import(pathToFileURL(join(root, "parser.cjs")).href)) as {
      queryDocumentAttachment: typeof queryDocumentAttachment;
    };
    const query = (name: string, bytes: Uint8Array, request: DocumentQuery, signal?: AbortSignal) =>
      parser.queryDocumentAttachment(
        { name, bytes, mimeType: "" },
        request,
        signal ? { signal } : {},
      );

    await t.test("长文本尾部可搜索且inspect预览受限，分页不会遗漏命中或正文", async () => {
      const bytes = Buffer.from(`开头\n${"正文 ".repeat(50_000)}\nneedle A\nNEEDLE B\nneedle C`);
      const inspect = await query("large.txt", bytes, { action: "inspect" });
      assert.equal(inspect.manifest?.lines, 5);
      assert.ok(inspect.text.length < 1800);
      assert.doesNotMatch(inspect.text, /needle/iu);
      const first = await query("large.txt", bytes, {
        action: "search",
        query: "needle",
        limit: 2,
      });
      assert.equal(first.total, 3);
      assert.equal(first.nextOffset, 2);
      assert.match(first.text, /行 3/u);
      assert.match(first.text, /行 4/u);
      const second = await query("large.txt", bytes, {
        action: "search",
        query: "needle",
        offset: first.nextOffset,
      });
      assert.equal(second.total, 3);
      assert.equal(second.nextOffset, undefined);
      assert.match(second.text, /行 5/u);
      const readOffset = Number(first.text.match(/read offset=(\d+)/u)?.[1]);
      assert.ok(readOffset > 120_000);
      const tail = await query("large.txt", bytes, {
        action: "read",
        offset: readOffset,
        limit: 16_000,
      });
      assert.match(tail.text, /needle A/u);
      assert.match(tail.text, /起点：行 3/u);
      assert.ok(tail.text.length <= 16_000);
      const short = Buffer.from("第一行\n第二行\n第三行");
      const one = await query("short.txt", short, { action: "read", limit: 13 });
      assert.equal(one.nextOffset, 13);
      const two = await query("short.txt", short, {
        action: "read",
        offset: one.nextOffset,
        limit: 13,
      });
      assert.equal(two.nextOffset, 26);
      const three = await query("short.txt", short, {
        action: "read",
        offset: two.nextOffset,
        limit: 13,
      });
      const body = [one, two, three]
        .map((result) => result.text.split("\n").slice(1, -1).join("\n"))
        .join("");
      assert.equal(body, "[行 1] 第一行\n[行 2] 第二行\n[行 3] 第三行");
      assert.equal(three.nextOffset, undefined);
    });

    await t.test("Word定位段落和表格行，PDF按页读取及搜索续页", async () => {
      const word = await query("report.docx", documentWord(), { action: "read" });
      assert.match(word.text, /\[段落 1\] Pico 文档上传/u);
      assert.match(word.text, /\[表格 1，行 2\] 测试\t42/u);
      const found = await query("report.docx", documentWord(), { action: "search", query: "42" });
      assert.match(found.text, /表格 1，行 2/u);
      const pdf = pagedPdf(["first unique", "second needle", "third needle"]);
      const info = await query("pages.pdf", pdf, { action: "inspect" });
      assert.equal(info.manifest?.pages, 3);
      assert.doesNotMatch(info.text, /second needle/u);
      const read = await query("pages.pdf", pdf, { action: "read", page: 2, limit: 10 });
      assert.equal(read.nextOffset, 10);
      const more = await query("pages.pdf", pdf, {
        action: "read",
        page: 2,
        offset: read.nextOffset,
      });
      assert.match(read.text + more.text, /第 2\/3 页/u);
      assert.match(more.text, /needle/u);
      const search = await query("pages.pdf", pdf, { action: "search", query: "needle", limit: 1 });
      assert.equal(search.total, 2);
      assert.equal(search.nextOffset, 1);
      assert.match(search.text, /第 2 页/u);
      const next = await query("pages.pdf", pdf, {
        action: "search",
        query: "needle",
        offset: search.nextOffset,
      });
      assert.match(next.text, /第 3 页/u);
      assert.equal(next.nextOffset, undefined);
      await assert.rejects(query("pages.pdf", pdf, { action: "read", page: 4 }), /1–3/u);
      await assert.rejects(
        query("too-many-pages.pdf", pagedPdf(Array.from({ length: 1001 }, () => "page")), {
          action: "inspect",
        }),
        /1000 页安全上限/u,
      );
    });

    await t.test("扫描PDF可检查和渲染，真实PNG包含页面内容并受像素上限约束", async () => {
      const scan = documentPdf(false);
      const info = await query("scan.pdf", scan, { action: "inspect" });
      assert.equal(info.manifest?.pages, 1);
      assert.match(info.manifest?.warnings.join(" ") ?? "", /view/u);
      const noText = await query("scan.pdf", scan, { action: "search", query: "imaginary" });
      assert.equal(noText.total, 0);
      assert.match(noText.warnings?.join(" ") ?? "", /未执行 OCR/u);
      const view = await query("scan.pdf", scan, { action: "view", page: 1 });
      assert.ok(view.image);
      const png = Buffer.from(view.image.data, "base64");
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.ok(png.length <= 4 * 1024 * 1024);
      const image = await loadImage(png);
      const canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      assert.equal(context.getImageData(1, image.height - 2, 1, 1).data[0], 0);
      assert.equal(context.getImageData(image.width - 2, 1, 1, 1).data[0], 255);
      const jpegPdf = jpegOnlyPdf();
      const jpegInfo = await query("jpeg-scan.pdf", jpegPdf, { action: "inspect" });
      assert.match(jpegInfo.manifest?.warnings.join(" ") ?? "", /没有可提取的文字/u);
      const jpegView = await query("jpeg-scan.pdf", jpegPdf, { action: "view", page: 1 });
      assert.ok(jpegView.image);
      const jpegImage = await loadImage(Buffer.from(jpegView.image.data, "base64"));
      const jpegCanvas = createCanvas(jpegImage.width, jpegImage.height);
      const jpegContext = jpegCanvas.getContext("2d");
      jpegContext.drawImage(jpegImage, 0, 0);
      assert.ok(jpegContext.getImageData(40, 40, 1, 1).data[0]! < 10);
      assert.ok(jpegContext.getImageData(250, 40, 1, 1).data[0]! > 245);
      const large = await query("poster.pdf", pagedPdf(["poster"], 10000, 10000), {
        action: "view",
        page: 1,
      });
      assert.ok(large.image && large.image.width * large.image.height <= 4_000_000);
      await assert.rejects(
        query("broken.pdf", Buffer.from("%PDF-1.4\nbroken"), { action: "inspect" }),
        /解析失败/u,
      );
    });

    await t.test("关键失败：运行中取消和并发超限及时回收worker，随后查询仍成功", async () => {
      await assert.rejects(
        query("x.txt", Buffer.from("hello"), { action: "search", query: "" }),
        /query/u,
      );
      await assert.rejects(
        query("x.txt", Buffer.from("hello"), { action: "read", offset: -1 }),
        /offset/u,
      );
      const workerPath = join(root, "document-attachment-worker.cjs");
      const original = await readFile(workerPath);
      await writeFile(workerPath, "while (true) {}\n");
      const first = new AbortController();
      const second = new AbortController();
      try {
        const pending = [
          query("one.txt", Buffer.from("hello"), { action: "inspect" }, first.signal),
          query("two.txt", Buffer.from("hello"), { action: "inspect" }, second.signal),
        ];
        const outcomes = pending.map((promise) => assert.rejects(promise, { name: "AbortError" }));
        await assert.rejects(
          query("three.txt", Buffer.from("hello"), { action: "inspect" }),
          /最多 2/u,
        );
        const started = Date.now();
        first.abort();
        second.abort();
        await Promise.all(outcomes);
        assert.ok(Date.now() - started < 3_000);
      } finally {
        first.abort();
        second.abort();
        await writeFile(workerPath, original);
      }
      const recovered = await query("next.txt", Buffer.from("宿主仍可用"), { action: "read" });
      assert.match(recovered.text, /宿主仍可用/u);
    });
  },
);
