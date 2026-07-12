import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React from "react";
import { render, type Instance } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBox, type InputBoxSubmission } from "../../src/tui/input-box.js";
import { extractDroppedImagePaths } from "../../src/tui/image-attachments.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("TUI image file drag", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("turns bracketed and batched terminal paths into chips without clearing the prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pico image drag "));
    temporaryDirectories.push(directory);
    const escapedImage = join(directory, "Generated image 1.png");
    const quotedImage = join(directory, "second image.png");
    writeFileSync(escapedImage, PNG_1X1);
    writeFileSync(quotedImage, PNG_1X1);

    const submissions: InputBoxSubmission[] = [];
    const harness = createInteractiveInput(
      <InputBox onSubmit={(submission) => submissions.push(submission)} />,
    );

    try {
      await harness.write("请分析这两张图");
      const finderPath = escapedImage.replaceAll(" ", "\\ ");
      const bracketedPaste = `\u001b[200~${finderPath} "${quotedImage}" \u001b[201~`;
      const withChips = await harness.write(bracketedPaste);

      expect(withChips).toContain("[Image #1: Generated image 1.png]");
      expect(withChips).toContain("[Image #2: second image.png]");

      await harness.write("\r");
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.text).toBe("请分析这两张图");
      expect(submissions[0]?.attachments.map((attachment) => attachment.name)).toEqual([
        "Generated image 1.png",
        "second image.png",
      ]);

      await harness.write("再看这张 ");
      await harness.write(`"${escapedImage}" `);
      await harness.write("\r");
      expect(submissions).toHaveLength(2);
      expect(submissions[1]?.text).toBe("再看这张");
      expect(submissions[1]?.attachments[0]?.name).toBe("Generated image 1.png");

      expect(extractDroppedImagePaths('"C:\\Users\\pico\\Generated image.png" ')).toEqual({
        paths: ["C:\\Users\\pico\\Generated image.png"],
        remainingText: "",
      });
    } finally {
      await harness.cleanup();
    }
  });
});

function createInteractiveInput(node: React.ReactNode): {
  write: (input: string) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, {
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 100, writable: true },
    rows: { value: 24, writable: true },
  });

  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
