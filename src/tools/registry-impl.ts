// Registry 默认实现 + 内置工具。
// 对应课程第 05 讲:registryImpl + read_file 工具。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { BaseTool, Registry } from "./registry.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";

const execAsync = promisify(exec);

/**
 * 路径安全检查:确保路径在 workDir 之内,防路径穿越。
 * 返回规范化的绝对路径;越界则抛错。
 */
function safeResolve(workDir: string, path: string): string {
  const base = resolve(workDir);
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界: '${path}' 不在工作区 ${base} 之内`);
  }
  return fullPath;
}

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

    // 2. 路径穿越防护:确保最终路径在 workDir 之内
    const fullPath = safeResolve(this.workDir, path);

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

// ==========================================
// 内置工具 3:WriteFileTool (第 06 讲)
// 极简工具集原语之一:创建或覆盖文件。
// ==========================================
export class WriteFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "write_file";
  }

  definition(): ToolDefinition {
    return {
      name: "write_file",
      description: "创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件路径,如 src/main.ts" },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let content: string;
    try {
      const input = JSON.parse(args) as { path?: string; content?: string };
      path = input.path ?? "";
      content = input.content ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path 和 content 字段");
    }

    // 安全防线:限制在 WorkDir 下
    const fullPath = safeResolve(this.workDir, path);

    // 自动创建缺失的父级目录
    await mkdir(resolve(fullPath, ".."), { recursive: true });

    // 写入文件,权限 0644
    await writeFile(fullPath, content, "utf8");

    return `成功将内容写入到文件: ${path}`;
  }
}

// ==========================================
// 内置工具 4:BashTool (第 06 讲,YOLO 哲学核心)
// 极简工具集原语之一:执行任意 Shell 命令。
// 4 条驾驭底线:超时控制、工作区绑定、错误原样回传、长度截断。
// ==========================================

/** bash 命令最大执行时间,防止卡死进程 (如 top / 常驻服务) */
const BASH_TIMEOUT_MS = 30_000;
/** bash 输出截断长度,防 OOM */
const BASH_MAX_BYTES = 8000;

export class BashTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "bash";
  }

  definition(): ToolDefinition {
    return {
      name: "bash",
      description:
        "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)、管道和环境变量。返回标准输出与错误的合并结果。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令,例如: ls -la 或 npm test" },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let command: string;
    try {
      const input = JSON.parse(args) as { command?: string };
      command = input.command ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 command 字段");
    }

    // 驾驭底线 1+2:超时控制 + 工作区绑定
    // 注意:命令执行失败时绝不抛异常,而是原样回传(底线 3),交给模型自纠。
    let stdout = "";
    let timedOut = false;
    try {
      const { stdout: out } = await execAsync(command, {
        cwd: this.workDir,
        maxBuffer: 1024 * 1024,
        timeout: BASH_TIMEOUT_MS,
      });
      stdout = out;
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
      // 判断是否超时
      if (e.killed && e.signal === "SIGTERM") {
        timedOut = true;
      }
      // 合并 stdout/stderr,原样回传让模型分析
      const parts = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean);
      stdout = parts.length > 0 ? parts.join("\n") : `执行报错: ${e.message ?? String(err)}`;
    }

    if (timedOut) {
      stdout += `\n[警告: 命令执行超时(${BASH_TIMEOUT_MS / 1000}s),已被系统强制终止。如果是启动常驻服务,请改用后台运行方式。]`;
    }

    // 空输出给明确成功反馈
    if (!stdout.trim()) {
      return "命令执行成功,无终端输出。";
    }

    // 驾驭底线 4:长度截断保护
    if (stdout.length > BASH_MAX_BYTES) {
      return stdout.slice(0, BASH_MAX_BYTES) + `\n\n...[终端输出过长,已截断至前 ${BASH_MAX_BYTES} 字节]...`;
    }

    return stdout;
  }
}
