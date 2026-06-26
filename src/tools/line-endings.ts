// 行尾风格归一化:磁盘字节流 ↔ 模型视图之间的"编解码器"。
// 对标 kimi-code line-endings.ts。Read/Edit 工具共用,解决 CRLF 文件匹配失败、
// 写回破坏格式的问题。核心思想:模型只看到 \n,写回时按原始风格还原。

/** 行尾风格:lf=纯 LF,crlf=纯 CRLF,mixed=含 lone CR 或 LF/CRLF 混杂 */
export type LineEndingStyle = "lf" | "crlf" | "mixed";

/** 模型视图:归一化后的文本 + 记录的原始行尾风格(供写回还原) */
export interface ModelTextView {
  text: string;
  lineEndingStyle: LineEndingStyle;
}

/**
 * 扫描文本判定行尾风格。
 * - 含 lone CR(独立的 \r)→ mixed(古典 Mac 风格,极少见但需显式标记,不归一化)
 * - 同时含 CRLF 和 LF → mixed(混杂,不归一化,Read 时把 \r 显示成字面量提醒用户)
 * - 只有 CRLF → crlf
 * - 其他(纯 LF / 无换行)→ lf
 */
export function detectLineEndingStyle(text: string): LineEndingStyle {
  let hasCrLf = false;
  let hasLf = false;
  let hasLoneCr = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === 13) {
      // \r:看下一个字符是否为 \n,区分 CRLF 与 lone CR
      if (text.codePointAt(i + 1) === 10) {
        hasCrLf = true;
        i++; // 跳过已配对的 \n,避免误判为 lone LF
      } else {
        hasLoneCr = true;
      }
    } else if (code === 10) {
      hasLf = true;
    }
  }

  if (hasLoneCr || (hasCrLf && hasLf)) return "mixed";
  if (hasCrLf) return "crlf";
  return "lf";
}

/**
 * 磁盘字节流 → 模型视图。
 * 只有纯 CRLF 才归一化为 \n(模型只处理一种行尾,Edit 匹配才稳定);
 * lf/mixed 原样返回(mixed 不归一化,避免破坏 lone CR 语义)。
 */
export function toModelTextView(raw: string): ModelTextView {
  const lineEndingStyle = detectLineEndingStyle(raw);
  if (lineEndingStyle !== "crlf") {
    return { text: raw, lineEndingStyle };
  }

  return {
    text: raw.replaceAll("\r\n", "\n"),
    lineEndingStyle,
  };
}

/**
 * 模型视图 → 磁盘字节流(按记录的原始风格写回)。
 * crlf:先把可能混入的 \r\n 归一为 \n,再统一转成 \r\n(防御模型在编辑中引入的杂散 \r)。
 * lf/mixed:原样返回(混合风格不做任何转换,保留用户原始字节)。
 */
export function materializeModelText(text: string, lineEndingStyle: LineEndingStyle): string {
  if (lineEndingStyle !== "crlf") return text;
  return text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
}

/**
 * 把 \r 渲染成字面量 "\\r"(两个字符),供 Read 输出 mixed 文件时提醒用户:
 * 文件含杂散 CR,Edit 匹配可能失败,需人工确认。仅用于展示,不修改真实内容。
 */
export function makeCarriageReturnsVisible(text: string): string {
  return text.replaceAll("\r", "\\r");
}
