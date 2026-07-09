import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePromptForMessage } from "../../src/input/prepare-prompt.js";

async function safeRm(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

describe("preparePromptForMessage image mentions", () => {
  it("@image:path 附加图片并从 prompt 中移除标记", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-prepare-img-"));
    try {
      await writeFile(join(workDir, "pic.png"), "PNG");

      const result = await preparePromptForMessage("看一下 @image:pic.png", workDir);

      expect(result.prompt).toBe("看一下");
      expect(result.images).toHaveLength(1);
      expect(result.images![0]).toMatchObject({ type: "image_base64", mimeType: "image/png" });
      expect(result.notices).toEqual(["已附加图片: pic.png"]);
    } finally {
      await safeRm(workDir);
    }
  });

  it('@image:"path with spaces" 支持带空格文件名', async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-prepare-img-spaces-"));
    try {
      await writeFile(join(workDir, "screen shot.png"), "PNG");

      const result = await preparePromptForMessage('看一下 @image:"screen shot.png"', workDir);

      expect(result.prompt).toBe("看一下");
      expect(result.images).toHaveLength(1);
      expect(result.notices).toEqual(["已附加图片: screen shot.png"]);
    } finally {
      await safeRm(workDir);
    }
  });

  it("@image: 缺失文件时给出路径错误", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-prepare-img-missing-"));
    try {
      await expect(preparePromptForMessage("看一下 @image:missing.png", workDir)).rejects.toThrow(
        /missing\.png/,
      );
    } finally {
      await safeRm(workDir);
    }
  });
});
