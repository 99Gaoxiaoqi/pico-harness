import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readClipboardImageFileReference } from "../src/tui/system-actions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("macOS 剪贴板文件引用", () => {
  it("从带空格的 file URL 读取原始图片字节，而不是 Finder 生成的文件图标", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-clipboard-file-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "旅行 拼图.png");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(imagePath, imageBytes);

    const image = await readClipboardImageFileReference(pathToFileURL(imagePath).href);

    expect(image).toEqual({
      type: "image_base64",
      mimeType: "image/png",
      data: imageBytes.toString("base64"),
    });
  });
});
