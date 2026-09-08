import type { RuntimeSubagentPreset } from "@pico/protocol";
import {
  SUBAGENT_CAPABILITIES,
  requireSubagentCapability,
  type ConfiguredSubagentCatalogPort,
} from "../agents/subagent-profiles.js";
import type { CatalogAgentProfile } from "../agents/catalog.js";
import { KNOWN_TOOL_NAMES } from "../tools/agent-profile.js";
import type { AgentGraphProfileSnapshot } from "./core/contracts.js";
import { deterministicFingerprint } from "./core/ids.js";

export interface AgentGraphOperatorProfileSummary {
  readonly profileId: string;
  readonly revision: string;
  readonly description: string;
}

export interface ResolveAgentGraphOperatorProfileInput {
  readonly profileId: string;
  readonly rootModelRouteId: string;
  readonly requireConfiguredPreset?: boolean;
}

export interface AgentGraphOperatorProfileCatalog {
  listPublicProfiles(): readonly AgentGraphOperatorProfileSummary[];
  resolve(input: ResolveAgentGraphOperatorProfileInput): AgentGraphProfileSnapshot;
  /** Live configuration is resolved before committing an immutable schedule. */
  resolveForExecution?(
    input: ResolveAgentGraphOperatorProfileInput,
  ): Promise<AgentGraphProfileSnapshot>;
  listAvailableProfiles?(): Promise<readonly AgentGraphOperatorProfileSummary[]>;
}

interface AgentGraphOperatorProfileDefinition {
  readonly id: string;
  readonly revision: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly modelRouteId?: string;
  readonly thinkingEffort?: string;
  readonly maxTurns?: number;
}

type UnsignedProfileSnapshot = Omit<AgentGraphProfileSnapshot, "profileFingerprint">;

const SAFE_BUILTIN_TOOLS = new Set([...KNOWN_TOOL_NAMES, "explore_repo"]);

const RESERVED_GRAPH_TOOLS = new Set([
  "agent_output",
  "agent_list",
  "agent_swarm_status",
  "agent_graph_results",
  "update_agent_graph",
  "view_agent_graph",
  "yield_agent_graph",
]);

const BUILTIN_PROFILES: readonly AgentGraphOperatorProfileDefinition[] = [
  {
    id: "explore",
    revision: "1",
    description: "Read-only repository exploration and evidence collection.",
    tools: ["read_file", "glob", "grep", "repo_map"],
    systemPrompt:
      "Inspect the assigned problem using read-only repository tools. Report concise findings with exact file evidence. Do not modify files or claim work you did not verify.",
  },
  {
    id: "implement",
    revision: "1",
    description:
      "Scoped implementation and deterministic verification inside the assigned workspace.",
    tools: ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "repo_map"],
    systemPrompt:
      "Implement only the assigned scope. Inspect before editing, preserve unrelated changes, run focused verification, and report the exact files and checks completed.",
  },
  {
    id: "review",
    revision: "1",
    description: "Read-only review of correctness, regressions, and security boundaries.",
    tools: ["read_file", "glob", "grep", "repo_map"],
    systemPrompt:
      "Review the assigned change without modifying files. Prioritize concrete correctness, security, and regression risks, cite exact evidence, and state clearly when no blocker is found.",
  },
] as const;

class BuiltinAgentGraphOperatorProfileCatalog implements AgentGraphOperatorProfileCatalog {
  private readonly definitions: ReadonlyMap<string, AgentGraphOperatorProfileDefinition>;

  constructor(definitions: readonly AgentGraphOperatorProfileDefinition[]) {
    const validated = definitions.map(validateDefinition);
    const byId = new Map<string, AgentGraphOperatorProfileDefinition>();
    for (const definition of validated) {
      if (byId.has(definition.id)) {
        throw new Error(`Duplicate Agent Graph Operator profile: ${definition.id}`);
      }
      byId.set(definition.id, definition);
    }
    this.definitions = byId;
  }

  listPublicProfiles(): readonly AgentGraphOperatorProfileSummary[] {
    return [...this.definitions.values()].map(({ id, revision, description }) => ({
      profileId: id,
      revision,
      description,
    }));
  }

