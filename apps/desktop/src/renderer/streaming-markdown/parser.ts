/**
 * Markdown parser used by the streaming renderer.
 *
 * Input policy matches Desktop's existing Markdown surface:
 * - raw HTML is dropped (never injected into the DOM);
 * - unsafe link schemes render as inert text;
 * - images become placeholders so remote content is never loaded.
 *
 * The parser also exposes the top-level token split used for the final pass,
 * so the finished document is re-split at exact Markdown block boundaries.
 */
import { isSafeMarkdownHref } from "@pico/protocol";
import { Marked, type Renderer } from "marked";

const markdown = new Marked({ gfm: true, breaks: false, async: false });

markdown.use({
  renderer: {
    html() {
      return "";
    },
    image({ text }) {
      return `<span class="streaming-markdown__image-placeholder">[图片：${escapeHtml(text)}]</span>`;
    },
    link(this: Renderer, { href, title, text, tokens, autolink }) {
      const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens ?? []);
      if (!isSafeMarkdownHref(href)) {
        return `<span class="streaming-markdown__blocked-link" title="链接已拦截">${label}</span>`;
      }
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank"${titleAttribute}>${label}</a>`;
    },
  },
});

/** Render one Markdown block to HTML. */
export function parseMarkdownBlock(text: string): string {
  return render(text);
}

/** Render a whole Markdown document in one pass. */
export function parseMarkdownDocument(text: string): string {
  return render(text);
}

/**
 * Split a finished document at its top-level token boundaries.
 *
 * Returns `null` when the document cannot be represented as independently
 * parsed blocks (link reference definitions are document-scoped, so they need
 * the one-shot path). Concatenating the parsed blocks reproduces the one-shot
 * output exactly.
 */
export function splitMarkdownDocument(text: string): readonly string[] | null {
  const tokens = markdown.lexer(text);
  if (tokens.some((token) => token.type === "def")) return null;
  return tokens
    .filter((token) => token.type !== "space" && token.raw.length > 0)
    .map((token) => token.raw);
}

function render(text: string): string {
  const html = markdown.parse(text);
  if (typeof html !== "string") throw new Error("Streaming Markdown parser must be synchronous");
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
