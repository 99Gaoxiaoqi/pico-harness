import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStrictRuntimeParams } from "@pico/protocol";

/**
 * session.send text 输入附件的协议参数门（3-D 漏账补齐）。
 *
 * 附件校验双门：协议 parseStrictRuntimeParams（第一道，runtime.request 通用
 * 桥在 composition 边界单源应用）+ daemon normalizeInputAttachments（兜内部
 * 调用方）。本测试锚定第一道的接受/拒绝形状——上限对齐 headless（4 张 /
 * 总 256KB 解码后）。
 */

function attachment(data = "aGl="): { type: "image_base64"; mimeType: string; data: string } {
  return { type: "image_base64", mimeType: "image/png", data };
}

function sendParams(input: unknown): Record<string, unknown> {
  return {
    workspacePath: "C:\\ws",
    input,
    idempotencyKey: "id-1",
  };
}

test("session.send text input 携带合法附件通过参数门", () => {
  const params = parseStrictRuntimeParams(
    "session.send",
    sendParams({ kind: "text", text: "看图", attachments: [attachment(), attachment("Ymw=")] }),
  );
  const input = params.input as Record<string, unknown>;
  assert.equal(input.kind, "text");
  assert.equal(Array.isArray(input.attachments), true);
});

test("无附件时不携带字段仍通过；空数组被拒（无附件应省略）", () => {
  parseStrictRuntimeParams("session.send", sendParams({ kind: "text", text: "纯文本" }));
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({ kind: "text", text: "x", attachments: [] }),
      ),
    /attachments/,
  );
});

test("附件上限与形状拒绝：超 4 张 / 非法 type / 缺 mimeType / 超总大小", () => {
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({
          kind: "text",
          text: "x",
          attachments: [attachment(), attachment(), attachment(), attachment(), attachment()],
        }),
      ),
    /最多 4 张/,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({
          kind: "text",
          text: "x",
          attachments: [{ type: "image_url", url: "https://x" }],
        }),
      ),
    /image_base64|attachments/,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({
          kind: "text",
          text: "x",
          attachments: [{ type: "image_base64", data: "aGk=" }],
        }),
      ),
    /mimeType/,
  );
  // 4 张各 ~100KB base64（> 256KB 解码预算）→ 总量拒绝。
  const chunk = "a".repeat(Math.floor((100 * 1024 * 4) / 3));
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({
          kind: "text",
          text: "x",
          attachments: [attachment(chunk), attachment(chunk), attachment(chunk)],
        }),
      ),
    /256KB/,
  );
});

test("附件仅限 text 输入：skill 输入带 attachments 被拒（exact shape）", () => {
  assert.throws(
    () =>
      parseStrictRuntimeParams(
        "session.send",
        sendParams({
          kind: "skill",
          name: "review",
          attachments: [attachment()],
        }),
      ),
    /不允许字段 attachments/,
  );
});
