// ReadFileTool:按行读取指定路径的文件内容,保留原始行号。
// 对应课程第 05 讲核心工具。
//
// 防御底线:WorkDir 边界限制 + 路径穿越防护 + 行分页保护。
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。

import { constants, open } from "node:fs/promises";
import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { toModelTextView, makeCarriageReturnsVisible } from "./line-endings.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import {
  NO_FOLLOW_FLAG,
  NON_BLOCKING_FLAG,
  READ_FILE_MAX_BYTES,
  workspaceRootsFrom,
} from "./file-helpers.js";

const READ_FILE_DEFAULT_LIMIT_LINES = 500;
const READ_FILE_MAX_LIMIT_LINES = 1000;
const READ_FILE_MAX_PAGE_CHARS = 30_000;
const READ_FILE_MAX_RENDERED_LINE_CHARS = 2000;

/** 行尾风格 → 展示标签(供状态行输出,帮模型识别文件格式) */
function lineEndingStyleLabel(style: "lf" | "crlf" | "mixed"): string {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "MIXED";
  return "LF";
}

export class ReadFileTool implements BaseTool {
  readonly readOnly = true;
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "read_file";
  }

  /** 声明读 path 归一化后的绝对路径(与 execute 的 safeResolve 一致) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "read_file",
      description:
        "按行读取指定路径的文件内容，保留原始行号。相对路径基于主工作区，绝对路径须位于已授权工作区。大文件请按 PARTIAL 提示继续分页。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径,如 src/cli/main.ts" },
          offset: {
            type: "integer",
            minimum: 1,
            description: "可选，起始行号（1-based），默认从第 1 行开始。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: READ_FILE_MAX_LIMIT_LINES,
            description: `可选，最多读取的行数，默认 ${READ_FILE_DEFAULT_LIMIT_LINES}，最大 ${READ_FILE_MAX_LIMIT_LINES}。`,
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let path: string;
    let offset: number;
    let limit: number;
    let paginationRequested: boolean;
    try {
      const input = JSON.parse(args) as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof input.path !== "string" || input.path.length === 0) {
        throw new Error("path 必须是非空字符串");
      }
      path = input.path;
      paginationRequested = input.offset !== undefined || input.limit !== undefined;
      offset = parsePositiveInteger(input.offset, "offset", 1);
      limit = parsePositiveInteger(input.limit, "limit", READ_FILE_DEFAULT_LIMIT_LINES);
      if (limit > READ_FILE_MAX_LIMIT_LINES) {
        throw new Error(`limit 不能超过 ${READ_FILE_MAX_LIMIT_LINES}`);
      }
    } catch (err) {
      const reason =
        err instanceof SyntaxError
          ? "期望 JSON 含 path 字段"
          : err instanceof Error
            ? err.message
            : "期望 JSON 含 path 字段";
      throw new Error(`参数解析失败: ${reason}`, { cause: err });
    }

    // 2. 所有文件访问统一经过共享工作区边界。
    const fullPath = await this.roots.assertAllowed(path);

    // 3. 通过 O_NONBLOCK + max+1 的同一 FD 有界读取：FIFO 不会卡住进程，
    //    普通文件即使在 stat 后并发增长也无法越过分配上限。
    const raw = await readBoundedRegularUtf8(fullPath, path, READ_FILE_MAX_BYTES);

    // 4. 模型视图归一化:纯 CRLF → LF(模型只处理一种行尾,Edit 匹配才稳定);
    //    lf/mixed 原样返回,并记录原始行尾风格供 Edit 写回还原。
    const { text, lineEndingStyle } = toModelTextView(raw);

    // 5. 空文件:只返回状态行,不输出空行号
    if (text.length === 0) {
      if (offset !== 1) {
        throw new Error(`offset ${offset} 超出文件总行数 0`);
      }
      return `共 0 行,行尾: ${lineEndingStyleLabel(lineEndingStyle)}`;
    }

    // 6. 按行分割(行号从 1 开始)。
    //    末尾换行不产生空行号:先剥掉尾部 \n 再 split。
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (offset > lines.length) {
      throw new Error(`offset ${offset} 超出文件总行数 ${lines.length}`);
    }

    // 7. 行数分页 + 页字符上限双重保护。不在字符中间切断整页，
    //    因此下一页始终能用稳定的原始行号继续。
    const startIndex = offset - 1;
    const requestedEndIndex = Math.min(lines.length, startIndex + limit);
    const renderedLines: string[] = [];
    let clippedLineCount = 0;

    for (let index = startIndex; index < requestedEndIndex; index++) {
      const rendered = renderReadLine(lines[index] ?? "", index + 1, lineEndingStyle);
      if (rendered.clipped) clippedLineCount++;
      renderedLines.push(rendered.text);

      const candidate = formatReadPage({
        renderedLines,
        path,
        offset,
        limit,
        totalLines: lines.length,
        lineEndingStyle,
        paginationRequested,
        clippedLineCount,
      });
      if (candidate.length > READ_FILE_MAX_PAGE_CHARS) {
        renderedLines.pop();
        if (rendered.clipped) clippedLineCount--;
        break;
      }
    }

    // 单行已有 2,000 chars 上限，因此正常情况不会为空；保底保留一行。
    if (renderedLines.length === 0) {
      const rendered = renderReadLine(lines[startIndex] ?? "", offset, lineEndingStyle);
      renderedLines.push(rendered.text);
      clippedLineCount = rendered.clipped ? 1 : 0;
    }

    return formatReadPage({
      renderedLines,
      path,
      offset,
      limit,
      totalLines: lines.length,
      lineEndingStyle,
      paginationRequested,
      clippedLineCount,
    });
  }
}

async function readBoundedRegularUtf8(
  fullPath: string,
  displayPath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(fullPath, constants.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`路径不是普通文件: ${displayPath}`);
    if (info.size > maxBytes) {
      throw new Error(
        `文件大小 ${info.size} 字节，超过 read_file 上限 ${maxBytes} 字节；请用 grep 先缩小范围。`,
      );
    }

    const maximumCapacity = maxBytes + 1;
    let buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (true) {
      if (offset === buffer.length) {
        if (buffer.length === maximumCapacity) {
          throw new Error(
            `文件读取超过 read_file 上限 ${maxBytes} 字节；内容可能在读取期间增长，请用 grep 先缩小范围。`,
          );
        }
        const nextCapacity = Math.min(
          maximumCapacity,
          Math.max(buffer.length + 1, buffer.length * 2),
        );
        const grown = Buffer.allocUnsafe(nextCapacity);
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }

      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxBytes) {
        throw new Error(
          `文件读取超过 read_file 上限 ${maxBytes} 字节；内容可能在读取期间增长，请用 grep 先缩小范围。`,
        );
      }
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parsePositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于等于 1 的整数`);
  }
  return value;
}

function renderReadLine(
  line: string,
  lineNumber: number,
  lineEndingStyle: "lf" | "crlf" | "mixed",
): { text: string; clipped: boolean } {
  const content = lineEndingStyle === "mixed" ? makeCarriageReturnsVisible(line) : line;
  const prefix = `${lineNumber}\t`;
  const full = `${prefix}${content}`;
  if (full.length <= READ_FILE_MAX_RENDERED_LINE_CHARS) {
    return { text: full, clipped: false };
  }

  const marker = `...[单行超过 ${READ_FILE_MAX_RENDERED_LINE_CHARS} chars,已截断]`;
  const keepChars = Math.max(0, READ_FILE_MAX_RENDERED_LINE_CHARS - prefix.length - marker.length);
  return {
    text: `${prefix}${content.slice(0, keepChars)}${marker}`,
    clipped: true,
  };
}

function formatReadPage(input: {
  renderedLines: readonly string[];
  path: string;
  offset: number;
  limit: number;
  totalLines: number;
  lineEndingStyle: "lf" | "crlf" | "mixed";
  paginationRequested: boolean;
  clippedLineCount: number;
}): string {
  const endLine = input.offset + input.renderedLines.length - 1;
  const hasMoreLines = endLine < input.totalLines;
  const isDefaultCompleteRead = !input.paginationRequested && input.offset === 1 && !hasMoreLines;
  const status = isDefaultCompleteRead
    ? `共 ${input.totalLines} 行,行尾: ${lineEndingStyleLabel(input.lineEndingStyle)}`
    : `共 ${input.totalLines} 行,当前显示 ${input.offset}-${endLine} 行,行尾: ${lineEndingStyleLabel(input.lineEndingStyle)}`;
  const parts = [input.renderedLines.join("\n"), status];

  if (input.clippedLineCount > 0) {
    parts.push(
      `[提示: ${input.clippedLineCount} 个超长行已各自截断至 ${READ_FILE_MAX_RENDERED_LINE_CHARS} chars，请用更精确的 bash 命令定位所需片段。]`,
    );
  }
  if (hasMoreLines) {
    parts.push(
      `PARTIAL: 文件内容未全部显示。继续读取: read_file ${JSON.stringify({
        path: input.path,
        offset: endLine + 1,
        limit: input.limit,
      })}`,
    );
  }

  return parts.join("\n");
}
