import type { JsonObject, RuntimeBrowserAgentAction } from "@pico/protocol";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "./registry.js";

export interface BoundBrowserAgentAuthority {
  readonly sessionId: string;
  execute(action: RuntimeBrowserAgentAction, input?: JsonObject): Promise<JsonObject>;
}

abstract class BrowserAgentTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly toolset = "browser";
  readonly readOnly: boolean = false;

  constructor(protected readonly authority: BoundBrowserAgentAuthority) {}
  abstract name(): string;
  abstract definition(): ToolDefinition;
  protected abstract readonly action: RuntimeBrowserAgentAction;
  protected input(_value: Record<string, unknown>): JsonObject {
    return {};
  }

  accesses() {
    return ToolAccesses.all();
  }

  async execute(args: string): Promise<string> {
    const value = parseObject(args);
    return JSON.stringify(await this.authority.execute(this.action, this.input(value)));
  }
}

class BrowserNavigateTool extends BrowserAgentTool {
  protected readonly action = "navigate" as const;
  name(): string {
    return "browser_navigate";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在当前 Session 可见的 Workbar 浏览器中打开 HTTP/HTTPS 地址。浏览器面板不可见时操作会失败。",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "HTTP/HTTPS URL 或域名" } },
        required: ["url"],
      },
    };
  }
  protected override input(value: Record<string, unknown>): JsonObject {
    return { url: boundedString(value["url"], "url", 8_192) };
  }
}

class BrowserBackTool extends BrowserAgentTool {
  protected readonly action = "back" as const;
  name(): string {
    return "browser_back";
  }
  definition(): ToolDefinition {
    return { name: this.name(), description: "让当前可见浏览器后退。", inputSchema: emptySchema };
  }
}

class BrowserForwardTool extends BrowserAgentTool {
  protected readonly action = "forward" as const;
  name(): string {
    return "browser_forward";
  }
  definition(): ToolDefinition {
    return { name: this.name(), description: "让当前可见浏览器前进。", inputSchema: emptySchema };
  }
}

class BrowserReloadTool extends BrowserAgentTool {
  protected readonly action = "reload" as const;
  name(): string {
    return "browser_reload";
  }
  definition(): ToolDefinition {
    return { name: this.name(), description: "重新加载当前可见网页。", inputSchema: emptySchema };
  }
}

class BrowserGetStateTool extends BrowserAgentTool {
  protected readonly action = "get_state" as const;
  override readonly readOnly = true;
  name(): string {
    return "browser_get_state";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "读取当前可见浏览器的 URL、标题、加载和导航状态。",
      inputSchema: emptySchema,
    };
  }
  override accesses() {
    return ToolAccesses.none();
  }
}

class BrowserClickTool extends BrowserAgentTool {
  protected readonly action = "click" as const;
  name(): string {
    return "browser_click";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在当前可见网页中点击一个 CSS selector 匹配的可见元素。固定操作，不执行任意脚本。",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    };
  }
  protected override input(value: Record<string, unknown>): JsonObject {
    return { selector: boundedString(value["selector"], "selector", 2_048) };
  }
}

class BrowserTypeTool extends BrowserAgentTool {
  protected readonly action = "type" as const;
  name(): string {
    return "browser_type";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "向当前可见网页中 CSS selector 匹配的表单控件输入文本。固定操作，不执行任意脚本。",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
          clear: { type: "boolean", description: "输入前清空原值，默认 true" },
        },
        required: ["selector", "text"],
      },
    };
  }
  protected override input(value: Record<string, unknown>): JsonObject {
    const clear = value["clear"];
    if (clear !== undefined && typeof clear !== "boolean") throw new Error("clear 必须是布尔值");
    return {
      selector: boundedString(value["selector"], "selector", 2_048),
      text: boundedString(value["text"], "text", 32_000, true),
      clear: clear ?? true,
    };
  }
}

const emptySchema = { type: "object", properties: {} } as const;

export function createBrowserAgentTools(
  authority: BoundBrowserAgentAuthority,
): readonly BaseTool[] {
  return [
    new BrowserNavigateTool(authority),
    new BrowserBackTool(authority),
    new BrowserForwardTool(authority),
    new BrowserReloadTool(authority),
    new BrowserGetStateTool(authority),
    new BrowserClickTool(authority),
    new BrowserTypeTool(authority),
  ];
}

function parseObject(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("浏览器工具参数必须是 JSON 对象");
  }
}

function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  if (value.length > maxLength) throw new Error(`${name} 超过 ${maxLength} 字符上限`);
  return value;
}
