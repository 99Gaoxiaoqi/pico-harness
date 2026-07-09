// 5.5e 图片入口测试:本地图片路径 → loadImage 转 ImagePart。
//
// 验证:
// 1. loadImage 读取文件 → base64 + 按后缀推断 mimeType
// 2. 不同后缀(png/jpg/jpeg/gif/webp/未知)→ 不同 mimeType,未知回落 image/png
// 3. 集成:runAgentFromCli 带 imagePath → session 的 user 消息含 images

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import { loadImage } from "../src/input/prepare-prompt.js";
import type { ImagePart, Message } from "../src/schema/message.js";
import type { LLMProvider } from "../src/provider/interface.js";

/**
 * 把 ImagePart 当成 image_base64 变体取字段(loadImage 恒返回此变体)。
 * ImagePart 是联合类型,TS 不让直接取 mimeType/data,这里集中收窄。
 */
function asBase64(img: ImagePart): { type: "image_base64"; mimeType: string; data: string } {
  expect(img.type).toBe("image_base64");
  return img as { type: "image_base64"; mimeType: string; data: string };
}

/** 跨平台安全删除 */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (String(err).includes("EBUSY") || String(err).includes("EPERM")) {
        await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** 写一个小文件并返回路径 */
async function writeTmp(workDir: string, name: string, content: string): Promise<string> {
  const p = join(workDir, name);
  await writeFile(p, content);
  return p;
}

/** 返回固定最终答案的 mock provider(不需要工具),并捕获传给它的 messages */
class CapturingProvider implements LLMProvider {
  readonly modelName = "mock";
  readonly calls: Array<{ messages: Message[] }> = [];
  async generate(messages: Message[]): Promise<Message> {
    this.calls.push({ messages: [...messages] });
    return { role: "assistant", content: "done" };
  }
}

describe("loadImage", () => {
  it("读取 png 文件 → base64 + mimeType=image/png", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-"));
    try {
      const raw = "PNG-RAW-BYTES";
      const p = await writeTmp(workDir, "pic.png", raw);
      const img = asBase64(loadImage(p, workDir));
      expect(img.type).toBe("image_base64");
      expect(img.mimeType).toBe("image/png");
      // base64 解码后应还原原文
      expect(Buffer.from(img.data, "base64").toString("utf8")).toBe(raw);
    } finally {
      await safeRm(workDir);
    }
  });

  it("不同后缀推断不同 mimeType", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-"));
    try {
      const cases: Array<[string, string]> = [
        ["a.png", "image/png"],
        ["a.jpg", "image/jpeg"],
        ["a.jpeg", "image/jpeg"],
        ["a.gif", "image/gif"],
        ["a.webp", "image/webp"],
        ["a.bin", "image/png"], // 未知后缀回落 png
      ];
      for (const [name, expectedMime] of cases) {
        const p = await writeTmp(workDir, name, "x");
        expect(asBase64(loadImage(p, workDir)).mimeType).toBe(expectedMime);
      }
    } finally {
      await safeRm(workDir);
    }
  });

  it("大写后缀也能识别", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-"));
    try {
      const p = await writeTmp(workDir, "UPPER.PNG", "x");
      expect(asBase64(loadImage(p, workDir)).mimeType).toBe("image/png");
    } finally {
      await safeRm(workDir);
    }
  });

  it("相对 workDir 解析图片路径", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-rel-"));
    try {
      await writeTmp(workDir, "snap.webp", "WEBP");
      const img = asBase64(loadImage("snap.webp", workDir));
      expect(img.mimeType).toBe("image/webp");
      expect(Buffer.from(img.data, "base64").toString("utf8")).toBe("WEBP");
    } finally {
      await safeRm(workDir);
    }
  });

  it("拒绝读取 workDir 外的图片路径", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pico-cli-img-out-"));
    try {
      await writeTmp(outsideDir, "outside.png", "OUT");
      expect(() => loadImage(join(outsideDir, "outside.png"), workDir)).toThrow(/工作区外/);
    } finally {
      await safeRm(workDir);
      await safeRm(outsideDir);
    }
  });
});

describe("runAgentFromCli 带 imagePath", () => {
  it("images → provider 收到的 user 消息含 ImagePart", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-direct-"));
    try {
      const provider = new CapturingProvider();
      const image: ImagePart = { type: "image_base64", mimeType: "image/webp", data: "V0VCUA==" };

      await runAgentFromCli(
        {
          prompt: "看这张图",
          dir: workDir,
          session: "cli-image-direct",
          images: [image],
        },
        { provider },
      );

      expect(provider.calls.length).toBeGreaterThan(0);
      const userMsg = provider.calls[0]!.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toEqual([image]);
    } finally {
      await safeRm(workDir);
    }
  });

  it("imagePath → provider 收到的 user 消息含 images", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-run-"));
    try {
      const provider = new CapturingProvider();
      await writeTmp(workDir, "snap.png", "PIC");

      await runAgentFromCli(
        {
          prompt: "看这张图",
          dir: workDir,
          session: "cli-image-test",
          imagePath: "snap.png",
        },
        { provider },
      );

      // provider.calls[0].messages 是传给 generate 的完整历史,含 session.append 的 user 消息
      expect(provider.calls.length).toBeGreaterThan(0);
      const userMsg = provider.calls[0]!.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toBeDefined();
      expect(userMsg!.images).toHaveLength(1);
      const img0 = asBase64(userMsg!.images![0]!);
      expect(img0.type).toBe("image_base64");
      expect(img0.mimeType).toBe("image/png");
      expect(Buffer.from(img0.data, "base64").toString("utf8")).toBe("PIC");
    } finally {
      await safeRm(workDir);
    }
  });

  it("无 imagePath → 回归:user 消息不含 images", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-img-noreg-"));
    try {
      const provider = new CapturingProvider();
      await runAgentFromCli(
        {
          prompt: "纯文本",
          dir: workDir,
          session: "cli-image-noreg",
        },
        { provider },
      );
      expect(provider.calls.length).toBeGreaterThan(0);
      const userMsg = provider.calls[0]!.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.images).toBeUndefined();
    } finally {
      await safeRm(workDir);
    }
  });
});