  resolve(input: ResolveAgentGraphOperatorProfileInput): AgentGraphProfileSnapshot {
    const profileId = exactIdentity(input.profileId, "profileId");
    const rootModelRouteId = exactIdentity(input.rootModelRouteId, "rootModelRouteId");
    const definition = this.definitions.get(profileId);
    if (!definition) throw new Error(`Unknown Agent Graph Operator profile: ${profileId}`);
    const unsigned: UnsignedProfileSnapshot = {
      schemaVersion: 1,
      profileId: definition.id,
      profileRevision: definition.revision,
      modelRouteId:
        definition.modelRouteId && definition.modelRouteId !== "inherit"
          ? definition.modelRouteId
          : rootModelRouteId,
      ...(definition.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: definition.thinkingEffort }),
      ...(definition.maxTurns === undefined ? {} : { maxTurns: definition.maxTurns }),
      tools: [...definition.tools],
      permissionPolicy: { mode: "default", allowSessionGrants: false },
      systemPrompt: { version: definition.revision, content: definition.systemPrompt },
      extensionPolicy: "none",
    };
    return Object.freeze({
      ...unsigned,
      profileFingerprint: operatorProfileFingerprint(unsigned),
    });
  }
}

export function createBuiltinAgentGraphOperatorProfileCatalog(): AgentGraphOperatorProfileCatalog {
  return new BuiltinAgentGraphOperatorProfileCatalog(BUILTIN_PROFILES);
}

export interface MutableAgentGraphOperatorProfileCatalog extends AgentGraphOperatorProfileCatalog {
  /** Replace only future choices; persisted activation snapshots remain immutable. */
  replaceProfiles(profiles: readonly CatalogAgentProfile[]): void;
}

export function createCatalogAgentGraphOperatorProfileCatalog(
  profiles: readonly CatalogAgentProfile[],
): MutableAgentGraphOperatorProfileCatalog {
  const legacy = createBuiltinAgentGraphOperatorProfileCatalog();
  let current: AgentGraphOperatorProfileCatalog;
  let unavailable = new Map<string, string>();
  const replaceProfiles = (next: readonly CatalogAgentProfile[]) => {
    const rejected = new Map<string, string>();
    const definitions = next.flatMap((profile): AgentGraphOperatorProfileDefinition[] => {
      const unsupportedTool = profile.tools.find(
        (tool) => !SAFE_BUILTIN_TOOLS.has(tool) || RESERVED_GRAPH_TOOLS.has(tool),
      );
      const reason =
        profile.hooks !== undefined
          ? "Agent hooks are not supported by persistent Graph execution"
          : unsupportedTool
            ? `Unsupported Graph Operator tool: ${unsupportedTool}`
            : undefined;
      if (reason) {
        rejected.set(profile.name, reason);
        return [];
      }
      const definition = {
        id: profile.name,
        description: profile.description,
        tools: [...profile.tools],
        systemPrompt: profile.systemPrompt,
        ...(profile.modelRouteId === undefined ? {} : { modelRouteId: profile.modelRouteId }),
        ...(profile.thinkingEffort === undefined ? {} : { thinkingEffort: profile.thinkingEffort }),
        ...(profile.maxTurns === undefined ? {} : { maxTurns: profile.maxTurns }),
      };
      return [{ ...definition, revision: deterministicFingerprint(definition) }];
    });
    const catalog = new BuiltinAgentGraphOperatorProfileCatalog(definitions);
    current = catalog;
    unavailable = rejected;
  };
  replaceProfiles(profiles);
  return {
    listPublicProfiles: () => current.listPublicProfiles(),
    resolve: (input) => {
      const reason = unavailable.get(input.profileId);
      if (reason) throw new Error(`Subagent ${input.profileId} is unavailable: ${reason}`);
      const catalog = current
        .listPublicProfiles()
        .some((profile) => profile.profileId === input.profileId)
        ? current
        : legacy;
      return catalog.resolve(input);
    },
    replaceProfiles,
  };
}

function validateExecutionOptions(value: Record<string, unknown>): void {
  if (value["thinkingEffort"] !== undefined)
    exactIdentity(value["thinkingEffort"], "thinkingEffort");
  if (
    value["maxTurns"] !== undefined &&
    (!Number.isSafeInteger(value["maxTurns"]) ||
      (value["maxTurns"] as number) < 1 ||
      (value["maxTurns"] as number) > 50)
  ) {
    throw new Error("Agent Graph Operator maxTurns must be an integer between 1 and 50");
  }
}

export function operatorProfileFingerprint(snapshot: UnsignedProfileSnapshot): string {
  return deterministicFingerprint(snapshot);
}

