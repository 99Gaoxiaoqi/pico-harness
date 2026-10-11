import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import {
  DOCUMENT_QUERY_MAX_IMAGE_BYTES,
  type DocumentQuery,
  type DocumentQueryResult,
} from "./document-query-contract.js";
import {
  DOCUMENT_MAX_CONTENT_CHARS,
  DOCUMENT_PREVIEW_CHARS,
  readDocumentUnits,
  searchDocumentUnits,
  type DocumentTextUnit,
} from "./document-content-query.js";

const MAX_PDF_PAGES = 1_000;
const MAX_PAGE_PIXELS = 4_000_000;
const MAX_CANVAS_EDGE = 4_096;
const MAX_CANVAS_PIXELS = 16_000_000;
const PDF_TEXT_WARNING =
  "PDF 文本读取和搜索仅覆盖可提取的文字层，不含图片内文字；未执行 OCR。扫描页或版式请使用 view。";
const moduleRequire = createRequire(import.meta.url);

/** PDF.js also creates temporary canvases; cap their live native-memory allocation. */
class BoundedCanvasFactory {
  private readonly sizes = new Map<Canvas, number>();
  private pixels = 0;

  private check(width: number, height: number, previous = 0): number {
    const pixels = Math.ceil(width) * Math.ceil(height);
    if (
      !Number.isFinite(pixels) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_CANVAS_EDGE ||
      height > MAX_CANVAS_EDGE ||
      pixels > MAX_CANVAS_PIXELS ||
      this.pixels - previous + pixels > MAX_CANVAS_PIXELS
    )
      throw new Error("PDF 渲染画布超过安全像素上限，请使用分辨率更低的文件。");
    return pixels;
  }

  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    const pixels = this.check(width, height);
    const { createCanvas } = moduleRequire("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    this.sizes.set(canvas, pixels);
    this.pixels += pixels;
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(target: { canvas: Canvas }, width: number, height: number): void {
    const previous = this.sizes.get(target.canvas) ?? 0;
    const pixels = this.check(width, height, previous);
    target.canvas.width = Math.ceil(width);
    target.canvas.height = Math.ceil(height);
    this.sizes.set(target.canvas, pixels);
    this.pixels += pixels - previous;
  }

  destroy(target: { canvas: Canvas | null; context: SKRSContext2D | null }): void {
    if (!target.canvas) return;
    this.pixels -= this.sizes.get(target.canvas) ?? 0;
    this.sizes.delete(target.canvas);
    target.canvas.width = target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

async function withPdf<T>(
  bytes: Uint8Array,
  operation: (pdf: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  if (
    !Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).includes(
      Buffer.from("%PDF-"),
    )
  )
    throw new Error("PDF 文件头无效，附件可能已损坏。");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
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
    maxImageSize: MAX_CANVAS_PIXELS,
    canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
    CanvasFactory: BoundedCanvasFactory,
  });
  try {
    const pdf = await task.promise;
    if ((await pdf.getPermissions()) !== null) throw new Error("不支持加密的 PDF，请解密后上传。");
    if (pdf.numPages > MAX_PDF_PAGES)
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页安全上限，请拆分后重试。`);
    return await operation(pdf);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "PasswordException")
      throw new Error("不支持加密的 PDF，请解密后上传。", { cause });
    throw cause;
  } finally {
    await task.destroy();
  }
}

async function pageText(page: PDFPageProxy): Promise<string> {
  // Stream text rather than assembling an unbounded single-page response first.
  const reader = page.streamTextContent().getReader();
  const pieces: string[] = [];
  let chars = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const item of chunk.value.items) {
        if (!("str" in item)) continue;
        const piece = item.str + (item.hasEOL ? "\n" : " ");
        chars += piece.length;
        if (chars > DOCUMENT_MAX_CONTENT_CHARS)
          throw new Error("PDF 单页文字超过解析安全上限，请拆分后重试。");
        pieces.push(piece);
      }
    }
    return pieces.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function getPageText(pdf: PDFDocumentProxy, number: number): Promise<DocumentTextUnit> {
  const page = await pdf.getPage(number);
  try {
    return { location: `第 ${number} 页`, text: await pageText(page) };
  } finally {
    page.cleanup();
  }
}

function checkPage(pdf: PDFDocumentProxy, number: number): void {
  if (!Number.isSafeInteger(number) || number < 1 || number > pdf.numPages)
    throw new Error(`PDF page 必须为 1–${pdf.numPages}。`);
}

async function viewPage(pdf: PDFDocumentProxy, number: number): Promise<DocumentQueryResult> {
  checkPage(pdf, number);
  const page = await pdf.getPage(number);
  const factory = new BoundedCanvasFactory();
  let target: { canvas: Canvas; context: SKRSContext2D } | undefined;
  try {
    const original = page.getViewport({ scale: 1 });
    if (
      !Number.isFinite(original.width * original.height) ||
      original.width <= 0 ||
      original.height <= 0
    )
      throw new Error("PDF 页尺寸无效。");
    const scale = Math.min(
      1.5,
      Math.sqrt(MAX_PAGE_PIXELS / (original.width * original.height)),
      MAX_CANVAS_EDGE / original.width,
      MAX_CANVAS_EDGE / original.height,
    );
    const viewport = page.getViewport({ scale });
    // Floor keeps the pixel budget exact after viewport rounding.
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    target = factory.create(width, height);
    await page.render({
      canvas: target.canvas as unknown as HTMLCanvasElement,
      canvasContext: target.context as unknown as CanvasRenderingContext2D,
      viewport,
      background: "rgb(255,255,255)",
    }).promise;
    const png = await target.canvas.encode("png");
    if (png.byteLength > DOCUMENT_QUERY_MAX_IMAGE_BYTES)
      throw new Error("PDF 页面图像超过 4 MiB 输出上限，请使用较小的 PDF 页面。");
    return {
      kind: "pdf",
      text: `PDF 第 ${number}/${pdf.numPages} 页，${width}×${height} PNG。未执行 OCR；图像应交由视觉模型读取。`,
      image: { mimeType: "image/png", data: png.toString("base64"), width, height },
      warnings: [PDF_TEXT_WARNING, "超过 1600 万像素的内嵌图片受资源限制可能未渲染。"],
    };
  } finally {
    if (target) factory.destroy(target);
    page.cleanup();
  }
}

export async function queryPdfDocument(
  bytes: Uint8Array,
  name: string,
  query: DocumentQuery,
): Promise<DocumentQueryResult> {
  if (query.action === "analyze") throw new Error("PDF 不支持 analyze，请使用 Excel 附件。");
  if (
    ("sheet" in query && query.sheet !== undefined) ||
    ("range" in query && query.range !== undefined)
  )
    throw new Error("sheet/range 只适用于 Excel。");
  return withPdf(bytes, async (pdf) => {
    if (query.action === "view") return viewPage(pdf, query.page);
    if (query.action === "inspect") {
      // Inspect previews only the first page; it must never claim the entire PDF has a text layer.
      const first = await getPageText(pdf, 1);
      const warnings = [PDF_TEXT_WARNING];
      if (!first.text.trim())
        warnings.push("第 1 页没有可提取的文字，可能是扫描页；使用 view 查看。其他页尚未检查。");
      return {
        kind: "pdf",
        manifest: { kind: "pdf", name, pages: pdf.numPages, warnings },
        text: `PDF，共 ${pdf.numPages} 页。\n第 1 页文字层预览（最多 ${DOCUMENT_PREVIEW_CHARS} 字符，其他页未读取）：\n${first.text.slice(0, DOCUMENT_PREVIEW_CHARS) || "没有可提取的文字。"}\n使用 read(page, offset, limit) 读取指定页；search 扫描全部页的文字层；view(page) 查看页面。`,
      };
    }
    if (query.action === "read") {
      const number = query.page ?? 1;
      checkPage(pdf, number);
      const unit = await getPageText(pdf, number);
      return readDocumentUnits("pdf", [unit], query, `PDF 第 ${number}/${pdf.numPages} 页`, [
        PDF_TEXT_WARNING,
        ...(unit.text.trim() ? [] : ["本页没有可提取的文字，请使用 view。"]),
      ]);
    }
    const units: DocumentTextUnit[] = [];
    let chars = 0;
    let emptyPages = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const unit = await getPageText(pdf, number);
      chars += unit.text.length;
      if (chars > DOCUMENT_MAX_CONTENT_CHARS)
        throw new Error("PDF 总文字超过解析安全上限，本次搜索未完成；请拆分后重试。");
      if (!unit.text.trim()) emptyPages++;
      units.push(unit);
    }
    return searchDocumentUnits("pdf", units, query, `已扫描全部 ${pdf.numPages} 页的可提取文字层`, [
      PDF_TEXT_WARNING,
      ...(emptyPages ? [`${emptyPages} 页未提取到文字；这些页可用 view 查看。`] : []),
    ]);
  });
}

export async function extractLegacyPdf(
  bytes: Uint8Array,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  return withPdf(bytes, async (pdf) => {
    let text = "";
    let truncated = false;
    let hasContent = false;
    for (let number = 1; number <= pdf.numPages; number++) {
      const unit = await getPageText(pdf, number);
      hasContent ||= !!unit.text.trim();
      const addition = `\n[${unit.location}]\n${unit.text}`;
      const remaining = maxChars - text.length;
      text += addition.slice(0, remaining);
      if (addition.length > remaining) {
        truncated = true;
        break;
      }
    }
    if (!hasContent)
      throw new Error("PDF 没有可提取的文字，可能是扫描件；当前不支持 OCR，请提供文字版。");
    return { text, truncated };
  });
}
