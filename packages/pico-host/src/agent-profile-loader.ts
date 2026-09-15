import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { KNOWN_TOOL_NAMES } from "@pico/core/known-tool-names";

export { KNOWN_TOOL_NAMES } from "@pico/core/known-tool-names";

const MAX_AGENT_PROFILE_FILE_BYTES = 512 * 1024;
const MAX_SUBAGENT_TURNS = 50;

export interface AgentProfileLogger {
  warn(bindings: object, message: string): void;
}

const NOOP_LOGGER: AgentProfileLogger = { warn: () => undefined };

/** Native Agent profile; executable trust authority stays opaque to Pico Host. */
export interface AgentProfile<TrustAuthority = unknown> {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly systemPromptOverride?: boolean;
  readonly maxTurns?: number;
  readonly modelRouteId?: string | "inherit";
  readonly thinkingEffort?: string;
  readonly tools: string[];
  readonly hooks?: unknown;
  readonly sourcePath?: string;
  readonly hookTrustAuthority?: TrustAuthority;
}

export interface AgentProfileLoadResult<TrustAuthority = unknown> {
  readonly profiles: AgentProfile<TrustAuthority>[];
  readonly tombstoneNames: string[];
}

export interface AgentProfileLoaderOptions {
  readonly filePath?: string;
  readonly logger?: AgentProfileLogger;
}

interface AgentProfilesFile {
  agents?: unknown;
}

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

/** Host-owned loader for `.pico/agents.yaml` and explicitly selected native YAML sources. */
export class AgentProfileLoader<TrustAuthority = unknown> {
  private readonly filePath: string;
  private readonly logger: AgentProfileLogger;

  constructor(workDir: string, options: AgentProfileLoaderOptions = {}) {
    this.filePath = options.filePath ?? join(workDir, ".pico", "agents.yaml");
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async load(): Promise<AgentProfile<TrustAuthority>[]> {
    return (await this.loadWithTombstones()).profiles;
  }

  async loadWithTombstones(): Promise<AgentProfileLoadResult<TrustAuthority>> {
    const filePath = this.filePath;
    let content: string;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_AGENT_PROFILE_FILE_BYTES) {
        this.logger.warn(
          { filePath, size: fileStat.size, limit: MAX_AGENT_PROFILE_FILE_BYTES },
          "[agent-profile] 配置文件超过大小上限，已忽略",
        );
        return emptyLoadResult();
      }
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isErrnoException(error, "ENOENT")) return emptyLoadResult();
      this.logger.warn({ err: error, filePath }, "[agent-profile] 读取配置文件失败");
      return emptyLoadResult();
    }

    let parsed: AgentProfilesFile;
    try {
      parsed = yaml.load(content) as AgentProfilesFile;
    } catch (error) {
      this.logger.warn({ err: error, filePath }, "[agent-profile] YAML 解析失败,已忽略自定义角色");
      return emptyLoadResult();
    }
    if (!parsed || !Array.isArray(parsed.agents)) return emptyLoadResult();
    return this.validateProfiles(parsed.agents as RawAgent[]);
  }

  private validateProfiles(rawAgents: RawAgent[]): AgentProfileLoadResult<TrustAuthority> {
    const byName = new Map<string, AgentProfile<TrustAuthority> | null>();
    for (let index = 0; index < rawAgents.length; index += 1) {
      const raw = rawAgents[index]!;
      const label = `agents[${index}]`;
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) {
        this.logger.warn({ index }, `[agent-profile] ${label}: name 缺失或为空,已跳过`);
        continue;
      }
      const canonicalName = canonicalAgentName(name);
      const description =
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim()
          : name;
      const systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt.trim() : "";
      if (!systemPrompt) {
        this.logger.warn(
          { index, name },
          `[agent-profile] ${label} (name=${name}): systemPrompt 缺失或为空,已跳过`,
        );
        this.recordTombstone(byName, canonicalName, name);
        continue;
      }
      const tools = this.validateTools(raw.tools, label, name);
      if (tools === null) {
        this.recordTombstone(byName, canonicalName, name);
        continue;
      }

      let maxTurns: number | undefined;
      if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
        const value = Number(raw.maxTurns);
        if (!Number.isInteger(value) || value <= 0) {
          this.logger.warn(
            { index, name, maxTurns: raw.maxTurns },
            `[agent-profile] ${label} (name=${name}): maxTurns 必须是正整数,已忽略该字段`,
          );
        } else if (value > MAX_SUBAGENT_TURNS) {
          this.logger.warn(
            { index, name, maxTurns: value, limit: MAX_SUBAGENT_TURNS },
            `[agent-profile] ${label} (name=${name}): maxTurns ${value} 超过上限 ${MAX_SUBAGENT_TURNS},已截断`,
          );
          maxTurns = MAX_SUBAGENT_TURNS;
        } else {
          maxTurns = value;
        }
      }

      const systemPromptOverride =
        typeof raw.systemPromptOverride === "boolean" ? raw.systemPromptOverride : undefined;
      const modelRouteId = optionalString(raw.modelRouteId);
      const thinkingEffort = optionalString(raw.thinkingEffort);
      const profile: AgentProfile<TrustAuthority> = {
        name,
        description,
        systemPrompt,
        ...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(modelRouteId === undefined ? {} : { modelRouteId }),
        ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
        tools,
      };
      if (byName.has(canonicalName)) {
        this.logger.warn({ name }, `[agent-profile] 角色名 '${name}' 重复,后者覆盖前者`);
      }
      byName.set(canonicalName, profile);
    }

    const profiles: AgentProfile<TrustAuthority>[] = [];
    const tombstoneNames: string[] = [];
    for (const [name, profile] of byName) {
      if (profile) profiles.push(profile);
      else tombstoneNames.push(name);
    }
    return { profiles, tombstoneNames };
  }

  private recordTombstone(
    byName: Map<string, AgentProfile<TrustAuthority> | null>,
    canonicalName: string,
    displayName: string,
  ): void {
    if (byName.has(canonicalName)) {
      this.logger.warn(
        { name: displayName },
        `[agent-profile] 角色名 '${displayName}' 重复,后者覆盖前者`,
      );
    }
    byName.set(canonicalName, null);
  }

  private validateTools(raw: unknown, label: string, name: string): string[] | null {
    if (!Array.isArray(raw)) {
      this.logger.warn(
        { label, name },
        `[agent-profile] ${label} (name=${name}): tools 不是数组,已跳过`,
      );
      return null;
    }
    const tools: string[] = [];
    for (const tool of raw) {
      if (typeof tool !== "string") continue;
      if (!KNOWN_TOOL_NAMES.has(tool)) {
        this.logger.warn(
          { label, name, tool, known: Array.from(KNOWN_TOOL_NAMES) },
          `[agent-profile] ${label} (name=${name}): 未知工具名 '${tool}',已忽略`,
        );
        continue;
      }
      tools.push(tool);
    }
    if (tools.length === 0) {
      this.logger.warn(
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

function emptyLoadResult<TrustAuthority>(): AgentProfileLoadResult<TrustAuthority> {
  return { profiles: [], tombstoneNames: [] };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
