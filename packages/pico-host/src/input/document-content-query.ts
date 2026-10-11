import mammoth from "mammoth";
import {
  DOCUMENT_QUERY_MAX_CHARS,
  type DocumentKind,
  type DocumentManifest,
  type DocumentQuery,
  type DocumentQueryResult,
} from "./document-query-contract.js";

export const DOCUMENT_PREVIEW_CHARS = 1_500;
export const DOCUMENT_MAX_CONTENT_CHARS = 20_000_000;
const MAX_CONTENT_UNITS = 250_000;

export interface DocumentTextUnit {
  readonly location: string;
  readonly text: string;
}

export function decodeDocumentText(bytes: Buffer): string {
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
  return text;
}

export function textUnits(text: string): DocumentTextUnit[] {
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > MAX_CONTENT_UNITS)
    throw new Error(`文本超过 ${MAX_CONTENT_UNITS} 行安全上限，请拆分后重试。`);
  return lines.map((line, index) => ({ location: `行 ${index + 1}`, text: line }));
}

interface WordElement {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly WordElement[];
}

function wordText(element: WordElement): string {
  if (element.type === "text") return element.value ?? "";
  if (element.type === "tab") return "\t";
  if (element.type === "break") return "\n";
  return (
    (element.children ?? []).map(wordText).join("") + (element.type === "paragraph" ? " " : "")
  );
}

/** ZIP validation must happen before invoking the Office parser. */
export async function wordUnits(bytes: Buffer): Promise<{
  units: DocumentTextUnit[];
  paragraphs: number;
  warnings: string[];
}> {
  const units: DocumentTextUnit[] = [];
  let paragraphs = 0;
  let tables = 0;
  let chars = 0;
  const add = (location: string, text: string) => {
    chars += text.length;
    if (units.length >= MAX_CONTENT_UNITS || chars > DOCUMENT_MAX_CONTENT_CHARS)
      throw new Error("Word 正文超过解析安全上限，请拆分后重试。");
    units.push({ location, text });
  };
  const countParagraphs = (element: WordElement): number =>
    (element.type === "paragraph" ? 1 : 0) +
    (element.children ?? []).reduce((sum, child) => sum + countParagraphs(child), 0);
  const visit = (element: WordElement) => {
    if (element.type === "paragraph") {
      add(`段落 ${++paragraphs}`, wordText(element).trimEnd());
    } else if (element.type === "table") {
      const table = ++tables;
      for (const [row, child] of (element.children ?? []).entries()) {
        paragraphs += countParagraphs(child);
        const cells = (child.children ?? []).map((cell) => wordText(cell).trimEnd());
        add(`表格 ${table}，行 ${row + 1}`, cells.join("\t"));
      }
    } else {
      for (const child of element.children ?? []) visit(child);
    }
  };
  const result = await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      transformDocument(document: WordElement) {
        visit(document);
        return { ...document, children: [] };
      },
    },
  );
  if (result.messages.some((message) => message.type === "error"))
    throw new Error("Word 附件内容不完整或已损坏，无法可靠提取。");
  return {
    units,
    paragraphs,
    warnings: [
      "Word 读取范围为正文段落与表格；不含图片文字、页眉页脚、脚注尾注、批注或版式。",
      ...(result.messages.length
        ? ["Word 包含解析器不支持的内容，部分非正文元素可能未提取。"]
        : []),
    ],
  };
}

export function labelledText(units: readonly DocumentTextUnit[]): string {
  return units.map((unit) => `[${unit.location}] ${unit.text}`).join("\n");
}

