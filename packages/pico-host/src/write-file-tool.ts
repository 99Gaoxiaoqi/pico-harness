// WriteFileTool:创建或覆盖文件。
// 对应课程第 06 讲,极简工具集原语之一。
//
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。

import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BaseTool, ToolFileSideEffects } from "./tool-registry-contract.js";
import type { ToolDefinition } from "@pico/core";
import { ToolAccesses } from "@pico/runtime/tool-access";
import type { WorkspaceRoots } from "./workspace-roots.js";
import {
  publishWrittenArtifact,
  type BoundSessionArtifactAuthority,
} from "./session-artifact-writer.js";
import {
  captureAtomicFilePrecondition,
  writeAtomicWorkspaceFile,
} from "./atomic-workspace-file.js";
import {
  assertSameResolvedTarget,
  exactPathSideEffects,
  workspaceRootsFrom,
} from "./file-tool-helpers.js";

export class WriteFileTool implements BaseTool {
  readonly nesting = "nestable" as const;
  readonly permissionCategory = "file_write" as const;
  private readonly roots: WorkspaceRoots;

  constructor(
    workDirOrRoots: string | WorkspaceRoots,
    private readonly artifacts?: BoundSessionArtifactAuthority,
  ) {
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
        "创建或覆盖写入一个文件。如果目录不存在会自动创建。支持主工作区相对路径或已授权工作区内绝对路径。" +
        (this.artifacts
          ? "生成供用户查看、下载的报告、文档等交付文件时必须设 artifact:true，成功后会出现在会话的生成文件面板。普通源代码修改不要设置 artifact。"
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件路径,如 src/main.ts" },
          content: { type: "string", description: "要写入的完整文件内容" },
          ...(this.artifacts
            ? {
                artifact: {
                  type: "boolean",
                  description:
                    "将此交付文件的内容快照登记到当前会话生成文件面板；普通源码修改不设置。",
                },
              }
            : {}),
        },
        required: ["path", "content"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let content: string;
    let artifact: boolean;
    try {
      const input = JSON.parse(args) as { path?: string; content?: string; artifact?: boolean };
      path = input.path ?? "";
      content = input.content ?? "";
      artifact = input.artifact === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path 和 content 字段");
    }
    if (artifact && !this.artifacts) throw new Error("当前宿主未提供会话生成文件登记能力");

    // 先校验但不消耗一次性授权；创建父目录后重新解析真实路径，
    // 防止父目录在 mkdir 期间被替换为越界符号链接。
    const initialPath = await this.roots.assertAllowed(path, {
      consumeAuthorization: false,
      access: "write",
    });
    await mkdir(dirname(initialPath), { recursive: true });
    const fullPath = await this.roots.assertAllowed(path, { access: "write" });

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
    let artifactInfo = "";
    if (artifact && this.artifacts) {
      try {
        artifactInfo = `\n已登记生成文件: ${publishWrittenArtifact(this.artifacts, path, content)}`;
      } catch (cause) {
        throw new Error(
          `文件已写入 ${path}，但生成文件登记失败: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }
    return `✅ ${action}文件: ${path} ${sizeInfo}${artifactInfo}`;
  }
}
