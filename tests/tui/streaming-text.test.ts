// streaming-text 单元测试:验证按行分割逻辑 + stable/unstable 边界推进。

import { describe, expect, it } from "vitest";
import { getStableBoundary, splitCodeBlocks } from "../../src/tui/streaming-text.js";

describe("streaming-text", () => {
  describe("getStableBoundary", () => {
    it("无换行时返回 0(全 unstable)", () => {
      expect(getStableBoundary("正在写的第一行")).toBe(0);
    });

    it("有一行完成的(含换行),边界在换行后", () => {
      expect(getStableBoundary("第一行\n第二行")).toBe(4);
    });

    it("多行:边界在最后一个换行后", () => {
      expect(getStableBoundary("第一行\n第二行\n第三")).toBe(8); // 第三行还在写
    });

    it("空字符串返回 0", () => {
      expect(getStableBoundary("")).toBe(0);
    });

    it("只有换行符:边界=1", () => {
      expect(getStableBoundary("\n")).toBe(1);
      expect(getStableBoundary("\n\n")).toBe(2);
    });
  });

  describe("splitCodeBlocks", () => {
    it("无代码块:返回单个非代码段", () => {
      const segs = splitCodeBlocks("普通文本");
      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({ text: "普通文本", code: false });
    });

    it("含代码块:奇数下标段为 code", () => {
      const segs = splitCodeBlocks("前文\n```ts\nconst x = 1\n```\n后文");
      // split("```") → ["前文\n", "ts\nconst x = 1\n", "\n后文"] = 3 段
      expect(segs).toHaveLength(3);
      expect(segs.map((s) => s.code)).toEqual([false, true, false]);
    });

    it("代码块首行语言标识被去除", () => {
      const segs = splitCodeBlocks("```ts\nconst x = 1\n```");
      const codeSeg = segs[1]!;
      expect(codeSeg.code).toBe(true);
      expect(codeSeg.text).not.toContain("ts\n"); // 语言标识行去掉
      expect(codeSeg.text).toContain("const x = 1");
    });

    it("代码块首行非语言标识(有空格)则保留", () => {
      const segs = splitCodeBlocks("```\nplain code\n```");
      const codeSeg = segs[1]!;
      expect(codeSeg.text).toContain("plain code");
    });
  });
});
