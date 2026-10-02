import {
  isSafeMarkdownHref,
  sanitizeMarkdownText,
  type RuntimeMediaReference,
} from "@pico/protocol/mobile";
import { lexer, type Token, type Tokens } from "marked";

export interface MarkdownTextRun {
  readonly type: "text";
  readonly text: string;
  readonly strong?: boolean;
  readonly emphasis?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  readonly blocked?: boolean;
}

export type MarkdownInline =
  | MarkdownTextRun
  | { readonly type: "media"; readonly reference: RuntimeMediaReference };

export type MarkdownBlock =
  | { readonly type: "paragraph"; readonly inline: readonly MarkdownInline[] }
  | { readonly type: "heading"; readonly level: number; readonly inline: readonly MarkdownInline[] }
  | { readonly type: "code"; readonly text: string; readonly language: string }
  | { readonly type: "quote"; readonly blocks: readonly MarkdownBlock[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly {
        readonly checked?: boolean;
        readonly blocks: readonly MarkdownBlock[];
      }[];
    }
  | {
      readonly type: "table";
      readonly align: readonly ("left" | "center" | "right" | null)[];
      readonly header: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    }
  | { readonly type: "rule" };

/** Exact registered destinations only; model-provided schemes never authorize a resource. */
export function registeredMedia(
  destination: string,
  media: readonly RuntimeMediaReference[],
): RuntimeMediaReference | undefined {
  if (destination.startsWith("pico://artifact/"))
    return media.find(
      (reference) => destination === `pico://artifact/${encodeURIComponent(reference.artifactId)}`,
    );
  if (
    !destination ||
    (/^[a-z][a-z0-9+.-]*:/i.test(destination) && !destination.startsWith("file://")) ||
    destination.startsWith("//")
  )
    return undefined;
  return media.find((reference) => reference.source === destination);
}

/** Pure model shared by native rendering and transcript media deduplication. */
export function parseMarkdown(
  text: string,
  media: readonly RuntimeMediaReference[] = [],
): readonly MarkdownBlock[] {
  const inline = (
    tokens: readonly Token[],
    format: Omit<MarkdownTextRun, "type" | "text"> = {},
  ): MarkdownInline[] => {
    const result: MarkdownInline[] = [];
    const append = (value: string, style = format) => {
      if (value) result.push({ type: "text", text: value, ...style });
    };
    let rawHtml = false;
    for (const token of tokens) {
      if (token.type === "html") {
        // marked exposes script/pre/style contents as separate inline tokens. Keep
        // those contents inert even if they contain apparent Markdown resources.
        rawHtml = (token as Tokens.Tag).inRawBlock === true;
        continue;
      }
      if (rawHtml) {
        append(token.raw);
        continue;
      }
      switch (token.type) {
        case "strong":
          result.push(...inline((token as Tokens.Strong).tokens, { ...format, strong: true }));
          break;
        case "em":
          result.push(...inline((token as Tokens.Em).tokens, { ...format, emphasis: true }));
          break;
        case "del":
          result.push(...inline((token as Tokens.Del).tokens, { ...format, strike: true }));
          break;
        case "codespan":
          append((token as Tokens.Codespan).text, { ...format, code: true });
          break;
        case "br":
          append("\n");
          break;
        case "image": {
          const image = token as Tokens.Image;
          const reference = registeredMedia(image.href, media);
          if (reference) result.push({ type: "media", reference });
          else
            append(`[图片：${decodeText(image.text) || "未登记资源"}，未加载]`, {
              ...format,
              blocked: true,
            });
          break;
        }
        case "link": {
          const link = token as Tokens.Link;
          const reference = registeredMedia(link.href, media);
          if (reference?.kind === "video") result.push({ type: "media", reference });
          else if (isSafeMarkdownHref(link.href))
            result.push(...inline(link.tokens, { ...format, href: decodeText(link.href).trim() }));
          else {
            result.push(...inline(link.tokens, { ...format, blocked: true }));
            append(" [链接已拦截]", { ...format, blocked: true });
          }
          break;
        }
        case "text": {
          const textToken = token as Tokens.Text;
          if (textToken.tokens) result.push(...inline(textToken.tokens, format));
          else append(decodeText(textToken.text).replace(/\n/gu, " "));
          break;
        }
        case "escape":
          append((token as Tokens.Escape).text);
          break;
        default:
          append(token.raw);
      }
    }
    return result;
  };
  const blocks = (tokens: readonly Token[]): MarkdownBlock[] => {
    const result: MarkdownBlock[] = [];
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
        case "html":
        case "checkbox":
          break;
        case "paragraph":
        case "text": {
          const textToken = token as Tokens.Paragraph | Tokens.Text;
          const content = textToken.tokens
            ? inline(textToken.tokens)
            : [{ type: "text" as const, text: decodeText(textToken.text) }];
          if (content.length) result.push({ type: "paragraph", inline: content });
          break;
        }
        case "heading": {
          const heading = token as Tokens.Heading;
          result.push({ type: "heading", level: heading.depth, inline: inline(heading.tokens) });
          break;
        }
        case "code": {
          const code = token as Tokens.Code;
          result.push({ type: "code", text: code.text, language: code.lang ?? "" });
          break;
        }
        case "blockquote":
          result.push({ type: "quote", blocks: blocks((token as Tokens.Blockquote).tokens) });
          break;
        case "list": {
          const list = token as Tokens.List;
          result.push({
            type: "list",
            ordered: list.ordered,
            start: Number(list.start) || 1,
            items: list.items.map((item) => ({
              ...(item.task ? { checked: !!item.checked } : {}),
              blocks: blocks(item.tokens),
            })),
          });
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          result.push({
            type: "table",
            align: table.align,
            header: table.header.map((cell) => inline(cell.tokens)),
            rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
          });
          break;
        }
        case "hr":
          result.push({ type: "rule" });
          break;
        default:
          result.push({ type: "paragraph", inline: [{ type: "text", text: token.raw }] });
      }
    }
    return result;
  };
  return blocks(lexer(sanitizeMarkdownText(text), { gfm: true, breaks: false }));
}

/** Only media slots in the parsed document suppress the separate attachment preview. */
export function referencedMediaIds(
  text: string,
  media: readonly RuntimeMediaReference[],
): Set<string> {
  const ids = new Set<string>();
  const collectInline = (inline: readonly MarkdownInline[]) => {
    for (const node of inline) if (node.type === "media") ids.add(node.reference.artifactId);
  };
  const visit = (blocks: readonly MarkdownBlock[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph" || block.type === "heading") collectInline(block.inline);
      else if (block.type === "quote") visit(block.blocks);
      else if (block.type === "list") for (const item of block.items) visit(item.blocks);
      else if (block.type === "table")
        for (const row of [block.header, ...block.rows])
          for (const cell of row) collectInline(cell);
    }
  };
  visit(parseMarkdown(text, media));
  return ids;
}

// Native Text does not decode the HTML entities that Markdown allows in prose.
function decodeText(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    copy: "©",
    reg: "®",
    trade: "™",
    mdash: "—",
    ndash: "–",
    hellip: "…",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    if (!name.startsWith("#")) return named[name] ?? entity;
    const codePoint =
      name[1]?.toLowerCase() === "x"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
    return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)
      ? sanitizeMarkdownText(String.fromCodePoint(codePoint))
      : "\ufffd";
  });
}
