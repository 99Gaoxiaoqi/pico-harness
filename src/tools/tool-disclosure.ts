// Run 绑定能力上限；激活属于独立 Turn；每个 Step 使用不可变快照。
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolDefinition } from "../schema/message.js";
import { findGroupForTool } from "./tool-surface.js";

export const TOOL_SEARCH_DEFAULT_LIMIT = 8;
export const TOOL_SEARCH_MAX_LIMIT = 20;
export const TOOL_SEARCH_MAX_SCHEMA_CHARS = 64 * 1024;
export const TOOL_SEARCH_INVENTORY_MAX_TOOLS = 100;
export const TOOL_SEARCH_INVENTORY_MAX_CHARS = 8 * 1024;

export interface ToolDisclosureItem {
  name: string;
  readOnly: boolean;
}

export function formatToolDisclosureItem(tool: ToolDisclosureItem): string {
  const access = tool.readOnly ? "read-only" : "write";
  const risk = tool.readOnly ? "low" : "write";
  return `- ${tool.name} - ${access} - risk: ${risk}`;
}

export interface ToolActivationResult {
  readonly activated: string[];
  readonly blocked?: {
    readonly name: string;
    readonly reason: "schema_too_large" | "schema_budget_exhausted";
    readonly schemaChars: number;
  };
}

export interface ToolStepSnapshot {
  readonly tools: readonly ToolDefinition[];
  readonly toolNames: readonly string[];
}

