// ImagePart 类型与 Message.images 字段测试(5.5a schema 层)。
import { describe, it, expect } from "vitest";
import type { Message, ImagePart } from "../../src/schema/message.js";

describe("5.5a Image Message schema", () => {
  it("Message 可以有 images 字段(可选)", () => {
    const msg: Message = {
      role: "user",
      content: "这张图是什么?",
      images: [{ type: "image_base64", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    };
    expect(msg.images).toBeDefined();
    expect(msg.images!.length).toBe(1);
  });

  it("Message 无 images 时完全兼容(向后兼容)", () => {
    const msg: Message = { role: "user", content: "纯文本消息" };
    expect(msg.images).toBeUndefined();
    expect(msg.content).toBe("纯文本消息");
  });

  it("ImagePart 支持 image_base64 和 image_url 两种", () => {
    const base64: ImagePart = { type: "image_base64", mimeType: "image/jpeg", data: "/9j/4AAQ" };
    const url: ImagePart = { type: "image_url", url: "https://example.com/img.png" };
    expect(base64.type).toBe("image_base64");
    expect(base64.mimeType).toBe("image/jpeg");
    expect(url.type).toBe("image_url");
    expect(url.url).toBe("https://example.com/img.png");
  });

  it("多条图片可以同时携带", () => {
    const msg: Message = {
      role: "user",
      content: "对比这两张图",
      images: [
        { type: "image_base64", mimeType: "image/png", data: "aaa" },
        { type: "image_url", url: "https://example.com/b.png" },
      ],
    };
    expect(msg.images!.length).toBe(2);
    expect(msg.images![0]!.type).toBe("image_base64");
    expect(msg.images![1]!.type).toBe("image_url");
  });

  it("图片消息可 JSON 序列化(持久化兼容)", () => {
    const msg: Message = {
      role: "user",
      content: "测试序列化",
      images: [{ type: "image_base64", mimeType: "image/png", data: "iVBOR" }],
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as Message;
    expect(parsed.images).toBeDefined();
    expect(parsed.images![0]!.type).toBe("image_base64");
  });
});
