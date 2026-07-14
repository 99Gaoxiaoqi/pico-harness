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

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { logger } from "../observability/logger.js";
import { MAX_SUBAGENT_TURNS } from "./subagent-spec.js";

const MAX_AGENT_PROFILE_FILE_BYTES = 512 * 1024;

/** 允许在 Pico 原生 agents.yaml 的 tools 里声明的工具名白名单 */
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
  /** 子代理模型路由(provider/model)；省略或 inherit 时继承主会话。 */
  readonly modelRouteId?: string | "inherit";
  /** 子代理原生思考档位；最终由所选模型能力校验。 */
  readonly thinkingEffort?: string;
  /** 该角色可用的工具名列表(必须是 KNOWN_TOOL_NAMES 子集) */
  readonly tools: string[];
}

export interface AgentProfileLoadResult {
  readonly profiles: AgentProfile[];
  /**
   * 具名但未通过校验的最终 native 定义。目录层用它阻止同名低优先级
   * Claude/builtin Profile 回落，键已按大小写不敏感归一化。
   */
  readonly tombstoneNames: string[];
}

export interface AgentProfileLoaderOptions {
  /** 显式原生 Agent YAML；省略时保持旧 `.claw/agents.yaml` 兼容入口。 */
  readonly filePath?: string;
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
  modelRouteId?: unknown;
  thinkingEffort?: unknown;
  tools?: unknown;
}

/**
 * AgentProfileLoader:从指定 Pico agents.yaml 加载自定义子代理角色；默认保留 .claw 兼容入口。
 *
 * 设计对标 SkillLoader:
 * - 文件不存在静默返回 [](ENOENT 不报错,工作区没配就是没自定义角色)
 * - YAML 解析/校验失败记 warn 返回 [](不让坏配置阻断主流程)
 * - 校验:name 必填且唯一、tools 白名单子集、maxTurns 上限
 */
export class AgentProfileLoader {
  private readonly filePath: string;

  constructor(workDir: string, options: AgentProfileLoaderOptions = {}) {
    this.filePath = options.filePath ?? join(workDir, ".claw", "agents.yaml");
  }

  /**
   * 加载并校验全部自定义角色。
   * 文件不存在或解析失败时返回空数组(静默降级,不阻断主流程)。
   */
  async load(): Promise<AgentProfile[]> {
    return (await this.loadWithTombstones()).profiles;
  }

  /** 加载 Profile 及必须在统一目录中保留的 fail-closed tombstone。 */
  async loadWithTombstones(): Promise<AgentProfileLoadResult> {
    const filePath = this.filePath;
    let content: string;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_AGENT_PROFILE_FILE_BYTES) {
        logger.warn(
          { filePath, size: fileStat.size, limit: MAX_AGENT_PROFILE_FILE_BYTES },
          "[agent-profile] 配置文件超过大小上限，已忽略",
        );
        return emptyLoadResult();
      }
      content = await readFile(filePath, "utf8");
    } catch (err) {
      // ENOENT:工作区未配置自定义角色,静默返回空
      if (isErrnoException(err, "ENOENT")) return emptyLoadResult();
      // 其他 IO 错误(权限等)记 warn 返回空
      logger.warn({ err, filePath }, "[agent-profile] 读取配置文件失败");
      return emptyLoadResult();
    }

    let parsed: AgentProfilesFile;
    try {
      parsed = yaml.load(content) as AgentProfilesFile;
    } catch (err) {
      logger.warn({ err, filePath }, "[agent-profile] YAML 解析失败,已忽略自定义角色");
      return emptyLoadResult();
    }

    if (!parsed || !Array.isArray(parsed.agents)) {
      return emptyLoadResult();
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
  private validateProfiles(rawAgents: RawAgent[]): AgentProfileLoadResult {
    const byName = new Map<string, AgentProfile | null>();

    for (let i = 0; i < rawAgents.length; i++) {
      const raw = rawAgents[i]!;
      const label = `agents[${i}]`;

      // name 校验
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) {
        logger.warn({ index: i }, `[agent-profile] ${label}: name 缺失或为空,已跳过`);
        continue;
      }
      const canonicalName = canonicalAgentName(name);

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
        this.recordTombstone(byName, canonicalName, name);
        continue;
      }

      // tools 校验:必须是数组,每项在白名单内
      const tools = this.validateTools(raw.tools, label, name);
      if (tools === null) {
        this.recordTombstone(byName, canonicalName, name);
        continue;
      }

      // maxTurns 校验:正整数且 ≤ 上限
      let maxTurns: number | undefined;
      if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
        const n = Number(raw.maxTurns);
        if (!Number.isInteger(n) || n <= 0) {
          logger.warn(
            { index: i, name, maxTurns: raw.maxTurns },
            `[agent-profile] ${label} (name=${name}): maxTurns 必须是正整数,已忽略该字段`,
          );
        } else if (n > MAX_SUBAGENT_TURNS) {
          logger.warn(
            { index: i, name, maxTurns: n, limit: MAX_SUBAGENT_TURNS },
            `[agent-profile] ${label} (name=${name}): maxTurns ${n} 超过上限 ${MAX_SUBAGENT_TURNS},已截断`,
          );
          maxTurns = MAX_SUBAGENT_TURNS;
        } else {
          maxTurns = n;
        }
      }

      // systemPromptOverride:布尔,非布尔值忽略
      const systemPromptOverride =
        typeof raw.systemPromptOverride === "boolean" ? raw.systemPromptOverride : undefined;
      const modelRouteId = optionalString(raw.modelRouteId);
      const thinkingEffort = optionalString(raw.thinkingEffort);

      const profile: AgentProfile = {
        name,
        description,
        systemPrompt,
        ...(systemPromptOverride !== undefined ? { systemPromptOverride } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(modelRouteId !== undefined ? { modelRouteId } : {}),
        ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
        tools,
      };

      // 重名去重:后者覆盖前者
      if (byName.has(canonicalName)) {
        logger.warn({ name }, `[agent-profile] 角色名 '${name}' 重复,后者覆盖前者`);
      }
      byName.set(canonicalName, profile);
    }

    const profiles: AgentProfile[] = [];
    const tombstoneNames: string[] = [];
    for (const [name, profile] of byName) {
      if (profile) profiles.push(profile);
      else tombstoneNames.push(name);
    }
    return { profiles, tombstoneNames };
  }

  private recordTombstone(
    byName: Map<string, AgentProfile | null>,
    canonicalName: string,
    displayName: string,
  ): void {
    if (byName.has(canonicalName)) {
      logger.warn(
        { name: displayName },
        `[agent-profile] 角色名 '${displayName}' 重复,后者覆盖前者`,
      );
    }
    byName.set(canonicalName, null);
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

function canonicalAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function emptyLoadResult(): AgentProfileLoadResult {
  return { profiles: [], tombstoneNames: [] };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
