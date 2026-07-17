import { stripVTControlCharacters } from "node:util";
import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { lexer, type Token, type Tokens } from "marked";

type ParsedMarkdown = { kind: "tokens"; tokens: Token[] } | { kind: "fallback"; content: string };

/** 使用 marked 只做词法解析，终端展示由 Ink token renderer 负责。 */
export function MarkdownText({
  content,
  dimColor = false,
}: {
  content: string;
  dimColor?: boolean;
}): React.ReactNode {
  const parsed = useMemo(() => parseMarkdown(content), [content]);
  if (parsed.kind === "fallback") {
    return <Text dimColor={dimColor}>{parsed.content}</Text>;
  }

  return (
    <Box flexDirection="column">
      {parsed.tokens.map((token, index) => renderBlock(token, `${token.type}-${index}`, dimColor))}
    </Box>
  );
}

function parseMarkdown(content: string): ParsedMarkdown {
  const safeContent = sanitizeTerminalText(content);
  try {
    return { kind: "tokens", tokens: lexer(safeContent, { gfm: true, breaks: false }) };
  } catch {
    // marked 对不完整 Markdown 有容错；这里仍保留纯文本降级，避免流式片段中断 TUI。
    return { kind: "fallback", content: safeContent };
  }
}

function renderBlock(token: Token, key: string, dimColor: boolean): React.ReactNode {
  switch (token.type) {
    case "space":
      return <Text key={key}> </Text>;
    case "hr":
      return (
        <Text key={key} dimColor>
          ────────────
        </Text>
      );
    case "code":
      return renderCode(token as Tokens.Code, key, dimColor);
    case "heading": {
      const heading = token as Tokens.Heading;
      return (
        <Text key={key} bold color={dimColor ? undefined : "cyan"} dimColor={dimColor} wrap="wrap">
          {renderInlines(heading.tokens, dimColor, key)}
        </Text>
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return (
        <Text key={key} dimColor={dimColor} wrap="wrap">
          {renderInlines(paragraph.tokens, dimColor, key)}
        </Text>
      );
    }
    case "text": {
      const text = token as Tokens.Text;
      return (
        <Text key={key} dimColor={dimColor} wrap="wrap">
          {text.tokens
            ? renderInlines(text.tokens, dimColor, key)
            : sanitizeTerminalText(text.text)}
        </Text>
      );
    }
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      return (
        <Box key={key} flexDirection="row">
          <Text dimColor={dimColor} color={dimColor ? undefined : "gray"}>
            │{" "}
          </Text>
          <Box flexDirection="column">
            {blockquote.tokens.map((child, index) =>
              renderBlock(child, `${key}-${child.type}-${index}`, dimColor),
            )}
          </Box>
        </Box>
      );
    }
    case "list":
      return renderList(token as Tokens.List, key, dimColor);
    case "table":
      return renderTable(token as Tokens.Table, key, dimColor);
    case "html":
    case "def":
      // 不把 HTML 交给任何 renderer，也不显示标签或脚本内容。
      return null;
    default:
      return renderUnknownBlock(token, key, dimColor);
  }
}

function renderCode(token: Tokens.Code, key: string, dimColor: boolean): React.ReactNode {
  return (
    <Box key={key} marginLeft={2} flexDirection="column">
      {token.lang && (
        <Text dimColor={dimColor} color="gray">
          {token.lang}
        </Text>
      )}
      <Text dimColor={dimColor} color="cyan" wrap="wrap">
        {token.text}
      </Text>
    </Box>
  );
}

