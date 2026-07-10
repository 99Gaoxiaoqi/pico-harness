// 自定义子代理角色加载器:从 .claw/agents.yaml 读取用户声明的角色。
//
// 路线 A(配置预定义):对标 kimi-code profile/load.ts,但极简化——
// 无 extends 继承、无 nunjucks 模板,YAML 直读。
// 让终端用户(非开发者)通过配置文件声明自定义子代理角色(身份 prompt +
// 工具集 + 行为参数),模型经 delegate_task 的 agent_name 参数调用。
//
// 防滥用(对标 hermes 四道闸,简化版):
// - 工具白名单:tools 必须是已知工具名子集,未知名加载时拒绝
// - maxTurns 上限:超过 50 拒绝(防无限跑)
// - name 唯一:重名后者覆盖前者 + warn

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { logger } from "../observability/logger.js";

/** 允许在 .claw/agents.yaml 的 tools 里声明的工具名白名单 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "skill_view",
  "glob",
  "grep",
  "todo",
  "fetch_url",
  "web_search",
]);

/** maxTurns 上限:防止配置错误导致子代理无限跑 */
const MAX_TURNS_LIMIT = 50;

/** 一个自定义子代理角色定义 */
export interface AgentProfile {
  /** 唯一名(模型按此名调 delegate_task 的 agent_name) */
  readonly name: string;
  /** 给模型看的"何时使用此角色",注入 delegate_task 工具描述 */
  readonly description: string;
  /** 自定义 system prompt(身份/职责/红线) */
  readonly systemPrompt: string;
  /** true=完全覆盖默认探路者骨架;省略/false=追加到默认之后。默认 false。 */
  readonly systemPromptOverride?: boolean;
  /** 该角色最大轮次。省略=用 runSub 默认值(10)。上限 50。 */
  readonly maxTurns?: number;
  /** 该角色可用的工具名列表(必须是 KNOWN_TOOL_NAMES 子集) */
  readonly tools: string[];
}

/** YAML 文件的原始结构 */
interface AgentProfilesFile {
  agents?: unknown;
}

/** YAML 里单条 agent 的原始(未校验)结构 */
interface RawAgent {
  name?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  systemPromptOverride?: unknown;
  maxTurns?: unknown;
  tools?: unknown;
}

/**
 * AgentProfileLoader:从 <workDir>/.claw/agents.yaml 加载自定义子代理角色。
 *
 * 设计对标 SkillLoader:
 * - 文件不存在静默返回 [](ENOENT 不报错,工作区没配就是没自定义角色)
 * - YAML 解析/校验失败记 warn 返回 [](不让坏配置阻断主流程)
 * - 校验:name 必填且唯一、tools 白名单子集、maxTurns 上限
 */
export class AgentProfileLoader {
  constructor(private readonly workDir: string) {}

  /**
   * 加载并校验全部自定义角色。
   * 文件不存在或解析失败时返回空数组(静默降级,不阻断主流程)。
   */
  async load(): Promise<AgentProfile[]> {
    const filePath = join(this.workDir, ".claw", "agents.yaml");
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      // ENOENT:工作区未配置自定义角色,静默返回空
      if (isErrnoException(err, "ENOENT")) return [];
      // 其他 IO 错误(权限等)记 warn 返回空
      logger.warn({ err, filePath }, "[agent-profile] 读取配置文件失败");
      return [];
    }

    let parsed: AgentProfilesFile;
    try {
      parsed = yaml.load(content) as AgentProfilesFile;
    } catch (err) {
      logger.warn({ err, filePath }, "[agent-profile] YAML 解析失败,已忽略自定义角色");
      return [];
    }

    if (!parsed || !Array.isArray(parsed.agents)) {
      return [];
    }

