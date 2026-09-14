// 行尾风格归一化:磁盘字节流 ↔ 模型视图之间的纯文本编解码器。
// 宿主负责文件读写，Runtime 负责可复用的模型文本视图语义。

/** 行尾风格:lf=纯 LF,crlf=纯 CRLF,mixed=含 lone CR 或 LF/CRLF 混杂 */
export type LineEndingStyle = "lf" | "crlf" | "mixed";

/** 模型视图:归一化后的文本 + 记录的原始行尾风格(供写回还原) */
export interface ModelTextView {
  text: string;
  lineEndingStyle: LineEndingStyle;
}

/** 扫描文本判定行尾风格。 */
export function detectLineEndingStyle(text: string): LineEndingStyle {
  let hasCrLf = false;
  let hasLf = false;
  let hasLoneCr = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        hasCrLf = true;
        i++;
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

/** 磁盘字节流 → 模型视图。 */
export function toModelTextView(raw: string): ModelTextView {
  const lineEndingStyle = detectLineEndingStyle(raw);
  if (lineEndingStyle !== "crlf") return { text: raw, lineEndingStyle };
  return { text: raw.replaceAll("\r\n", "\n"), lineEndingStyle };
}

/** 模型视图 → 磁盘字节流(按记录的原始风格写回)。 */
export function materializeModelText(text: string, lineEndingStyle: LineEndingStyle): string {
  if (lineEndingStyle !== "crlf") return text;
  return text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
}

/** 把 \r 渲染成字面量 "\\r",仅用于展示。 */
export function makeCarriageReturnsVisible(text: string): string {
  return text.replaceAll("\r", "\\r");
}
