// 行尾风格归一化单测(对标 kimi-code line-endings)。
// 覆盖:detect 分类 / toModelTextView 归一化 / materializeModelText 还原 /
// makeCarriageReturnsVisible 展示 / crlf 往返一致性。

import { describe, expect, it } from "vitest";
import {
  detectLineEndingStyle,
  makeCarriageReturnsVisible,
  materializeModelText,
  toModelTextView,
} from "../src/tools/line-endings.js";

describe("detectLineEndingStyle 行尾风格分类", () => {
  it("纯 LF → lf", () => {
    expect(detectLineEndingStyle("a\nb\nc\n")).toBe("lf");
  });

  it("纯 CRLF → crlf", () => {
    expect(detectLineEndingStyle("a\r\nb\r\n")).toBe("crlf");
  });

  it("LF 与 CRLF 混杂 → mixed", () => {
    expect(detectLineEndingStyle("a\r\nb\nc")).toBe("mixed");
  });

  it("含 lone CR(无配对 LF)→ mixed", () => {
    expect(detectLineEndingStyle("a\rb\r")).toBe("mixed");
  });

  it("CRLF 与 lone CR 并存 → mixed", () => {
    expect(detectLineEndingStyle("a\r\nb\rc")).toBe("mixed");
  });

  it("无换行符 → lf(无证据表明非 LF,默认 LF)", () => {
    expect(detectLineEndingStyle("no newlines here")).toBe("lf");
  });

  it("空字符串 → lf", () => {
    expect(detectLineEndingStyle("")).toBe("lf");
  });
});

describe("toModelTextView 磁盘 → 模型视图", () => {
  it("CRLF 文本被归一化为 LF,style 记为 crlf", () => {
    const view = toModelTextView("a\r\nb\r\n");
    expect(view.lineEndingStyle).toBe("crlf");
    expect(view.text).toBe("a\nb\n");
  });

  it("LF 文本原样返回,style 记为 lf", () => {
    const view = toModelTextView("a\nb\n");
    expect(view.lineEndingStyle).toBe("lf");
    expect(view.text).toBe("a\nb\n");
  });

  it("mixed 文本原样返回,style 记为 mixed(不归一化)", () => {
    const raw = "a\r\nb\nc";
    const view = toModelTextView(raw);
    expect(view.lineEndingStyle).toBe("mixed");
    expect(view.text).toBe(raw);
  });

  it("lone CR 文本原样返回,style 记为 mixed", () => {
    const raw = "a\rb";
    const view = toModelTextView(raw);
    expect(view.lineEndingStyle).toBe("mixed");
    expect(view.text).toBe(raw);
  });
});

describe("materializeModelText 模型视图 → 磁盘", () => {
  it("lf style:LF 文本原样返回", () => {
    expect(materializeModelText("a\nb\n", "lf")).toBe("a\nb\n");
  });

  it("crlf style:LF 文本还原为 CRLF", () => {
    expect(materializeModelText("a\nb\n", "crlf")).toBe("a\r\nb\r\n");
  });

  it("crlf style:含杂散 CRLF 的文本先归一再还原(防御模型引入的 \r)", () => {
    // 模型编辑后可能混入 \r\n,先归一为 \n 再统一转 CRLF,避免出现 \r\r\n
    expect(materializeModelText("a\r\nb\n", "crlf")).toBe("a\r\nb\r\n");
  });

  it("mixed style:原样返回,不做任何转换", () => {
    const raw = "a\r\nb\nc";
    expect(materializeModelText(raw, "mixed")).toBe(raw);
  });

  it("crlf 往返一致性:toModelTextView 后 materializeModelText 恢复原样", () => {
    const original = "line1\r\nline2\r\nline3\r\n";
    const view = toModelTextView(original);
    expect(view.lineEndingStyle).toBe("crlf");
    const restored = materializeModelText(view.text, view.lineEndingStyle);
    expect(restored).toBe(original);
  });

  it("lf 往返一致性:原样进出不变", () => {
    const original = "line1\nline2\n";
    const view = toModelTextView(original);
    const restored = materializeModelText(view.text, view.lineEndingStyle);
    expect(restored).toBe(original);
  });
});

describe("makeCarriageReturnsVisible CR 可视化", () => {
  it("把 \\r 渲染成字面量 \\\\r(两个字符)", () => {
    expect(makeCarriageReturnsVisible("a\rb\r")).toBe("a\\rb\\r");
  });

  it("CRLF 中的 \\r 也被渲染(展示用,不区分上下文)", () => {
    expect(makeCarriageReturnsVisible("a\r\nb")).toBe("a\\r\nb");
  });

  it("无 CR 的文本不受影响", () => {
    expect(makeCarriageReturnsVisible("a\nb\n")).toBe("a\nb\n");
  });

  it("空字符串不受影响", () => {
    expect(makeCarriageReturnsVisible("")).toBe("");
  });
});