    return this.validateProfiles(parsed.agents as RawAgent[]);
  }

  /**
   * 校验并归一化角色列表。
   * - name 必填、非空字符串
   * - tools 必须是数组,且每项在 KNOWN_TOOL_NAMES 白名单内
   * - maxTurns 若设,必须是正整数且 ≤ MAX_TURNS_LIMIT
   * - 重名:后者覆盖前者 + warn
   * 单条校验失败只跳过该条(记 warn),不让一条坏配置废掉整个文件。
   */
  private validateProfiles(rawAgents: RawAgent[]): AgentProfile[] {
    const byName = new Map<string, AgentProfile>();

    for (let i = 0; i < rawAgents.length; i++) {
      const raw = rawAgents[i]!;
      const label = `agents[${i}]`;

      // name 校验
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) {
        logger.warn({ index: i }, `[agent-profile] ${label}: name 缺失或为空,已跳过`);
        continue;
      }

      // description 校验(可选但强烈建议;缺失用 name 兜底)
      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : name;

      // systemPrompt 校验(必填)
      const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt.trim() : "";
      if (!systemPrompt) {
        logger.warn(
          { index: i, name },
          `[agent-profile] ${label} (name=${name}): systemPrompt 缺失或为空,已跳过`,
        );
        continue;
      }

      // tools 校验:必须是数组,每项在白名单内
      const tools = this.validateTools(raw.tools, label, name);
      if (tools === null) continue; // 校验失败已 warn,跳过此条

      // maxTurns 校验:正整数且 ≤ 上限
      let maxTurns: number | undefined;
      if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
        const n = Number(raw.maxTurns);
        if (!Number.isInteger(n) || n <= 0) {
          logger.warn(
            { index: i, name, maxTurns: raw.maxTurns },
            `[agent-profile] ${label} (name=${name}): maxTurns 必须是正整数,已忽略该字段`,
          );
        } else if (n > MAX_TURNS_LIMIT) {
          logger.warn(
            { index: i, name, maxTurns: n, limit: MAX_TURNS_LIMIT },
            `[agent-profile] ${label} (name=${name}): maxTurns ${n} 超过上限 ${MAX_TURNS_LIMIT},已截断`,
          );
          maxTurns = MAX_TURNS_LIMIT;
        } else {
          maxTurns = n;
        }
      }

      // systemPromptOverride:布尔,非布尔值忽略
      const systemPromptOverride =
        typeof raw.systemPromptOverride === "boolean" ? raw.systemPromptOverride : undefined;

      const profile: AgentProfile = {
        name,
        description,
        systemPrompt,
        ...(systemPromptOverride !== undefined ? { systemPromptOverride } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        tools,
      };

      // 重名去重:后者覆盖前者
      if (byName.has(name)) {
        logger.warn({ name }, `[agent-profile] 角色名 '${name}' 重复,后者覆盖前者`);
      }
      byName.set(name, profile);
    }

    return Array.from(byName.values());
  }

  /** 校验 tools 数组:必须是数组,每项是白名单内的字符串。返回 null 表示校验失败。 */
  private validateTools(raw: unknown, label: string, name: string): string[] | null {
    if (!Array.isArray(raw)) {
      logger.warn(
        { label, name },
        `[agent-profile] ${label} (name=${name}): tools 不是数组,已跳过`,
      );
      return null;
    }
    const tools: string[] = [];
    for (const t of raw) {
      if (typeof t !== "string") continue;
      if (!KNOWN_TOOL_NAMES.has(t)) {
        logger.warn(
          { label, name, tool: t, known: Array.from(KNOWN_TOOL_NAMES) },
          `[agent-profile] ${label} (name=${name}): 未知工具名 '${t}',已忽略`,
        );
        continue;
      }
      tools.push(t);
    }
    if (tools.length === 0) {
      logger.warn(
        { label, name },
        `[agent-profile] ${label} (name=${name}): tools 为空或全部无效,已跳过`,
      );
      return null;
    }
    return tools;
  }
}

/** 判断是否为指定 code 的 ErrnoException */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}
