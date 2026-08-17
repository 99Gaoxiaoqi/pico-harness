// LoadToolsTool：组级激活连接器（economy 模式）。
//
// 对齐 maka-agent 的 load_tools 设计：模型通过枚举选择加载整组工具，
// description 内嵌当前宿主可用的组目录，零歧义、无需关键词猜测。
// 组是"最小可用能力单元"——组内工具互相依赖，整组加载避免逐个激活的
// round-trip 浪费。
//
// 纯只读、不触碰任何资源：只更新内存 disclosed 集合 + 可选事件写入。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import type { ToolDisclosure } from "./tool-disclosure.js";
import type { ToolGroupDef } from "./tool-surface.js";

export interface LoadToolsOptions {
  /** 组加载成功后写入 durable 事件（ledger 持久化，crash 后可重播）。 */
  onGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void;
}

/** 渲染组目录为 load_tools 的 description（模型通过阅读它选择 group id）。 */
export function renderGroupCatalog(groups: readonly ToolGroupDef[]): string {
  const lines = groups.map((g) => `- ${g.id}: ${g.description}`);
  return [
    "按需加载工具组。这些能力存在但完整 schema 被隐藏以保持每轮精简。",
    "调用 load_tools 传入 group id；返回的工具下一轮即可直接调用。",
    "",
    "可用组：",
    ...lines,
  ].join("\n");
}

/**
 * 元工具：模型用它按组激活 deferred 工具。
 *
 * 构造时注入当前宿主可用的 deferred 组列表（宿主亲和性已在列表阶段过滤）。
 * execute 时校验 group id，命中即 discloseGroup，下一轮生效。
 */
export class LoadToolsTool implements BaseTool {
  /** 纯只读：只更新内存集合与可选事件写入，不触碰文件/网络资源。 */
  readonly readOnly = true;

  constructor(
    private readonly groups: readonly ToolGroupDef[],
    private readonly disclosure: ToolDisclosure,
    private readonly options: LoadToolsOptions = {},
  ) {}

  name(): string {
    return "load_tools";
  }

  definition(): ToolDefinition {
    return {
      name: "load_tools",
      description: renderGroupCatalog(this.groups),
      inputSchema: {
        type: "object",
        properties: {
          group: {
            type: "string",
            enum: this.groups.map((g) => g.id),
            description: "要加载的工具组 id（见可用组列表）",
          },
        },
        required: ["group"],
      },
    };
  }

  /** 纯只读、不触碰资源：与一切工具都不冲突。 */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.none();
  }

  async execute(args: string): Promise<string> {
    let group: string;
    try {
      const input = JSON.parse(args) as { group?: string };
      group = input.group ?? "";
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 group 字段");
    }
    if (typeof group !== "string" || group.trim() === "") {
      throw new Error("参数解析失败:group 必须是非空字符串");
    }

    const found = this.groups.find((g) => g.id === group);
    if (!found) {
      const available = this.groups.map((g) => g.id).join(", ");
      throw new Error(`未知工具组 "${group}"。可用组: ${available}`);
    }

    this.disclosure.discloseGroup(found.id, found.toolNames);
    this.options.onGroupLoaded?.(found.id, found.toolNames);
    return `已加载 ${found.label} 组 ${found.toolNames.length} 个工具，下一轮可直接调用:\n${found.toolNames
      .map((n) => `- ${n}`)
      .join("\n")}`;
  }
}