function renderList(token: Tokens.List, key: string, dimColor: boolean): React.ReactNode {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box key={key} flexDirection="column">
      {token.items.map((item, index) => {
        const marker = item.task
          ? item.checked
            ? "☑"
            : "☐"
          : token.ordered
            ? `${start + index}.`
            : "•";
        const children = item.tokens.filter((child) => child.type !== "checkbox");
        return (
          <Box key={`${key}-item-${index}`} flexDirection="row">
            <Text dimColor={dimColor}>{marker} </Text>
            <Box flexDirection="column" flexGrow={1}>
              {children.map((child, childIndex) =>
                renderBlock(child, `${key}-item-${index}-${child.type}-${childIndex}`, dimColor),
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderTable(token: Tokens.Table, key: string, dimColor: boolean): React.ReactNode {
  return (
    <Box key={key} flexDirection="column">
      <Text dimColor={dimColor} wrap="wrap">
        │{" "}
        {token.header.map((cell, index) => (
          <React.Fragment key={`${key}-header-${index}`}>
            {index > 0 && " │ "}
            <Text bold>{renderInlines(cell.tokens, dimColor, `${key}-header-${index}`)}</Text>
          </React.Fragment>
        ))}
        {" │"}
      </Text>
      <Text dimColor>
        ├{token.header.map((_, index) => `${index > 0 ? "┼" : ""}───`).join("")}┤
      </Text>
      {token.rows.map((row, rowIndex) => (
        <Text key={`${key}-row-${rowIndex}`} dimColor={dimColor} wrap="wrap">
          │{" "}
          {row.map((cell, cellIndex) => (
            <React.Fragment key={`${key}-row-${rowIndex}-${cellIndex}`}>
              {cellIndex > 0 && " │ "}
              {renderInlines(cell.tokens, dimColor, `${key}-row-${rowIndex}-${cellIndex}`)}
            </React.Fragment>
          ))}
          {" │"}
        </Text>
      ))}
    </Box>
  );
}

function renderUnknownBlock(token: Token, key: string, dimColor: boolean): React.ReactNode {
  const children = tokenChildren(token);
  if (children) {
    return (
      <Box key={key} flexDirection="column">
        {children.map((child, index) =>
          renderBlock(child, `${key}-${child.type}-${index}`, dimColor),
        )}
      </Box>
    );
  }
  const text = tokenText(token);
  return text ? (
    <Text key={key} dimColor={dimColor} wrap="wrap">
      {text}
    </Text>
  ) : null;
}

function renderInlines(
  tokens: readonly Token[],
  dimColor: boolean,
  keyPrefix: string,
): React.ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${token.type}-${index}`;
    switch (token.type) {
      case "text":
        return (token as Tokens.Text).tokens ? (
          <React.Fragment key={key}>
            {renderInlines((token as Tokens.Text).tokens!, dimColor, key)}
          </React.Fragment>
        ) : (
          sanitizeTerminalText((token as Tokens.Text).text)
        );
      case "escape":
        return sanitizeTerminalText((token as Tokens.Escape).text);
      case "strong": {
        const strong = token as Tokens.Strong;
        return (
          <Text key={key} bold dimColor={dimColor}>
            {renderInlines(strong.tokens, dimColor, key)}
          </Text>
        );
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return (
          <Text key={key} italic dimColor={dimColor}>
            {renderInlines(emphasis.tokens, dimColor, key)}
          </Text>
        );
      }
      case "del": {
        const deletion = token as Tokens.Del;
        return (
          <Text key={key} strikethrough dimColor={dimColor}>
            {renderInlines(deletion.tokens, dimColor, key)}
          </Text>
        );
      }
      case "codespan":
        return (
          <Text key={key} color={dimColor ? undefined : "yellow"} dimColor={dimColor}>
            {sanitizeTerminalText((token as Tokens.Codespan).text)}
          </Text>
        );
      case "br":
        return "\n";
      case "link":
        return renderLink(token as Tokens.Link, key, dimColor);
      case "image":
        return (
          <Text key={key} dimColor={dimColor}>
            [图片: {sanitizeTerminalText((token as Tokens.Image).text) || "未命名"}]
          </Text>
        );
      case "html":
        return null;
      default:
        if (tokenChildren(token)) {
          return (
            <React.Fragment key={key}>
              {renderInlines(tokenChildren(token)!, dimColor, key)}
            </React.Fragment>
          );
        }
        return tokenText(token) || null;
    }
  });
}

function renderLink(token: Tokens.Link, key: string, dimColor: boolean): React.ReactNode {
  const label = renderInlines(token.tokens, dimColor, key);
  const href = sanitizeTerminalText(token.href).trim();
  if (!isSafeLinkTarget(href)) return <React.Fragment key={key}>{label}</React.Fragment>;

  return (
    <Text key={key} underline color={dimColor ? undefined : "cyan"} dimColor={dimColor}>
      {label} ({href})
    </Text>
  );
}

function isSafeLinkTarget(href: string): boolean {
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(href)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

function tokenChildren(token: Token): Token[] | undefined {
  const children = (token as { tokens?: unknown }).tokens;
  return Array.isArray(children) ? (children as Token[]) : undefined;
}

function tokenText(token: Token): string {
  const text = (token as { text?: unknown }).text;
  return typeof text === "string" ? sanitizeTerminalText(text) : "";
}

/** 去掉 ANSI/OSC 等 VT 序列与不可见控制字符，保留 Markdown 所需的换行和制表符。 */
function sanitizeTerminalText(content: string): string {
  const withoutVt = stripVTControlCharacters(content.replace(/\r\n?/gu, "\n"));
  return [...withoutVt]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        (codePoint >= 32 && (codePoint < 127 || codePoint > 159))
      );
    })
    .join("");
}
