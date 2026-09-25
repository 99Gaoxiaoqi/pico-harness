import type { ToolDefinition } from "@pico/core";
import { ToolAccesses } from "@pico/runtime/tool-access";
import type { BoundClientCapabilityAuthority } from "./client-capability-command-broker.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "./tool-registry-contract.js";

abstract class ComputerTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly toolset = "computer";
  readonly readOnly = false;
  readonly permissionCategory = "computer_use" as const;
  readonly recoveryMode = "never_auto_retry" as const;

  constructor(protected readonly authority: BoundClientCapabilityAuthority) {}
  abstract name(): string;
  abstract definition(): ToolDefinition;
  protected abstract readonly action: "computer.observe" | "computer.click" | "computer.type";
  protected abstract input(value: Record<string, unknown>): Record<string, string | number>;

  accesses() {
    return ToolAccesses.resource(`computer:${this.authority.sessionId}`);
  }

  async execute(args: string): Promise<string> {
    const value = JSON.parse(args) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("电脑操作参数必须是 JSON 对象");
    }
    return JSON.stringify(
      await this.authority.execute(this.action, this.input(value as Record<string, unknown>)),
    );
  }
}

class ObserveTool extends ComputerTool {
  protected readonly action = "computer.observe" as const;
  name(): string {
    return "computer_observe";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "观察 macOS 当前前台应用和可操作元素，返回截图及一次性观察编号。需要屏幕录制和辅助功能权限。",
      inputSchema: { type: "object", properties: {} },
    };
  }
  protected input(): Record<string, string | number> {
    return {};
  }
}

class ClickTool extends ComputerTool {
  protected readonly action = "computer.click" as const;
  name(): string {
    return "computer_click";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "点击最近一次 computer_observe 中的元素。必须提供观察编号和元素 index。",
      inputSchema: {
        type: "object",
        properties: { observationId: { type: "string" }, elementIndex: { type: "integer" } },
        required: ["observationId", "elementIndex"],
      },
    };
  }
  protected input(value: Record<string, unknown>): Record<string, string | number> {
    return {
      observationId: readId(value["observationId"]),
      elementIndex: readIndex(value["elementIndex"]),
    };
  }
}

class TypeTool extends ComputerTool {
  protected readonly action = "computer.type" as const;
  name(): string {
    return "computer_type";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在最近一次 computer_observe 中的元素输入文本。先验证观察编号和元素，再点击聚焦并输入。",
      inputSchema: {
        type: "object",
        properties: {
          observationId: { type: "string" },
          elementIndex: { type: "integer" },
          text: { type: "string" },
        },
        required: ["observationId", "elementIndex", "text"],
      },
    };
  }
  protected input(value: Record<string, unknown>): Record<string, string | number> {
    const text = value["text"];
    if (typeof text !== "string" || text.length > 4_096)
      throw new Error("输入文本无效或超过 4096 字符");
    return {
      observationId: readId(value["observationId"]),
      elementIndex: readIndex(value["elementIndex"]),
      text,
    };
  }
}

function readId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value))
    throw new Error("观察编号无效");
  return value;
}

function readIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 100)
    throw new Error("元素 index 无效");
  return Number(value);
}

export function createComputerUseTools(
  authority: BoundClientCapabilityAuthority,
): readonly BaseTool[] {
  return [new ObserveTool(authority), new ClickTool(authority), new TypeTool(authority)];
}
