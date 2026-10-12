import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, GifEncoder, loadImage } from "@napi-rs/canvas";
import {
  MODEL_IMAGE_MAX_EDGE,
  prepareImageForModel,
} from "../../../packages/pico-host/src/provider/prepare-image.js";

test("模型请求缩放大图，保持比例、格式、透明度和原始数据", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const source = createCanvas(4096, 1024);
    const context = source.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 2048, 1024);
    const bytes = format === "png" ? await source.encode(format) : await source.encode(format, 90);
    const original = bytes.toString("base64");
    const result = await prepareImageForModel(original, `image/${format}`);
    assert.equal(result.mimeType, `image/${format}`);
    assert.equal(result.sizeBytes, Buffer.byteLength(result.data, "base64"));
    assert.equal(original, bytes.toString("base64"), "原始 base64 和字节不能被修改");
    assert.notEqual(result.data, original);
    const image = await loadImage(Buffer.from(result.data, "base64"));
    assert.equal(image.width, MODEL_IMAGE_MAX_EDGE);
    assert.equal(image.height, 512);
    const output = createCanvas(image.width, image.height);
    const outputContext = output.getContext("2d");
    outputContext.drawImage(image, 0, 0);
    assert.ok(outputContext.getImageData(32, 32, 1, 1).data[0]! > 240);
    if (format !== "jpeg")
      assert.equal(outputContext.getImageData(1800, 32, 1, 1).data[3], 0, "透明像素不能变黑底");
  }

  const source = createCanvas(4096, 1024);
  const context = source.getContext("2d");
  context.fillStyle = "red";
  context.fillRect(0, 0, 2048, 1024);
  context.fillStyle = "blue";
  context.fillRect(2048, 0, 2048, 1024);
  const jpeg = await source.encode("jpeg", 95);
  // APP1 TIFF orientation 6: rotate clockwise once, yielding a portrait image.
  const exif = Buffer.from(
    "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
    "hex",
  );
  const oriented = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
  const result = await prepareImageForModel(oriented.toString("base64"), "image/jpeg");
  const image = await loadImage(Buffer.from(result.data, "base64"));
  assert.deepEqual([image.width, image.height], [512, 2048]);
  const output = createCanvas(image.width, image.height);
  const outputContext = output.getContext("2d");
  outputContext.drawImage(image, 0, 0);
  assert.ok(outputContext.getImageData(32, 32, 1, 1).data[0]! > 240);
  assert.ok(outputContext.getImageData(32, 1800, 1, 1).data[2]! > 240);
});

test("小图和动画保留完整原字节，边界尺寸和 PNG 尾部填充无需重编码", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const canvas = createCanvas(2048, 1);
    const bytes = format === "png" ? await canvas.encode(format) : await canvas.encode(format, 90);
    const data = bytes.toString("base64");
    assert.deepEqual(await prepareImageForModel(data, `image/${format}`), {
      data,
      mimeType: `image/${format}`,
      sizeBytes: bytes.byteLength,
    });
  }
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=",
    "base64",
  );
  const padded = Buffer.alloc(2 * 1024 * 1024 + 1);
  png.copy(padded);
  assert.equal(
    (await prepareImageForModel(padded.toString("base64"), "image/png")).data,
    padded.toString("base64"),
  );
  const gif = new GifEncoder(1, 1);
  gif.addFrame(new Uint8Array([255, 0, 0, 255]), 1, 1);
  gif.addFrame(new Uint8Array([0, 0, 255, 255]), 1, 1);
  const animated = gif.finish().toString("base64");
  assert.equal((await prepareImageForModel(animated, "image/gif")).data, animated);
});

test("坏图、超限像素、伪造格式和需要缩放的 GIF 明确失败", async () => {
  const canvas = createCanvas(1, 1);
  const png = await canvas.encode("png");
  await assert.rejects(prepareImageForModel("not base64", "image/png"), /Base64/u);
  await assert.rejects(prepareImageForModel(png.toString("base64"), "image/jpeg"), /MIME/u);
  await assert.rejects(
    prepareImageForModel(png.subarray(0, 33).toString("base64"), "image/png"),
    /损坏/u,
  );
  const corrupted = Buffer.from(png);
  corrupted[25] = 7; // Invalid PNG color type reaches, and is rejected by, the native decoder.
  await assert.rejects(
    prepareImageForModel(corrupted.toString("base64"), "image/png"),
    /图片准备失败/u,
  );
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(20_000, 16);
  await assert.rejects(
    prepareImageForModel(oversized.toString("base64"), "image/png"),
    /解码安全上限/u,
  );
  const tooManyPixels = Buffer.from(png);
  tooManyPixels.writeUInt32BE(6000, 16);
  tooManyPixels.writeUInt32BE(6000, 20);
  await assert.rejects(
    prepareImageForModel(tooManyPixels.toString("base64"), "image/png"),
    /解码安全上限/u,
  );
  const badJpeg = Buffer.from("ffd8ffe00010", "hex");
  await assert.rejects(prepareImageForModel(badJpeg.toString("base64"), "image/jpeg"), /损坏/u);
  const gif = new GifEncoder(2049, 1);
  gif.addFrame(new Uint8Array(2049 * 4), 2049, 1);
  await assert.rejects(
    prepareImageForModel(gif.finish().toString("base64"), "image/gif"),
    /保留动画/u,
  );
});