export function isDirectTool(name: string): boolean {
  return (
    name === "search_tools" || name === "load_tools" || findGroupForTool(name)?.economy === "always"
  );
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** 目录仅含组与名称；从绑定快照生成，不递归调用 registry definition。 */
function renderBoundInventory(
  tools: readonly ToolDefinition[],
  baseline: ReadonlySet<string>,
): string {
  const candidates = tools
    .filter((tool) => !isDirectTool(tool.name) && !baseline.has(tool.name))
    .filter((tool) => !["submit_plan", "update_plan", "cancel_plan"].includes(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  let chars = 0;
  for (const tool of candidates) {
    if (lines.length >= TOOL_SEARCH_INVENTORY_MAX_TOOLS) break;
    const line = `- ${findGroupForTool(tool.name)?.id ?? "other"}: ${tool.name}`;
    if (chars + line.length + 1 > TOOL_SEARCH_INVENTORY_MAX_CHARS - 128) continue;
    lines.push(line);
    chars += line.length + 1;
  }
  return [
    "当前 Run 可发现工具（组与名称）：",
    ...lines,
    ...(lines.length < candidates.length
      ? [`另有 ${candidates.length - lines.length} 个工具未列出，可继续按能力关键词检索。`]
      : []),
  ].join("\n");
}

/** Turn 持有自己的激活集合；既不共享可变状态，也不继承前一 Turn 的激活。 */
export class ToolDisclosureTurn {
  private readonly boundTools: readonly ToolDefinition[];
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;
  private readonly baseline: ReadonlySet<string>;
  private readonly disclosedTools = new Set<string>();
  private readonly loadedGroups = new Set<string>();
  private ended = false;

  constructor(boundTools: readonly ToolDefinition[], baseline: readonly string[] = []) {
    const cloned = structuredClone([...boundTools]);
    const baselineNames = new Set(baseline);
    const connector = cloned.find((tool) => tool.name === "search_tools");
    if (connector) connector.description += "\n\n" + renderBoundInventory(cloned, baselineNames);
    this.boundTools = freezeDeep(cloned);
    this.toolsByName = new Map(this.boundTools.map((tool) => [tool.name, tool]));
    this.baseline = new Set(baseline.filter((name) => this.toolsByName.has(name)));
    if (this.toolsByName.size !== this.boundTools.length) {
      throw new Error("Turn 绑定工具名称不得重复");
    }
  }

  getBoundTools(): readonly ToolDefinition[] {
    this.assertActive();
    return this.boundTools;
  }

  /** 一次发现有数量和 schema 预算上限，已经激活的工具不再占用本次预算。 */
  discloseTools(names: readonly string[], limit = TOOL_SEARCH_DEFAULT_LIMIT): ToolActivationResult {
    this.assertActive();
    if (!Number.isInteger(limit) || limit < 1 || limit > TOOL_SEARCH_MAX_LIMIT) {
      throw new Error(`limit 必须是 1 到 ${TOOL_SEARCH_MAX_LIMIT} 之间的整数`);
    }
    const activated: string[] = [];
    let blocked: ToolActivationResult["blocked"];
    let schemaChars = 0;
    for (const name of new Set(names)) {
      if (activated.length >= limit) break;
      const tool = this.toolsByName.get(name);
      if (!tool || this.isToolVisible(name)) continue;
      const chars = JSON.stringify(tool).length;
      if (chars > TOOL_SEARCH_MAX_SCHEMA_CHARS) {
        blocked ??= { name, reason: "schema_too_large", schemaChars: chars };
        continue;
      }
      if (schemaChars + chars > TOOL_SEARCH_MAX_SCHEMA_CHARS) {
        blocked = { name, reason: "schema_budget_exhausted", schemaChars: chars };
        break;
      }
      this.disclosedTools.add(name);
      activated.push(name);
      schemaChars += chars;
    }
    return { activated, ...(blocked ? { blocked } : {}) };
  }

  discloseGroup(groupId: string, toolNames: readonly string[]): ToolActivationResult {
    const result = this.discloseTools(toolNames, TOOL_SEARCH_MAX_LIMIT);
    if (toolNames.some((name) => this.disclosedTools.has(name))) this.loadedGroups.add(groupId);
    return result;
  }

  /** 激活只影响后续快照；已有快照的定义、名字与参数 schema 均不可变。 */
  snapshotForStep(requiredNames: readonly string[] = []): ToolStepSnapshot {
    this.assertActive();
    const required = new Set(requiredNames);
    const tools = this.boundTools
      .filter((tool) => this.isToolVisible(tool.name) || required.has(tool.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Object.freeze({
      tools: Object.freeze(tools),
      toolNames: Object.freeze(tools.map((tool) => tool.name)),
    });
  }

  isToolVisible(name: string): boolean {
    this.assertActive();
    return (
      this.toolsByName.has(name) &&
      (isDirectTool(name) || this.baseline.has(name) || this.disclosedTools.has(name))
    );
  }

  getLoadedGroups(): readonly string[] {
    return [...this.loadedGroups];
  }
  getDisclosedTools(): readonly string[] {
    return [...this.disclosedTools];
  }

  endTurn(): void {
    this.ended = true;
    this.disclosedTools.clear();
    this.loadedGroups.clear();
  }

  private assertActive(): void {
    if (this.ended) throw new Error("工具发现 Turn 已结束");
  }
}

/**
 * 注册工具可长期持有此 façade。执行通过 runInTurn 绑定 owner，避免并发 Turn
 * 误写彼此的激活集合。异步 generator 的每次 next/return 也必须在此作用域内。
 */
export class ToolDisclosure {
  private readonly scope = new AsyncLocalStorage<ToolDisclosureTurn>();
  private baseline: readonly string[] = [];

  /** 宿主装配时设置基础能力；不是模型可调用的激活入口，只影响后续 Turn。 */
  setBaselineTools(names: readonly string[]): void {
    this.baseline = [...new Set(names)];
  }

  beginTurn(boundTools: readonly ToolDefinition[]): ToolDisclosureTurn {
    return new ToolDisclosureTurn(boundTools, this.baseline);
  }

  runInTurn<T>(turn: ToolDisclosureTurn, callback: () => T): T {
    turn.getBoundTools();
    return this.scope.run(turn, callback);
  }

  endTurn(turn: ToolDisclosureTurn): void {
    turn.endTurn();
  }

  currentTurn(): ToolDisclosureTurn {
    const turn = this.scope.getStore();
    if (!turn) throw new Error("工具发现需要当前 Turn 作用域");
    return turn;
  }

  discloseGroup(groupId: string, toolNames: readonly string[]): ToolActivationResult {
    return this.currentTurn().discloseGroup(groupId, toolNames);
  }

  discloseTools(names: readonly string[], limit?: number): ToolActivationResult {
    return this.currentTurn().discloseTools(names, limit);
  }

  pickForLLM(allTools: readonly ToolDefinition[]): ToolDefinition[] {
    const turn = this.scope.getStore();
    return turn
      ? [...turn.snapshotForStep().tools]
      : allTools.filter((tool) => isDirectTool(tool.name) || this.baseline.includes(tool.name));
  }

  isToolVisible(toolName: string): boolean {
    return (
      this.scope.getStore()?.isToolVisible(toolName) ??
      (isDirectTool(toolName) || this.baseline.includes(toolName))
    );
  }

  getLoadedGroups(): readonly string[] {
    return this.scope.getStore()?.getLoadedGroups() ?? [];
  }
  getDisclosedTools(): readonly string[] {
    return this.scope.getStore()?.getDisclosedTools() ?? [];
  }
}
