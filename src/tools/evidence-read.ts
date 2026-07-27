import {
  DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES,
  EvidenceArchive,
  MAX_EVIDENCE_PAGE_LIMIT_BYTES,
  parseRuntimeEvidenceUri,
} from "../context/evidence-archive.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "./registry.js";

interface ReadEvidenceInput {
  readonly ref: string;
  readonly offsetBytes: number;
  readonly limitBytes: number;
}

/**
 * Read-only, URI-bound access to Runtime tool-result Evidence.
 *
 * The model never supplies a filesystem path: the archive derives both manifest
 * and blob paths from the validated session/hash reference.
 */
export class ReadEvidenceTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly maxResultSizeChars = MAX_EVIDENCE_PAGE_LIMIT_BYTES + 2_048;
  private readonly archive: EvidenceArchive;

  constructor(workDir: string, evidenceBaseDir = resolvePicoPaths(workDir).workspace.evidence) {
    this.archive = new EvidenceArchive({ baseDir: evidenceBaseDir });
  }

  name(): string {
    return "read_evidence";
  }

  accesses(): ReturnType<typeof ToolAccesses.none> {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "按字节分页回读 Pico 已归档的原始工具输出。只接受工具预览中的 pico://evidence/... 引用，并在返回前校验 manifest、内容哈希和 blob 完整性。",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "工具结果预览中的 pico://evidence/... 引用",
          },
          offsetBytes: {
            type: "integer",
            minimum: 0,
            description: "起始字节偏移，省略时从 0 开始",
          },
          limitBytes: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVIDENCE_PAGE_LIMIT_BYTES,
            description: "本页最多读取的字节数",
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseInput(args);
    const reference = parseRuntimeEvidenceUri(input.ref);
    const page = await this.archive.readRuntimeToolOutputPage(reference, {
      offsetBytes: input.offsetBytes,
      limitBytes: input.limitBytes,
    });
    const pageMetadata = [
      `[Evidence bytes ${page.offsetBytes}-${page.endOffsetBytes}/${page.totalBytes}]`,
      `ref: ${input.ref}`,
      `truncated: ${String(page.truncated)}`,
      ...(page.nextOffsetBytes === undefined
        ? []
        : [
            `next: ${JSON.stringify({
              ref: input.ref,
              offsetBytes: page.nextOffsetBytes,
              limitBytes: page.limitBytes,
            })}`,
          ]),
    ].join("\n");
    return `${page.content}\n\n${pageMetadata}`;
  }
}

function parseInput(args: string): ReadEvidenceInput {
  let value: unknown;
  try {
    value = JSON.parse(args) as unknown;
  } catch (error) {
    throw new Error("read_evidence 参数必须是 JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value["ref"] !== "string" || value["ref"].length === 0) {
    throw new Error("read_evidence.ref 必须是非空字符串");
  }
  const allowed = new Set(["ref", "offsetBytes", "limitBytes"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("read_evidence 包含未知参数");
  }
  return {
    ref: value["ref"],
    offsetBytes: integerInRange(value["offsetBytes"], "offsetBytes", 0, 0, Number.MAX_SAFE_INTEGER),
    limitBytes: integerInRange(
      value["limitBytes"],
      "limitBytes",
      DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES,
      1,
      MAX_EVIDENCE_PAGE_LIMIT_BYTES,
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
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
