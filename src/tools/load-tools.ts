// LoadToolsTool：组级激活连接器（economy 模式）。
//
// 保留已有组级入口；默认发现入口是 search_tools。只激活 Run 已绑定成员，
// 同样受数量/schema 预算约束，激活仅在本 Turn 的下一个 Step 起生效。
//
// 纯只读、不触碰任何资源：只更新内存 disclosed 集合 + 可选事件写入。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import type { ToolDisclosure } from "./tool-disclosure.js";
import type { ToolGroupDef } from "./tool-surface.js";

export interface LoadToolsOptions {
  /** 组加载成功后写入审计事件；恢复时不继承工具激活。 */
  onGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void;
}

/** 可选实时注册校验，只能进一步缩小 Run 绑定集。 */
export type RegisteredToolNamesSource = () => readonly string[];

/** 渲染组目录为 load_tools 的 description（模型通过阅读它选择 group id）。 */
export function renderGroupCatalog(groups: readonly ToolGroupDef[]): string {
  const lines = groups.map((g) => `- ${g.id}: ${g.description}`);
  return [
    "按需加载工具组。这些能力存在但完整 schema 被隐藏以保持每轮精简。",
    "兼容入口：传入 group id；在同一发现预算内激活成员，下一个 Step 可调用。也可用 search_tools 按能力检索。",
    "",
    "可用组：",
    ...lines,
  ].join("\n");
}

/**
 * 元工具：模型用它按组激活 deferred 工具。
 *
 * 构造时注入当前宿主可用的 deferred 组列表（宿主亲和性已在列表阶段过滤），
 * 以及 registry 实时注册名数据源。execute 时以注册集为准过滤组成员——
 * 目录是静态声明，注册是运行现实（graph/memory 等组有条件注册），
 * 两者脱节时宁可报"组当前不可用"，不做"已加载"的假承诺。
 */
export class LoadToolsTool implements BaseTool {
  /** 纯只读：只更新内存集合与可选事件写入，不触碰文件/网络资源。 */
  readonly readOnly = true;

  constructor(
    private readonly groups: readonly ToolGroupDef[],
    private readonly disclosure: ToolDisclosure,
    private readonly registeredToolNames?: RegisteredToolNamesSource,
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
      group = (input.group ?? "").trim();
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 group 字段");
    }
    if (typeof group !== "string" || group === "") {
      throw new Error("参数解析失败:group 必须是非空字符串");
    }

    const found = this.groups.find((g) => g.id === group);
    if (!found) {
      const available = this.groups.map((g) => g.id).join(", ");
      throw new Error(`未知工具组 "${group}"。可用组: ${available}`);
    }

    // 以 registry 实时注册集为准：条件注册未触发（graph 未启用、memory eco
    // 模式等）的成员不披露，避免"已加载"的假承诺被模型下一轮撞 unknown tool。
    const turn = this.disclosure.currentTurn();
    const bound = new Set(turn.getBoundTools().map((tool) => tool.name));
    const registered = this.registeredToolNames ? new Set(this.registeredToolNames()) : undefined;
    const loadable = registered
      ? found.toolNames.filter((name) => bound.has(name) && registered.has(name))
      : found.toolNames.filter((name) => bound.has(name));
    if (loadable.length === 0) {
      throw new Error(
        `工具组 "${group}" 在当前环境不可用（其工具均未注册）。可尝试其他组: ${this.groups
          .map((g) => g.id)
          .join(", ")}`,
      );
    }

    const result = this.disclosure.discloseGroup(found.id, loadable);
    if (result.activated.length > 0) this.options.onGroupLoaded?.(found.id, result.activated);
    return JSON.stringify(result);
  }
}