export function readDocumentUnits(
  kind: DocumentKind,
  units: readonly DocumentTextUnit[],
  query: Extract<DocumentQuery, { action: "read" }>,
  coverage: string,
  warnings: readonly string[] = [],
): DocumentQueryResult {
  const text = labelledText(units);
  const offset = query.offset ?? 0;
  const limit = Math.min(query.limit ?? 8_000, DOCUMENT_QUERY_MAX_CHARS - 1_500);
  if (offset > text.length) throw new Error(`offset 超过当前范围的 ${text.length} 个字符。`);
  const end = Math.min(offset + limit, text.length);
  let unitStart = 0;
  let location = units[0]?.location ?? "正文";
  for (const unit of units) {
    location = unit.location;
    unitStart += `[${unit.location}] `.length + unit.text.length + 1;
    if (unitStart > offset) break;
  }
  const header = `${coverage}；字符 ${offset}–${end}/${text.length}（offset 从 0 开始，含定位标签）；起点：${location}。`;
  return {
    kind,
    text: `${header}\n${text.slice(offset, end)}${end < text.length ? `\n续读：offset=${end}。` : "\n当前范围读取完毕。"}`,
    total: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export function searchDocumentUnits(
  kind: DocumentKind,
  units: readonly DocumentTextUnit[],
  query: Extract<DocumentQuery, { action: "search" }>,
  coverage: string,
  warnings: readonly string[] = [],
): DocumentQueryResult {
  const text = units.map((unit) => unit.text).join("\n");
  // A literal Unicode regexp keeps original character offsets even for case folds such as İ.
  const pattern = new RegExp(query.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  const offset = query.offset ?? 0;
  const limit = Math.min(query.limit ?? 20, 100);
  const matches: string[] = [];
  let total = 0;
  let outputChars = 0;
  let outputFull = false;
  let unitIndex = 0;
  let unitStart = 0;
  let labelChars = units[0] ? `[${units[0].location}] `.length : 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (total++ < offset || matches.length >= limit || outputFull) continue;
    while (unitIndex < units.length - 1 && index >= unitStart + units[unitIndex]!.text.length + 1) {
      unitStart += units[unitIndex++]!.text.length + 1;
      labelChars += `[${units[unitIndex]!.location}] `.length;
    }
    const unit = units[unitIndex];
    const snippet = text
      .slice(Math.max(0, index - 60), Math.min(text.length, index + 200))
      .replace(/\r?\n/gu, " ↵ ");
    const readOffset =
      kind === "pdf"
        ? index - unitStart + `[${unit?.location ?? "正文"}] `.length
        : index + labelChars;
    const line = `[${unit?.location ?? "正文"}，字符 ${index - unitStart}，read offset=${readOffset}] ${snippet}`;
    if (outputChars + line.length > DOCUMENT_QUERY_MAX_CHARS - 1_500) {
      outputFull = true;
      continue;
    }
    matches.push(line);
    outputChars += line.length + 1;
  }
  if (offset > total) throw new Error(`offset 超过总命中数 ${total}。`);
  const nextOffset = offset + matches.length;
  return {
    kind,
    text: `${coverage}；共 ${total} 处匹配，返回第 ${matches.length ? offset + 1 : 0}–${nextOffset} 处。\n${matches.join("\n") || "未找到匹配。"}${nextOffset < total ? `\n继续搜索：offset=${nextOffset}（命中序号）。` : ""}`,
    total,
    ...(nextOffset < total ? { nextOffset } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export function queryTextUnits(
  manifest: DocumentManifest,
  units: readonly DocumentTextUnit[],
  query: DocumentQuery,
): DocumentQueryResult {
  if (query.action === "view" || query.action === "analyze")
    throw new Error(`${manifest.kind === "word" ? "Word" : "文本"} 附件不支持 ${query.action}。`);
  if (query.action === "read" && query.page !== undefined)
    throw new Error("page 只适用于 PDF，请通过 offset 读取此文档。");
  if (
    query.action !== "inspect" &&
    (query.sheet !== undefined || ("range" in query && query.range !== undefined))
  )
    throw new Error("sheet/range 只适用于 Excel。");
  if (query.action === "inspect") {
    const preview: string[] = [];
    let remaining = DOCUMENT_PREVIEW_CHARS;
    for (const unit of units) {
      if (remaining <= 0) break;
      const line = `[${unit.location}] ${unit.text}\n`.slice(0, remaining);
      preview.push(line);
      remaining -= line.length;
    }
    return {
      kind: manifest.kind,
      manifest,
      text: `${manifest.kind === "word" ? `Word，${manifest.paragraphs} 个正文段落` : `文本，${manifest.lines} 行`}。\n预览（最多 ${DOCUMENT_PREVIEW_CHARS} 字符）：\n${preview.join("") || "没有可提取的正文。"}\n使用 read 按 offset 续读，search 搜索正文。`,
    };
  }
  const coverage = manifest.kind === "word" ? "全部 Word 正文段落与表格" : "全部文本行";
  return query.action === "read"
    ? readDocumentUnits(manifest.kind, units, query, coverage, manifest.warnings)
    : searchDocumentUnits(manifest.kind, units, query, `已扫描${coverage}`, manifest.warnings);
}
