// Registry 默认实现 + 内置工具。
// 对应课程第 05 讲:registryImpl + read_file 工具。

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BaseTool, Registry } from "./registry.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";

/**
 * registryImpl:Registry 接口的默认实现。
 * 用 map 以工具 name 为 key 做 O(1) 路由查找。
 * 像忠实的前台总机:接线(收 ToolCall)→ 查黄页(map)→ 转接(Execute)。
 */
export class ToolRegistry implements Registry {
  private readonly tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      console.warn(`[Warning] 工具 '${name}' 已被注册,将被覆盖。`);
    }
    this.tools.set(name, tool);
    console.log(`[Registry] 成功挂载工具: ${name}`);
  }

  getAvailableTools(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition());
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    // 1. 路由查找:找不到说明模型幻觉,返回 isError 让模型自纠
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Error: 系统中不存在名为 '${call.name}' 的工具。`,
        isError: true,
      };
    }

    // 2. 执行工具逻辑:把原始 JSON 字符串直接丢给具体工具
    try {
      const output = await tool.execute(call.arguments);
      return { toolCallId: call.id, output, isError: false };
    } catch (err) {
      // 3. 封装:底层物理错误也封成 isError 的 ToolResult
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: call.id,
        output: `Error executing ${call.name}: ${errMsg}`,
        isError: true,
      };
    }
  }
}

// ==========================================
// 内置工具 1:EchoTool (验证用,第 04 讲遗留)
// ==========================================
export class EchoTool implements BaseTool {
  name(): string {
    return "echo";
  }
  definition(): ToolDefinition {
    return {
      name: "echo",
      description: "原样回显输入的文本。用于验证工具调用链路是否打通。",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要回显的文本" } },
        required: ["text"],
      },
    };
  }
  async execute(args: string): Promise<string> {
    let text = "";
    try {
      const input = JSON.parse(args) as { text?: string };
      text = input.text ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 text 字段");
    }
    return `echo: ${text}`;
  }
}

// ==========================================
// 内置工具 2:ReadFileTool (第 05 讲核心)
// 防御底线:WorkDir 边界限制 + 路径穿越防护 + 长度截断保护
// ==========================================

/** 读取文件的最大字节数,防止超大文件撑爆 Context (OOM) */
const READ_FILE_MAX_BYTES = 8000;

export class ReadFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "read_file";
  }

  definition(): ToolDefinition {
    return {
      name: "read_file",
      description: "读取指定路径的文件内容。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径,如 src/cli/main.ts" },
        },
        required: ["path"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let path: string;
    try {
      const input = JSON.parse(args) as { path?: string };
      path = input.path ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path 字段");
    }

    // 2. 路径穿越防护:确保最终路径在 workDir 之内 (比课程更稳)
    const base = resolve(this.workDir);
    const fullPath = isAbsolute(path) ? resolve(path) : resolve(base, path);
    const rel = relative(base, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`路径越界: '${path}' 不在工作区 ${base} 之内`);
    }

    // 3. 物理 IO
    const content = await readFile(fullPath, "utf8");

    // 4. 【核心防线】长度截断保护
    // 绝不把系统安全寄希望于大模型理智,底层工具强制兜底。
    // Token 是金钱,Context 是生命线。
    if (content.length > READ_FILE_MAX_BYTES) {
      return (
        content.slice(0, READ_FILE_MAX_BYTES) +
        `\n\n...[由于内容过长,已被系统截断至前 ${READ_FILE_MAX_BYTES} 字节]`
      );
    }
    return content;
  }
}
