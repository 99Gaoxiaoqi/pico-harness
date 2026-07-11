import path from "node:path";
import type { CodeIntelligenceService, PositionQuery } from "../code-intelligence/types.js";
import { RepoMapService } from "../code-intelligence/repo-map.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";

type UnknownRecord = Record<string, unknown>;

abstract class CodeIntelligenceTool implements BaseTool {
  readonly readOnly = true;

  constructor(
    protected readonly rootDir: string,
    protected readonly service: CodeIntelligenceService,
  ) {}

  abstract name(): string;
  abstract definition(): ToolDefinition;
  abstract execute(args: string, context?: ToolExecutionContext): Promise<string>;

  accesses(args: string): ToolAccessSet {
    const input = parseInput(args);
    const filePath = optionalString(input, "file_path");
    return filePath
      ? ToolAccesses.readFile(path.resolve(this.rootDir, filePath))
      : ToolAccesses.all();
  }

  protected positionQuery(input: UnknownRecord): PositionQuery {
    return {
      filePath: requiredString(input, "file_path"),
      position: {
        line: positiveInteger(input, "line"),
        character: positiveInteger(input, "character"),
      },
    };
  }
}

export class CodeDefinitionTool extends CodeIntelligenceTool {
  name(): string {
    return "code_definition";
  }

  definition(): ToolDefinition {
    return positionDefinition(
      this.name(),
      "查找符号定义。优先使用 LSP，未安装 Language Server 时自动降级 Repo Map。",
    );
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const locations = await this.service.definitions(this.positionQuery(parseInput(args)), {
      signal: context?.signal,
    });
    return formatResult(this.service.backend, locations);
  }
}

export class CodeReferencesTool extends CodeIntelligenceTool {
  name(): string {
    return "code_references";
  }

  definition(): ToolDefinition {
    return positionDefinition(this.name(), "查找符号在仓库中的引用位置（LSP / Repo Map）。");
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const locations = await this.service.references(this.positionQuery(parseInput(args)), {
      signal: context?.signal,
    });
    return formatResult(this.service.backend, locations);
  }
}

export class CodeSymbolsTool extends CodeIntelligenceTool {
  name(): string {
    return "code_symbols";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "按名称搜索工作区或指定文件的代码符号（class/function/interface 等）。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "符号名关键词，留空则列出可用符号" },
          file_path: { type: "string", description: "可选的工作区内文件路径" },
          limit: { type: "number", description: "结果上限，默认 100" },
        },
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseInput(args);
    const symbols = await this.service.symbols(
      {
        ...(optionalString(input, "query") ? { query: optionalString(input, "query") } : {}),
        ...(optionalString(input, "file_path")
          ? { filePath: optionalString(input, "file_path") }
          : {}),
        ...(optionalPositiveInteger(input, "limit")
          ? { limit: optionalPositiveInteger(input, "limit") }
          : {}),
      },
      { signal: context?.signal },
    );
    return formatResult(this.service.backend, symbols);
  }
}

export class CodeDiagnosticsTool extends CodeIntelligenceTool {
  name(): string {
    return "code_diagnostics";
  }

  definition(): ToolDefinition {
    return fileDefinition(
      this.name(),
      "获取文件的 Language Server 诊断。Repo Map 降级时会明确返回空诊断。",
    );
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const diagnostics = await this.service.diagnostics(
      requiredString(parseInput(args), "file_path"),
      { signal: context?.signal },
    );
    return formatResult(this.service.backend, diagnostics);
  }
}

export class CodeCallHierarchyTool extends CodeIntelligenceTool {
  name(): string {
    return "code_call_hierarchy";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "查询符号的上游调用者或下游调用目标。",
      inputSchema: {
        type: "object",
        properties: {
          ...positionProperties(),
          direction: { type: "string", enum: ["incoming", "outgoing"] },
        },
        required: ["file_path", "line", "character", "direction"],
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseInput(args);
    const direction = requiredString(input, "direction");
    if (direction !== "incoming" && direction !== "outgoing") {
      throw new Error("direction 必须为 incoming 或 outgoing");
    }
    const calls = await this.service.callHierarchy(this.positionQuery(input), direction, {
      signal: context?.signal,
    });
    return formatResult(this.service.backend, calls);
  }
}

export class RepoMapTool extends CodeIntelligenceTool {
  private readonly repoMap: RepoMapService;

  constructor(rootDir: string, service: CodeIntelligenceService) {
    super(rootDir, service);
    this.repoMap = service instanceof RepoMapService ? service : new RepoMapService(rootDir);
  }

  name(): string {
    return "repo_map";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "渐进式生成仓库文件与符号地图。每次只索引有限批次，可重复调用直至 complete=true。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "可选的文件或符号关键词" },
          max_files: { type: "number", description: "本次最多新索引文件数，默认 200" },
        },
      },
    };
  }

  override accesses(): ToolAccessSet {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseInput(args);
    const snapshot = await this.repoMap.snapshot({
      ...(optionalString(input, "query") ? { query: optionalString(input, "query") } : {}),
      ...(optionalPositiveInteger(input, "max_files")
        ? { maxFiles: optionalPositiveInteger(input, "max_files") }
        : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const lines = snapshot.files.map((file) => {
      const symbols = file.symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ");
      return `${file.filePath}${symbols ? `: ${symbols}` : ""}`;
    });
    return [
      `backend=repo-map indexed=${snapshot.indexedFiles}/${snapshot.totalFiles} complete=${snapshot.complete}`,
      ...lines,
    ].join("\n");
  }
}

export function createCodeIntelligenceTools(
  rootDir: string,
  service: CodeIntelligenceService,
): readonly BaseTool[] {
  return [
    new CodeDefinitionTool(rootDir, service),
    new CodeReferencesTool(rootDir, service),
    new CodeSymbolsTool(rootDir, service),
    new CodeDiagnosticsTool(rootDir, service),
    new CodeCallHierarchyTool(rootDir, service),
    new RepoMapTool(rootDir, service),
  ];
}

function positionDefinition(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: positionProperties(),
      required: ["file_path", "line", "character"],
    },
  };
}

function positionProperties(): Record<string, unknown> {
  return {
    file_path: { type: "string", description: "工作区内文件路径" },
    line: { type: "number", description: "1-based 行号" },
    character: { type: "number", description: "1-based UTF-16 字符列" },
  };
}

function fileDefinition(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string", description: "工作区内文件路径" } },
      required: ["file_path"],
    },
  };
}

function formatResult(backend: CodeIntelligenceService["backend"], value: unknown): string {
  return `backend=${backend}\n${JSON.stringify(value, undefined, 2)}`;
}

function parseInput(args: string): UnknownRecord {
  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    throw new Error("参数解析失败：期望 JSON 对象");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("参数解析失败：期望 JSON 对象");
  }
  return input as UnknownRecord;
}

function requiredString(input: UnknownRecord, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new Error(`${key} 必须是非空字符串`);
  return value;
}

function optionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveInteger(input: UnknownRecord, key: string): number {
  const value = optionalPositiveInteger(input, key);
  if (!value) throw new Error(`${key} 必须是正整数`);
  return value;
}

function optionalPositiveInteger(input: UnknownRecord, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
