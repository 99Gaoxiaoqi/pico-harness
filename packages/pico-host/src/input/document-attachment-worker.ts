import { createRequire } from "node:module";
import { dirname, extname, join, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { crc32 } from "node:zlib";
import { fromBufferPromise } from "yauzl";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const TEXT_EXTENSIONS = new Set(
  ".txt .md .markdown .mdx .csv .tsv .json .jsonl .ndjson .xml .html .htm .css .scss .less .js .mjs .cjs .jsx .ts .tsx .py .ipynb .rb .go .rs .java .c .h .cpp .hpp .cs .swift .kt .kts .php .sh .bash .zsh .ps1 .bat .cmd .sql .graphql .yaml .yml .toml .ini .conf .cfg .log .rst .tex .vue .svelte .r .lua .dart .diff .patch .gitignore .dockerignore".split(
    " ",
  ),
);

class TextOutput {
  text = "";
  truncated = false;
  constructor(private readonly maxChars: number) {}
  append(value: string): void {
    const available = this.maxChars - this.text.length;
    if (value.length > available) {
      this.truncated = true;
      let part = value.slice(0, available);
      if (/[\uD800-\uDBFF]$/u.test(part)) part = part.slice(0, -1);
      this.text += part;
    } else {
      this.text += value;
    }
  }
}

/** Validate actual inflated bytes and CRCs before either Office library opens the archive. */
async function validateOfficeZip(bytes: Buffer, requiredEntry: string): Promise<void> {
  const zip = await fromBufferPromise(bytes, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let inflated = 0;
  let declared = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new Error("Office 附件包含过多压缩条目。");
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted()) throw new Error("不支持加密的 Office 附件，请解密后上传。");
      if (names.has(entry.fileName)) throw new Error("Office 附件包含重复条目，文件无效。");
      names.add(entry.fileName);
      declared += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || declared > MAX_ZIP_BYTES)
        throw new Error("Office 附件解压后体积超过安全上限（单项 20 MiB、总计 50 MiB）。");
      const stream = await zip.openReadStreamPromise(entry);
      let checksum = 0;
      let size = 0;
      try {
        for await (const chunk of stream) {
          const data = chunk as Buffer;
          size += data.byteLength;
          inflated += data.byteLength;
          if (size > MAX_ZIP_ENTRY_BYTES || inflated > MAX_ZIP_BYTES)
            throw new Error("Office 附件实际解压体积超过安全上限。");
          checksum = crc32(data, checksum);
        }
      } finally {
        stream.destroy();
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        throw new Error("Office 附件压缩内容校验失败，文件已损坏。");
    }
    if (!names.has("[Content_Types].xml") || !names.has(requiredEntry))
      throw new Error("附件不是有效的 Office 文档，缺少必要内容。");
  } finally {
    zip.close();
  }
}

interface WordElement {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly WordElement[];
}

function appendWord(element: WordElement, output: TextOutput, inCell = false): void {
  if (output.truncated) return;
  if (element.type === "text") output.append(element.value ?? "");
  else if (element.type === "tab") output.append(inCell ? " " : "\t");
  else if (element.type === "break") output.append(inCell ? " " : "\n");
  else {
    const children = element.children ?? [];
    for (const [index, child] of children.entries()) {
      if (element.type === "tableRow" && index > 0) output.append("\t");
      appendWord(child, output, inCell || element.type === "tableCell");
    }
    if (element.type === "paragraph") output.append(inCell ? " " : "\n");
    if (element.type === "tableRow") output.append("\n");
  }
}

async function extractWord(bytes: Buffer, output: TextOutput): Promise<void> {
  await validateOfficeZip(bytes, "word/document.xml");
  const result = await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      transformDocument(document: WordElement) {
        appendWord(document, output);
        // Text was collected from the document tree; skip image/HTML conversion entirely.
        return { ...document, children: [] };
      },
    },
  );
  if (result.messages.some((message) => message.type === "error"))
    throw new Error("Word 附件内容不完整或已损坏，无法可靠提取。");
}

