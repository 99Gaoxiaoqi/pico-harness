import { lexer, type Token, type Tokens } from "marked";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import React, { Fragment, useMemo, type ElementType, type ReactNode } from "react";

// The desktop Vite build uses the automatic JSX runtime; this keeps the module executable in
// the repository's Node-based integration harness, which still lowers JSX through React.createElement.
void React;

const MARKED_OPTIONS = { gfm: true, breaks: false } as const;

export interface MarkdownTextProps {
  readonly text: string;
  readonly dim?: boolean | undefined;
}

/**
 * Small React projection of the shared marked token tree.
 *
 * Keeping the projection token based avoids injecting marked HTML into the renderer. Raw HTML,
 * images and unsafe links are deliberately rendered as inert text so a model response cannot
 * turn the Electron renderer into a navigation or script surface.
 */
export function MarkdownText({ text, dim = false }: MarkdownTextProps) {
  const tokens = useMemo(() => lexer(stripControls(text), MARKED_OPTIONS), [text]);
  return (
    <div className={`desktop-markdown${dim ? " desktop-markdown--dim" : ""}`}>
      {renderBlocks(tokens, "root")}
    </div>
  );
}

function renderBlocks(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `${keyPrefix}-${index}`;
    const rendered = renderBlock(token, key);
    return rendered === null || rendered === undefined ? [] : [rendered];
  });
}

function renderBlock(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(1, token.depth))}` as ElementType;
      return <Tag key={key}>{renderInline(token.tokens ?? [], key)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInline(token.tokens ?? [], key)}</p>;
    case "text":
      return token.tokens ? (
        <Fragment key={key}>{renderInline(token.tokens, key)}</Fragment>
      ) : (
        <span key={key}>{token.text}</span>
      );
    case "code":
      return (
        <pre key={key} className="desktop-markdown__code">
          <code>{token.text}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={key}>{renderBlocks(token.tokens ?? [], key)}</blockquote>;
    case "list": {
      const List = token.ordered ? "ol" : "ul";
      return (
        <List key={key} start={token.ordered && token.start !== 1 ? token.start : undefined}>
          {token.items.map((item: Tokens.ListItem, index: number) => (
            <li key={`${key}-item-${index}`}>
              {item.task && (
                <input
                  type="checkbox"
                  checked={item.checked === true}
                  disabled
                  readOnly
                  aria-label={item.checked ? "已完成" : "未完成"}
                />
              )}
              {renderBlocks(item.tokens, `${key}-item-${index}`)}
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div key={key} className="desktop-markdown__table-wrap">
          <table>
            <thead>
              <tr>
                {token.header.map((cell: Tokens.TableCell, index: number) =>
                  renderTableCell(cell, `${key}-head-${index}`),
                )}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row: Tokens.TableCell[], rowIndex: number) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell: Tokens.TableCell, cellIndex: number) =>
                    renderTableCell(cell, `${key}-row-${rowIndex}-${cellIndex}`),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
    case "br":
      return <br key={key} />;
    case "html":
      return null;
    default:
      return renderInlineToken(token, key);
  }
}

function renderTableCell(cell: Tokens.TableCell, key: string): ReactNode {
  const Tag = cell.header ? "th" : "td";
  return (
    <Tag key={key} style={cell.align ? { textAlign: cell.align } : undefined}>
      {renderInline(cell.tokens, key)}
    </Tag>
  );
}

function renderInline(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `${keyPrefix}-inline-${index}`;
    const rendered = renderInlineToken(token, key);
    return rendered === null || rendered === undefined ? [] : [rendered];
  });
}

function renderInlineToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "text":
      return token.tokens ? (
        <Fragment key={key}>{renderInline(token.tokens, key)}</Fragment>
      ) : (
        <span key={key}>{token.text}</span>
      );
    case "escape":
      return <span key={key}>{token.text}</span>;
    case "strong":
      return <strong key={key}>{renderInline(token.tokens ?? [], key)}</strong>;
    case "em":
      return <em key={key}>{renderInline(token.tokens ?? [], key)}</em>;
    case "del":
      return <del key={key}>{renderInline(token.tokens ?? [], key)}</del>;
    case "codespan":
      return <code key={key}>{token.text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const children = renderInline(token.tokens ?? [], key);
      return isSafeHref(token.href) ? (
        <a key={key} href={token.href} rel="noopener noreferrer" target="_blank">
          {children}
        </a>
      ) : (
        <span key={key} className="desktop-markdown__blocked-link" title="链接已拦截">
          {children}
        </span>
      );
    }
    case "image":
      return (
        <span key={key} className="desktop-markdown__image-placeholder">
          [图片：{token.text}]
        </span>
      );
    case "html":
      return null;
    default: {
      const generic = token as Token & {
        readonly tokens?: readonly Token[];
        readonly text?: string;
      };
      if (generic.tokens) return <Fragment key={key}>{renderInline(generic.tokens, key)}</Fragment>;
      return generic.text ? <span key={key}>{generic.text}</span> : null;
    }
  }
}

function stripControls(value: string): string {
  return sanitizeMarkdownText(value);
}

function isSafeHref(value: string): boolean {
  return isSafeMarkdownHref(value);
}