export function assertValidAgentGraphOperatorProfileSnapshot(
  value: unknown,
): asserts value is AgentGraphProfileSnapshot {
  if (!isRecord(value)) throw new Error("Agent Graph Operator profile snapshot must be an object");
  assertExactKeys(value, [
    ...(value["thinkingEffort"] === undefined ? [] : ["thinkingEffort"]),
    ...(value["maxTurns"] === undefined ? [] : ["maxTurns"]),
    ...(value["subagentPreset"] === undefined ? [] : ["subagentPreset"]),
    "schemaVersion",
    "profileId",
    "profileRevision",
    "profileFingerprint",
    "modelRouteId",
    "tools",
    "permissionPolicy",
    "systemPrompt",
    "extensionPolicy",
  ]);
  if (value["schemaVersion"] !== 1) {
    throw new Error("Unsupported Agent Graph Operator profile snapshot schema");
  }
  exactIdentity(value["profileId"], "profileId");
  exactIdentity(value["profileRevision"], "profileRevision");
  exactIdentity(value["modelRouteId"], "modelRouteId");
  const fingerprint = exactIdentity(value["profileFingerprint"], "profileFingerprint");
  validateExecutionOptions(value);
  if (!Array.isArray(value["tools"]) || value["tools"].length === 0) {
    throw new Error("Agent Graph Operator profile tools must be a non-empty array");
  }
  const tools = value["tools"].map((tool) => exactIdentity(tool, "tools[]"));
  if (new Set(tools).size !== tools.length) {
    throw new Error("Agent Graph Operator profile tools must be unique");
  }
  for (const tool of tools) {
    if (!SAFE_BUILTIN_TOOLS.has(tool) || RESERVED_GRAPH_TOOLS.has(tool)) {
      throw new Error(`Agent Graph Operator profile contains forbidden tool: ${tool}`);
    }
  }
  const permissionPolicy = value["permissionPolicy"];
  if (!isRecord(permissionPolicy)) {
    throw new Error("Agent Graph Operator permission policy must be an object");
  }
  assertExactKeys(permissionPolicy, ["mode", "allowSessionGrants"]);
  if (permissionPolicy["mode"] !== "default" || permissionPolicy["allowSessionGrants"] !== false) {
    throw new Error("Agent Graph Operator permission policy exceeds the allowed boundary");
  }
  const systemPrompt = value["systemPrompt"];
  if (!isRecord(systemPrompt)) {
    throw new Error("Agent Graph Operator system prompt must be an object");
  }
  assertExactKeys(systemPrompt, ["version", "content"]);
  exactIdentity(systemPrompt["version"], "systemPrompt.version");
  const content = exactText(systemPrompt["content"], "systemPrompt.content");
  if (Buffer.byteLength(content, "utf8") > 16 * 1024) {
    throw new Error("Agent Graph Operator system prompt exceeds 16 KiB");
  }
  if (value["extensionPolicy"] !== "none") {
    throw new Error("Agent Graph Operator extensions must be disabled");
  }
  const unsigned: UnsignedProfileSnapshot = {
    schemaVersion: 1,
    profileId: value["profileId"] as string,
    profileRevision: value["profileRevision"] as string,
    modelRouteId: value["modelRouteId"] as string,
    ...(value["thinkingEffort"] === undefined
      ? {}
      : { thinkingEffort: value["thinkingEffort"] as string }),
    ...(value["maxTurns"] === undefined ? {} : { maxTurns: value["maxTurns"] as number }),
    ...(value["subagentPreset"] === undefined
      ? {}
      : { subagentPreset: value["subagentPreset"] as RuntimeSubagentPreset }),
    tools,
    permissionPolicy: { mode: "default", allowSessionGrants: false },
    systemPrompt: {
      version: systemPrompt["version"] as string,
      content,
    },
    extensionPolicy: "none",
  };
  if (unsigned.subagentPreset) {
    const preset = unsigned.subagentPreset;
    const capability = requireSubagentCapability(preset.profile);
    if (
      preset.id !== unsigned.profileId ||
      JSON.stringify(capability.tools) !== JSON.stringify(unsigned.tools)
    )
      throw new Error("Subagent snapshot capability mismatch");
  }
  if (operatorProfileFingerprint(unsigned) !== fingerprint) {
    throw new Error("Agent Graph Operator profile snapshot fingerprint mismatch");
  }
}

