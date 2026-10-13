import { extname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import type { DocumentAttachmentInput } from "./document-attachment.js";
import type { DocumentKind, DocumentQuery } from "./document-query-contract.js";
import {
  decodeDocumentText,
  queryTextUnits,
  textUnits,
  wordUnits,
} from "./document-content-query.js";
import { queryPdfDocument, extractLegacyPdf } from "./document-pdf-query.js";
import { validateOfficeZip } from "./document-office-zip.js";
import { querySpreadsheet } from "./spreadsheet-query.js";

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

async function extractSpreadsheet(bytes: Buffer, output: TextOutput): Promise<void> {
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

function documentKind(name: string, mimeType: string): DocumentKind {
  const extension = extname(name).toLowerCase();
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (extension === ".pdf" || mime === "application/pdf") return "pdf";
  if (extension === ".docx") return "word";
  if (extension === ".xlsx") return "spreadsheet";
  if (
    TEXT_EXTENSIONS.has(extension) ||
    /^(?:dockerfile|makefile|license|readme|\.gitignore|\.dockerignore)$/iu.test(name) ||
    mime.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "application/yaml"].includes(
      mime,
    )
  )
    return "text";
  throw new Error("不支持此附件格式，请使用文本、代码、PDF、DOCX 或 XLSX。");
}

async function run(): Promise<void> {
  const input = workerData as DocumentAttachmentInput & { maxChars: number; query?: DocumentQuery };
  try {
    const bytes = Buffer.from(input.bytes);
    const kind = documentKind(input.name, input.mimeType);
    if (kind === "word" || kind === "spreadsheet")
      await validateOfficeZip(bytes, kind === "word" ? "word/document.xml" : "xl/workbook.xml");
    if (input.query) {
      let result;
      if (kind === "pdf") result = await queryPdfDocument(bytes, input.name, input.query);
      else if (kind === "spreadsheet")
        result = await querySpreadsheet(bytes, input.name, input.query);
      else if (kind === "word") {
        const { units, paragraphs, warnings } = await wordUnits(bytes);
        result = queryTextUnits(
          { kind, name: input.name, paragraphs, warnings },
          units,
          input.query,
        );
      } else {
        const units = textUnits(decodeDocumentText(bytes));
        result = queryTextUnits(
          { kind, name: input.name, lines: units.length, warnings: [] },
          units,
          input.query,
        );
      }
      parentPort!.postMessage(result);
      return;
    }
    // Backward-compatible extraction is only retained for existing callers. New tools use queries.
    const output = new TextOutput(input.maxChars);
    if (kind === "pdf") {
      parentPort!.postMessage(await extractLegacyPdf(bytes, input.maxChars));
      return;
    }
    if (kind === "word")
      output.append((await wordUnits(bytes)).units.map((unit) => unit.text).join("\n"));
    else if (kind === "spreadsheet") await extractSpreadsheet(bytes, output);
    else output.append(decodeDocumentText(bytes));
    if (!output.text.trim()) throw new Error("附件没有可提取的文字内容。");
    parentPort!.postMessage({ text: output.text, truncated: output.truncated });
  } catch (cause) {
    parentPort!.postMessage({
      error: `附件解析失败：${cause instanceof Error ? cause.message : "未知错误"}`,
    });
  }
}

void run();
