import {
  Markdown,
  type MarkdownComponents,
  type MarkdownInlinePlugin,
} from "@astryxdesign/core/Markdown";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import { lexer, type Token, type Tokens } from "marked";
import React, { useMemo, type ElementType } from "react";

// Node integration tests use the classic JSX transform.
void React;

export interface MarkdownTextProps {
  readonly text: string;
  readonly dim?: boolean | undefined;
}

const components: MarkdownComponents = {
  code: ({ code }) => (
    <pre className="desktop-markdown__code">
      <code>{code}</code>
    </pre>
  ),
  inlineCode: ({ children }) => <code>{children}</code>,
  link: ({ href, children }) =>
    isSafeMarkdownHref(href) ? (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span className="desktop-markdown__blocked-link" title="链接已拦截">
        {children}
      </span>
    ),
  image: ({ alt }) => <span className="desktop-markdown__image-placeholder">[图片：{alt}]</span>,
  heading: ({ level, children }) => {
    const Tag = `h${level}` as ElementType;
    return <Tag>{children}</Tag>;
  },
  paragraph: ({ children }) => <p>{children}</p>,
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
  hr: () => <hr />,
};

/** Astryx renders the document; Pico retains its text, URL and inert-image policy. */
export function MarkdownText({ text, dim = false }: MarkdownTextProps) {
  const markdown = useMemo(() => {
    const sanitized = sanitizeMarkdownText(text);
    // Astryx 0.6.2 drops checkboxes in mixed ordinary/task lists. Preserve the existing
    // inert checkboxes through its inline renderer, using a marker absent from the input.
    let prefix = "\uE000pico-task-";
    while (sanitized.includes(prefix)) prefix += "x";
    const inlinePlugins: MarkdownInlinePlugin[] = [
      {
        pattern: new RegExp(`${prefix}(checked|unchecked)\uE001`, "g"),
        render: (match, key) => (
          <input
            key={key}
            type="checkbox"
            checked={match[1] === "checked"}
            disabled
            readOnly
            aria-label={match[1] === "checked" ? "已完成" : "未完成"}
          />
        ),
      },
    ];
    return {
      text: filterHtml(sanitized, lexer(sanitized, { gfm: true, breaks: false }), prefix),
      inlinePlugins,
    };
  }, [text]);
  return (
    <Markdown
      className={`desktop-markdown${dim ? " desktop-markdown--dim" : ""}`}
      components={components}
      inlinePlugins={markdown.inlinePlugins}
      isStreaming={false}
      autolink="gfm"
    >
      {markdown.text}
    </Markdown>
  );
}

/**
 * Remove only HTML tokens identified by marked, never strings that look like tags in code.
 * Preserve source gaps (including reference definitions) and untouched token spelling.
 */
function filterHtml(source: string, tokens: readonly Token[], taskPrefix: string): string {
  let cursor = 0;
  let result = "";
  for (const token of tokens) {
    const offset = source.indexOf(token.raw, cursor);
    if (offset < 0) continue;
    result += source.slice(cursor, offset) + filterToken(token, taskPrefix);
    cursor = offset + token.raw.length;
  }
  return result + source.slice(cursor);
}

function filterToken(token: Token, taskPrefix: string): string {
  if (token.type === "html") return "";
  if (token.type === "code" || token.type === "codespan") return token.raw;
  if (token.type === "blockquote") {
    const filtered = filterHtml(token.text, token.tokens ?? [], taskPrefix);
    return filtered === token.text
      ? token.raw
      : filtered
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n";
  }
  if (token.type === "list") {
    const filtered: string[] = token.items.map((item: Tokens.ListItem) =>
      filterHtml(item.text, item.tokens, taskPrefix),
    );
    if (
      !token.items.some((item: Tokens.ListItem) => item.task) &&
      filtered.every((text, index) => text === token.items[index]?.text)
    )
      return token.raw;
    return (
      token.items
        .map((item: Tokens.ListItem, index: number) => {
          const marker = token.ordered ? `${Number(token.start) + index}. ` : "- ";
          const task = item.task
            ? `${taskPrefix}${item.checked ? "checked" : "unchecked"}\uE001 `
            : "";
          const lines = (task + filtered[index]).split("\n");
          return marker + lines.join(`\n${" ".repeat(marker.length)}`);
        })
        .join(token.loose ? "\n\n" : "\n") + "\n"
    );
  }
  if (token.type === "table") {
    const cells = [token.header, ...token.rows];
    const filtered = cells.map((row: Tokens.TableCell[]) =>
      row.map((cell) => filterHtml(cell.text, cell.tokens, taskPrefix)),
    );
    if (filtered.every((row, i) => row.every((text, j) => text === cells[i]?.[j]?.text)))
      return token.raw;
    const row = (values: string[]) => `| ${values.join(" | ")} |`;
    const alignment = token.align.map((align: string | null) =>
      align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---",
    );
    return (
      [row(filtered[0] ?? []), row(alignment), ...filtered.slice(1).map(row)].join("\n") + "\n"
    );
  }
  const nested = (token as Token & { tokens?: Token[] }).tokens;
  return nested ? filterHtml(token.raw, nested, taskPrefix) : token.raw;
}
