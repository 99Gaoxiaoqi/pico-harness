/**
 * Structural block splitting for streaming Markdown.
 *
 * Streaming uses coarse blank-line boundaries that are cheap to recompute while
 * text arrives. Fenced code blocks are kept intact even when blank lines or
 * chunk boundaries occur inside them. The finished document is re-split by the
 * parser's top-level tokens (see `parser.ts`), which restores exact structure.
 */

export interface MarkdownBlockSlice {
  /** Markdown source of this block, without the blank line that terminated it. */
  readonly text: string;
  /** False only for the trailing block that may still receive more text. */
  readonly stable: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const BLANK_LINE = /^[ \t]*$/u;

interface OpenFence {
  readonly character: string;
  readonly length: number;
}

/** Split streaming source at blank lines while keeping fenced code intact. */
export function splitStreamingBlocks(source: string): MarkdownBlockSlice[] {
  const blocks: MarkdownBlockSlice[] = [];
  let blockStart = -1;
  let fence: OpenFence | null = null;
  let lineStart = 0;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);

    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (BLANK_LINE.test(line)) {
      if (blockStart >= 0) {
        pushSlice(blocks, source, blockStart, lineStart, true);
        blockStart = -1;
      }
    } else {
      if (blockStart < 0) blockStart = lineStart;
      const opening = FENCE_OPEN.exec(line);
      if (opening) fence = { character: opening[1]![0]!, length: opening[1]!.length };
    }

    if (lineEnd === source.length) break;
    lineStart = lineEnd + 1;
  }

  if (blockStart >= 0) pushSlice(blocks, source, blockStart, source.length, false);
  return blocks;
}

function closesFence(line: string, fence: OpenFence): boolean {
  const closing = FENCE_CLOSE.exec(line);
  return (
    closing !== null && closing[1]![0] === fence.character && closing[1]!.length >= fence.length
  );
}

function pushSlice(
  blocks: MarkdownBlockSlice[],
  source: string,
  start: number,
  end: number,
  stable: boolean,
): void {
  const text = source.slice(start, end).replace(/\s+$/u, "");
  if (text.length > 0) blocks.push({ text, stable });
}

/**
 * Content hash used as the stable React key and the parse-cache key.
 * Two independent FNV-1a passes keep collision probability negligible for
 * document-sized inputs while staying synchronous and dependency-free.
 */
export function hashBlockText(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}
