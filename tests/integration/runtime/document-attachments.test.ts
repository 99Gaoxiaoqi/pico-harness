import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { copyDocumentAttachmentWorker } from "../../../apps/desktop/desktop-runtime-resources.js";
import type { extractDocumentAttachment } from "../../../packages/pico-host/src/input/document-attachment.js";
import {
  documentExcel,
  documentPdf,
  documentWord,
  documentZip,
} from "../../fixtures/document-attachments.js";

test(
  "附件文档集成：打包 worker 提取混合文件并拒绝损坏、加密、超限输入",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-document-attachments-"));
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
      extractDocumentAttachment: typeof extractDocumentAttachment;
    };
    const extract = (name: string, bytes: Uint8Array, mimeType = "") =>
      parser.extractDocumentAttachment({ name, bytes, mimeType });

    await t.test(
      "真实文本、代码、PDF、Word表格与多工作表Excel均保留可供模型读取的内容",
      async () => {
        const text = await extract("说明.md", Buffer.from("# 上传\n这是一份 UTF-8 文本。"));
        assert.equal(text.text, "# 上传\n这是一份 UTF-8 文本。");
        assert.equal(text.truncated, false);
        assert.equal(
          (await extract("sample.ts", Buffer.from("export const answer = 42;"))).text,
          "export const answer = 42;",
        );
        const pdf = await extract("report.pdf", documentPdf(), "application/pdf");
        assert.match(pdf.text, /第 1 页/u);
        assert.match(pdf.text, /Pico upload 42/u);
        const chinesePdf = await extract("中文.pdf", documentPdf(true, true));
        assert.match(chinesePdf.text.replace(/\s/gu, ""), /Pico中文上传/u);
        const word = await extract("报告.docx", documentWord());
        assert.match(word.text, /Pico 文档上传/u);
        assert.match(word.text, /项目[^\n]*\t金额[^\n]*\n测试[^\n]*\t42/u);
        const excel = await extract("预算.xlsx", await documentExcel());
        assert.match(excel.text, /工作表：预算/u);
        assert.match(excel.text, /1\t项目\t金额\n2\t测试\t42/u);
        assert.match(excel.text, /3\t空列\t\t仍在第三列/u);
        assert.match(excel.text, /工作表：指标/u);
        assert.match(excel.text, /2\t十月\t42/u);
        assert.equal(word.truncated || excel.truncated || pdf.truncated, false);
        const long = await extract("large.txt", Buffer.from("中".repeat(160_000)));
        assert.equal(long.text.length, 120_000);
        assert.equal(long.truncated, true);
      },
    );

    await t.test("拒绝无文字或加密PDF、损坏Office、非法UTF8以及原始/解压大小超限", async () => {
      await assert.rejects(extract("scan.pdf", documentPdf(false)), /没有可提取的文字.*OCR/u);
      const encrypted = await readFile(join(repo, "tests/fixtures/document-encrypted.pdf"));
      await assert.rejects(extract("secret.pdf", encrypted), /加密/u);
      await assert.rejects(extract("broken.pdf", Buffer.from("%PDF-1.4\nbroken")), /解析失败/u);
      await assert.rejects(extract("broken.xlsx", Buffer.from("not a zip")), /解析失败/u);
      const corrupted = documentWord();
      const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      corrupted.writeUInt32LE(0, central + 16);
      await assert.rejects(extract("corrupt.docx", corrupted), /校验失败/u);
      await assert.rejects(extract("ansi.txt", Buffer.from([0xff, 0xfe, 65])), /UTF-8/u);
      await assert.rejects(extract("binary.txt", Buffer.from([65, 0, 66])), /二进制/u);
      await assert.rejects(extract("large.txt", new Uint8Array(20 * 1024 * 1024 + 1)), /20 MiB/u);
      const bomb = documentZip({ "word/document.xml": "x".repeat(21 * 1024 * 1024) });
      await assert.rejects(extract("compressed.docx", bomb), /解压后体积超过/u);
      for (const name of ["legacy.doc", "legacy.xls"])
        await assert.rejects(extract(name, Buffer.from("legacy")), /暂不支持旧版/u);
    });

    await t.test("解析失去响应时20秒后终止独立worker，宿主仍可继续处理", async () => {
      const workerPath = join(root, "document-attachment-worker.cjs");
      const workerSource = await readFile(workerPath);
      await writeFile(workerPath, "while (true) {}\n");
      try {
        await assert.rejects(extract("slow.txt", Buffer.from("test")), /超过 20 秒/u);
      } finally {
        await writeFile(workerPath, workerSource);
      }
      assert.equal((await extract("next.txt", Buffer.from("宿主仍可用"))).text, "宿主仍可用");
    });
  },
);
