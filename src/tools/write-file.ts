// WriteFileTool:创建或覆盖文件。
// 对应课程第 06 讲,极简工具集原语之一。
//
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。

import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BaseTool, ToolFileSideEffects } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import {
  captureAtomicFilePrecondition,
  writeAtomicWorkspaceFile,
} from "./atomic-workspace-file.js";
import {
  assertSameResolvedTarget,
  exactPathSideEffects,
  workspaceRootsFrom,
} from "./file-helpers.js";

export class WriteFileTool implements BaseTool {
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "write_file";
  }

  fileSideEffects(args: string): ToolFileSideEffects {
    return exactPathSideEffects(args);
  }

  /** 声明写 path 归一化后的绝对路径 —— 不同文件的写可并行 */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.writeFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "write_file",
      description:
        "创建或覆盖写入一个文件。如果目录不存在会自动创建。支持主工作区相对路径或已授权工作区内绝对路径。",
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

    // 先校验但不消耗一次性授权；创建父目录后重新解析真实路径，
    // 防止父目录在 mkdir 期间被替换为越界符号链接。
    const initialPath = await this.roots.assertAllowed(path, { consumeAuthorization: false });
    await mkdir(dirname(initialPath), { recursive: true });
    const fullPath = await this.roots.assertAllowed(path);

    const precondition = await captureAtomicFilePrecondition(fullPath);
    const isNewFile = precondition.kind === "missing";
    if (!isNewFile) await access(fullPath, constants.W_OK);
    await writeAtomicWorkspaceFile({
      targetPath: fullPath,
      content,
      precondition,
      revalidateTarget: () => assertSameResolvedTarget(this.roots, path, fullPath),
    });

    const action = isNewFile ? "新建" : "覆盖";
    const sizeInfo = `(${content.length} 字符)`;
    return `✅ ${action}文件: ${path} ${sizeInfo}`;
  }
}