function validateDefinition(
  definition: AgentGraphOperatorProfileDefinition,
): AgentGraphOperatorProfileDefinition {
  const id = exactIdentity(definition.id, "definition.id");

  exactIdentity(definition.revision, "definition.revision");
  exactText(definition.description, "definition.description");
  exactText(definition.systemPrompt, "definition.systemPrompt");
  validateExecutionOptions({ ...definition });
  if (definition.modelRouteId !== undefined) exactIdentity(definition.modelRouteId, "modelRouteId");
  if (definition.tools.length === 0 || new Set(definition.tools).size !== definition.tools.length) {
    throw new Error(`Operator profile ${id} must contain unique tools`);
  }
  for (const tool of definition.tools) {
    if (!SAFE_BUILTIN_TOOLS.has(tool) || RESERVED_GRAPH_TOOLS.has(tool)) {
      throw new Error(`Operator profile ${id} contains forbidden tool: ${tool}`);
    }
  }
  return Object.freeze({ ...definition, tools: Object.freeze([...definition.tools]) });
}

function exactIdentity(value: unknown, field: string): string {
  const text = exactText(value, field);
  if (text.trim() !== text || Buffer.byteLength(text, "utf8") > 1024) {
    throw new Error(`Invalid Agent Graph Operator ${field}`);
  }
  return text;
}

function exactText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Agent Graph Operator ${field}`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).some((key) => !expected.has(key)) ||
    Object.keys(value).length !== keys.length
  ) {
    throw new Error("Agent Graph Operator profile snapshot has unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Presets have fixed IDs; legacy YAML/built-in choices retain their own selectors. */
export function createConfiguredAgentGraphOperatorProfileCatalog(
  configured: ConfiguredSubagentCatalogPort,
  legacy: AgentGraphOperatorProfileCatalog = createBuiltinAgentGraphOperatorProfileCatalog(),
): AgentGraphOperatorProfileCatalog {
  const capabilities = new BuiltinAgentGraphOperatorProfileCatalog(
    SUBAGENT_CAPABILITIES.map((entry) => ({
      id: entry.id,
      revision: "1",
      description: entry.description,
      tools: entry.tools,
      systemPrompt: entry.systemPrompt,
    })),
  );
  return {
    listPublicProfiles: () => legacy.listPublicProfiles(),
    resolve: (input) =>
      capabilities.listPublicProfiles().some((entry) => entry.profileId === input.profileId)
        ? capabilities.resolve(input)
        : legacy.resolve(input),
    async listAvailableProfiles() {
      const presets = (await configured.list()).filter(
        (entry) => entry.availability.status === "available",
      );
      return [
        ...presets.map((preset) => ({
          profileId: preset.id,
          description: preset.description || preset.name,
          revision: deterministicFingerprint(preset),
        })),
        ...legacy
          .listPublicProfiles()
          .filter((entry) => !presets.some((preset) => preset.id === entry.profileId)),
        ...capabilities
          .listPublicProfiles()
          .filter(
            (entry) =>
              !presets.some((preset) => preset.id === entry.profileId) &&
              !legacy.listPublicProfiles().some((item) => item.profileId === entry.profileId),
          ),
      ];
    },
    async resolveForExecution(input) {
      if (input.requireConfiguredPreset === false) return this.resolve(input);
      // Existing configured IDs must fail closed even when disabled, never fall back by name.
      if (
        !input.requireConfiguredPreset &&
        !(await configured.list()).some((preset) => preset.id === input.profileId)
      )
        return this.resolve(input);
      const resolved = await configured.resolve(input.profileId);
      const { modelRouteId, ...preset } = resolved;
      const definition = requireSubagentCapability(preset.profile);
      const unsigned: UnsignedProfileSnapshot = {
        schemaVersion: 1,
        profileId: preset.id,
        profileRevision: deterministicFingerprint(preset),
        modelRouteId,
        ...(preset.thinkingLevel === undefined ? {} : { thinkingEffort: preset.thinkingLevel }),
        subagentPreset: Object.freeze({ ...preset }),
        tools: [...definition.tools],
        permissionPolicy: { mode: "default", allowSessionGrants: false },
        systemPrompt: { version: "1", content: definition.systemPrompt },
        extensionPolicy: "none",
      };
      return Object.freeze({
        ...unsigned,
        profileFingerprint: operatorProfileFingerprint(unsigned),
      });
    },
  };
}
