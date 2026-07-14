import { resolve } from "node:path";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "./registry.js";

const DEFAULT_LIMIT_BYTES = 16 * 1024;
const MAX_LIMIT_BYTES = 64 * 1024;

/** Read-only capability for committed Pico artifacts; it does not widen WorkspaceRoots. */
export class ReadArtifactTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly maxResultSizeChars = MAX_LIMIT_BYTES + 1_024;
  private readonly store: ToolResultArtifactStore;

  constructor(workDir: string, artifactBaseDir = resolvePicoPaths(workDir).workspace.artifacts) {
    this.store = new ToolResultArtifactStore({ baseDir: artifactBaseDir });
  }

  name(): string {
    return "read_artifact";
  }

  accesses(): ReturnType<typeof ToolAccesses.none> {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "按字节分页回读 Pico 已提交的大型工具输出或子代理报告。只接受 observation 中的 artifactPath，不会扩大项目文件读写边界。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "observation 中的绝对 artifactPath" },
          offsetBytes: { type: "integer", minimum: 0, description: "起始字节偏移" },
          limitBytes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT_BYTES,
            description: "最多读取字节数",
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseInput(args);
    const artifact = await this.store.readPath(resolve(input.path));
    if (!artifact) throw new Error(`Artifact 不存在或已被清理: ${input.path}`);
    const bytes = Buffer.from(artifact.content, "utf8");
    if (input.offsetBytes >= bytes.length && bytes.length > 0) {
      throw new Error(`offsetBytes ${input.offsetBytes} 超出 artifact 总字节数 ${bytes.length}`);
    }
    const start = advanceToCodePointBoundary(bytes, input.offsetBytes);
    const end = retreatToCodePointBoundary(
      bytes,
      Math.min(bytes.length, start + input.limitBytes),
      start,
    );
    const rendered = bytes.subarray(start, end).toString("utf8");
    const continuation =
      end < bytes.length
        ? `\n\nPARTIAL: 已显示 bytes ${start}-${end}/${bytes.length}，继续请调用 {"path":${JSON.stringify(
            input.path,
          )},"offsetBytes":${end},"limitBytes":${input.limitBytes}}。`
        : `\n\n已显示 bytes ${start}-${end}/${bytes.length}。`;
    return `${rendered}${continuation}`;
  }
}

function parseInput(args: string): { path: string; offsetBytes: number; limitBytes: number } {
  let value: unknown;
  try {
    value = JSON.parse(args) as unknown;
  } catch (error) {
    throw new Error("read_artifact 参数必须是 JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0) {
    throw new Error("read_artifact.path 必须是非空字符串");
  }
  return {
    path: value.path,
    offsetBytes: integerInRange(value.offsetBytes, "offsetBytes", 0, 0, Number.MAX_SAFE_INTEGER),
    limitBytes: integerInRange(
      value.limitBytes,
      "limitBytes",
      DEFAULT_LIMIT_BYTES,
      1,
      MAX_LIMIT_BYTES,
    ),
  };
}

function integerInRange(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return value as number;
}

function advanceToCodePointBoundary(bytes: Buffer, offset: number): number {
  let boundary = Math.min(offset, bytes.length);
  while (boundary < bytes.length && (bytes[boundary]! & 0xc0) === 0x80) boundary++;
  return boundary;
}

function retreatToCodePointBoundary(bytes: Buffer, offset: number, minimum: number): number {
  if (offset >= bytes.length) return bytes.length;
  let boundary = offset;
  while (boundary > minimum && (bytes[boundary]! & 0xc0) === 0x80) boundary--;
  if (boundary === minimum && offset > minimum) {
    boundary = Math.min(bytes.length, minimum + 4);
    while (boundary < bytes.length && (bytes[boundary]! & 0xc0) === 0x80) boundary++;
  }
  return boundary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
