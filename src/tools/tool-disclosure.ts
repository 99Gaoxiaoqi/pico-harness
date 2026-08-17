// 工具渐进披露状态机（组级激活 + durable 重播）。
//
// pickForLLM 返回 = always 组 ∪ 已加载 deferred 组成员 ∪ 已披露单工具。
// 组级激活经 load_tools 连接器（枚举选择，零歧义）；
// 单工具披露经 search_tools 兜底（MCP/Plugin 动态工具无预定义组）。
//
// durable：seedFromEvents 从 RuntimeEvent ledger 重播 tool.group.loaded 事件，
// run 切换 / crash recovery 后已加载状态自动恢复，无需重新激活。
//
// 安全网：不影响 registry.execute 路由。即便工具未披露，模型误调时
// registry 仍按全集路由（由 Main Loop 注入全部工具给 registry）。

import type { ToolDefinition } from "../schema/message.js";
import { findGroupForTool } from "./tool-surface.js";

export interface ToolDisclosureItem {
  name: string;
  readOnly: boolean;
}

export function formatToolDisclosureItem(tool: ToolDisclosureItem): string {
  const access = tool.readOnly ? "read-only" : "write";
  const risk = tool.readOnly ? "low" : "write";
  return `- ${tool.name} - ${access} - risk: ${risk}`;
}

/** ledger 重播用的最小事件形状（避免直接依赖 storage 层类型）。 */
export interface ToolGroupLoadedEventLike {
  readonly kind: string;
  readonly data?: { readonly groupId?: unknown; readonly toolNames?: unknown };
}

/**
 * 维护已加载组与已披露工具集合，决定本轮喂给 LLM 哪些工具。
 *
 *   pickForLLM 返回 = always 组 ∪ loaded deferred 组 ∪ disclosed 单工具
 *
 * load_tools 调 discloseGroup() 组级激活；search_tools 调 discloseTools()
 * 单工具兜底。seedFromEvents 从持久化事件恢复，durable by construction。
 * 不影响 registry.execute 路由：即便工具未披露，registry 仍按全集路由（安全网）。
 */
export class ToolDisclosure {
  private readonly loadedGroups = new Set<string>();
  private readonly disclosedTools = new Set<string>();

  /** 组级激活：加载 deferred 组，成员进入 disclosedTools。 */
  discloseGroup(groupId: string, toolNames: readonly string[]): void {
    this.loadedGroups.add(groupId);
    for (const name of toolNames) this.disclosedTools.add(name);
  }

  /** 单工具级披露（search_tools 兜底路径，MCP/Plugin 动态工具）。 */
  discloseTools(names: string[]): void {
    for (const name of names) this.disclosedTools.add(name);
  }

  /** 从 RuntimeEvent ledger 重播恢复（tool.group.loaded 事件）。 */
  seedFromEvents(events: readonly ToolGroupLoadedEventLike[]): void {
    for (const event of events) {
      if (event.kind !== "tool.group.loaded") continue;
      const { groupId, toolNames } = event.data ?? {};
      if (typeof groupId !== "string" || !Array.isArray(toolNames)) continue;
      this.discloseGroup(
        groupId,
        toolNames.filter((n): n is string => typeof n === "string"),
      );
    }
  }

  /** 从全量工具列表中挑出本轮该喂给 LLM 的子集。 */
  pickForLLM(allTools: ToolDefinition[]): ToolDefinition[] {
    return allTools.filter((t) => this.isToolVisible(t.name));
  }

  /** 单工具可见性：always 组 ∪ 已加载 deferred 组成员 ∪ 已披露单工具。 */
  isToolVisible(toolName: string): boolean {
    const group = findGroupForTool(toolName);
    if (group?.economy === "always") return true;
    return this.disclosedTools.has(toolName);
  }

  /** 当前已加载的 deferred 组 id（只读快照，供测试和观测）。 */
  getLoadedGroups(): readonly string[] {
    return [...this.loadedGroups];
  }

  /** 当前已披露的单工具名（只读快照，供测试和观测）。 */
  getDisclosedTools(): readonly string[] {
    return [...this.disclosedTools];
  }

  /** 清空状态（新会话/新任务复位；durable 场景由 seedFromEvents 重建）。 */
  reset(): void {
    this.loadedGroups.clear();
    this.disclosedTools.clear();
  }
}