async function extractSpreadsheet(bytes: Buffer, output: TextOutput): Promise<void> {
  await validateOfficeZip(bytes, "xl/workbook.xml");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  let hasContent = false;
  for (const sheet of workbook.worksheets) {
    if (output.truncated) break;
    output.append(`\n[工作表：${sheet.name}]\n`);
    sheet.eachRow((row, rowNumber) => {
      if (output.truncated) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.value;
        const text =
          value && typeof value === "object" && "formula" in value && value.result === undefined
            ? `=${value.formula}`
            : cell.text;
        if (text.trim()) hasContent = true;
        cells.push(text.replace(/\r?\n/gu, "\\n").replace(/\t/gu, "\\t"));
      });
      output.append(`${rowNumber}\t${cells.join("\t")}\n`);
    });
  }
  if (!hasContent) throw new Error("Excel 附件没有可提取的单元格内容。");
}

async function extractPdf(bytes: Uint8Array, output: TextOutput): Promise<void> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const moduleRequire = createRequire(import.meta.url);
  const pdfRoot = dirname(moduleRequire.resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    cMapUrl: join(pdfRoot, "cmaps") + sep,
    standardFontDataUrl: join(pdfRoot, "standard_fonts") + sep,
    useWorkerFetch: false,
    useWasm: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if ((await pdf.getPermissions()) !== null) throw new Error("不支持加密的 PDF，请解密后上传。");
    let hasContent = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (output.truncated) break;
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        output.append(`\n[第 ${pageNumber} 页]\n`);
        for (const item of content.items) {
          if (!("str" in item)) continue;
          if (item.str.trim()) hasContent = true;
          output.append(item.str + (item.hasEOL ? "\n" : " "));
        }
      } finally {
        page.cleanup();
      }
    }
    if (!hasContent)
      throw new Error("PDF 没有可提取的文字，可能是扫描件；当前不支持 OCR，请提供文字版。");
  } catch (cause) {
    if (cause instanceof Error && cause.name === "PasswordException")
      throw new Error("不支持加密的 PDF，请解密后上传。", { cause });
    throw cause;
  } finally {
    await task.destroy();
  }
}

async function run(): Promise<void> {
  const input = workerData as {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    maxChars: number;
  };
  try {
    const bytes = Buffer.from(input.bytes);
    const extension = extname(input.name).toLowerCase();
    const mime = input.mimeType.toLowerCase().split(";")[0]!.trim();
    const output = new TextOutput(input.maxChars);
    if (extension === ".pdf" || mime === "application/pdf") {
      if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
        throw new Error("PDF 文件头无效，附件可能已损坏。");
      await extractPdf(bytes, output);
    } else if (extension === ".docx") {
      await extractWord(bytes, output);
    } else if (extension === ".xlsx") {
      await extractSpreadsheet(bytes, output);
    } else if (
      TEXT_EXTENSIONS.has(extension) ||
      /^(?:dockerfile|makefile|license|readme|\.gitignore|\.dockerignore)$/iu.test(input.name) ||
      mime.startsWith("text/") ||
      [
        "application/json",
        "application/xml",
        "application/javascript",
        "application/yaml",
      ].includes(mime)
    ) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("文本附件不是有效 UTF-8，请转换为 UTF-8 后上传。");
      }
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13)
          throw new Error("附件包含二进制控制字符，不能作为文本读取。");
      }
      output.append(text);
    } else {
      throw new Error("不支持此附件格式，请使用文本、代码、PDF、DOCX 或 XLSX。");
    }
    if (!output.text.trim()) throw new Error("附件没有可提取的文字内容。");
    parentPort!.postMessage({ text: output.text, truncated: output.truncated });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "未知错误";
    parentPort!.postMessage({ error: `附件解析失败：${detail}` });
  }
}

void run();
