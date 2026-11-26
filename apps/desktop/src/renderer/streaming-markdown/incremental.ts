/**
 * Incremental Markdown renderer.
 *
 * Mechanism 4 of the reference implementation: the document is split into
 * blocks; blocks whose text did not change keep their parsed HTML, so only the
 * trailing, still-growing block is parsed again on each update.
 *
 * Mechanism 5: `finish()` re-splits the whole document at exact top-level token
 * boundaries and re-parses it, restoring the structure the streaming splitter
 * can only approximate (loose lists, HTML blocks spanning blank lines, ...).
 */
import { sanitizeMarkdownText } from "@pico/protocol";

import { hashBlockText, splitStreamingBlocks } from "./blocks.js";
import { parseMarkdownBlock, parseMarkdownDocument, splitMarkdownDocument } from "./parser.js";

export interface RenderedMarkdownBlock {
  /** Content-derived stable key: survives appends to later blocks. */
  readonly key: string;
  /** Rendered HTML for this block. */
  readonly html: string;
  /** True when the block cannot change until the stream is reset. */
  readonly stable: boolean;
}

export interface MarkdownBlockParser {
  parseBlock(text: string): string;
  parseDocument(text: string): string;
  /** Top-level block slices, or `null` when the document needs a one-shot parse. */
  splitDocument(text: string): readonly string[] | null;
}

export interface IncrementalRendererStats {
  /** Block renders performed so far (cache misses). */
  readonly blockParses: number;
  /** Full-document final passes performed so far (one per `finish()`). */
  readonly documentParses: number;
}

const defaultParser: MarkdownBlockParser = {
  parseBlock: parseMarkdownBlock,
  parseDocument: parseMarkdownDocument,
  splitDocument: splitMarkdownDocument,
};

export class IncrementalMarkdownRenderer {
  private readonly parser: MarkdownBlockParser;
  /** hash -> HTML for the blocks present in the last update. */
  private cache = new Map<string, string>();
  private blockParses = 0;
  private documentParses = 0;

  constructor(parser: MarkdownBlockParser = defaultParser) {
    this.parser = parser;
  }

  get stats(): IncrementalRendererStats {
    return { blockParses: this.blockParses, documentParses: this.documentParses };
  }

  get cachedBlockCount(): number {
    return this.cache.size;
  }

  /**
   * Render the current source. `finished` runs the final full pass; streaming
   * updates reuse cached blocks and re-parse only blocks whose text changed.
   */
  update(source: string, finished = false): readonly RenderedMarkdownBlock[] {
    const text = sanitizeMarkdownText(source);
    return finished ? this.finalize(text) : this.renderStreaming(text);
  }

  private renderStreaming(text: string): readonly RenderedMarkdownBlock[] {
    const slices = splitStreamingBlocks(text);
    const nextCache = new Map<string, string>();
    const occurrences = new Map<string, number>();
    const blocks: RenderedMarkdownBlock[] = [];
    for (const slice of slices) {
      const hash = hashBlockText(slice.text);
      const html = this.renderCached(hash, slice.text, nextCache);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      blocks.push({ key: `${hash}:${occurrence}`, html, stable: slice.stable });
    }
    this.cache = nextCache;
    return blocks;
  }

  private finalize(text: string): readonly RenderedMarkdownBlock[] {
    this.documentParses += 1;
    const slices = this.parser.splitDocument(text);
    if (slices === null) {
      const html = this.parser.parseDocument(text);
      this.cache.clear();
      return [{ key: `${hashBlockText(text)}:0`, html, stable: true }];
    }
    const nextCache = new Map<string, string>();
    const occurrences = new Map<string, number>();
    const blocks: RenderedMarkdownBlock[] = [];
    for (const slice of slices) {
      const hash = hashBlockText(slice);
      const html = this.renderCached(hash, slice, nextCache);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      blocks.push({ key: `${hash}:${occurrence}`, html, stable: true });
    }
    this.cache = nextCache;
    return blocks;
  }

  private renderCached(hash: string, text: string, nextCache: Map<string, string>): string {
    let html = this.cache.get(hash);
    if (html === undefined) {
      html = this.parser.parseBlock(text);
      this.blockParses += 1;
    }
    nextCache.set(hash, html);
    return html;
  }
}
