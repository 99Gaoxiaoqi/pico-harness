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
}

export interface AgentGraphOperatorProfileCatalog {
  listPublicProfiles(): readonly AgentGraphOperatorProfileSummary[];
  resolve(input: ResolveAgentGraphOperatorProfileInput): AgentGraphProfileSnapshot;
}

interface AgentGraphOperatorProfileDefinition {
  readonly id: string;
  readonly revision: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
}

type UnsignedProfileSnapshot = Omit<AgentGraphProfileSnapshot, "profileFingerprint">;

const SAFE_BUILTIN_TOOLS = new Set([
  "bash",
  "edit_file",
  "glob",
  "grep",
  "read_file",
  "repo_map",
  "write_file",
]);

const RESERVED_GRAPH_TOOLS = new Set([
  "agent_output",
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
    description: "Scoped implementation and deterministic verification inside the assigned workspace.",
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
      modelRouteId: rootModelRouteId,
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

export function operatorProfileFingerprint(snapshot: UnsignedProfileSnapshot): string {
  return deterministicFingerprint(snapshot);
}

export function assertValidAgentGraphOperatorProfileSnapshot(
  value: unknown,
): asserts value is AgentGraphProfileSnapshot {
  if (!isRecord(value)) throw new Error("Agent Graph Operator profile snapshot must be an object");
  assertExactKeys(value, [
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
    tools,
    permissionPolicy: { mode: "default", allowSessionGrants: false },
    systemPrompt: {
      version: systemPrompt["version"] as string,
      content,
    },
    extensionPolicy: "none",
  };
  if (operatorProfileFingerprint(unsigned) !== fingerprint) {
    throw new Error("Agent Graph Operator profile snapshot fingerprint mismatch");
  }
}

function validateDefinition(
  definition: AgentGraphOperatorProfileDefinition,
): AgentGraphOperatorProfileDefinition {
  const id = exactIdentity(definition.id, "definition.id");
  if (id !== id.toLowerCase()) throw new Error(`Operator profile ID must be lowercase: ${id}`);
  exactIdentity(definition.revision, "definition.revision");
  exactText(definition.description, "definition.description");
  exactText(definition.systemPrompt, "definition.systemPrompt");
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
  if (Object.keys(value).some((key) => !expected.has(key)) || Object.keys(value).length !== keys.length) {
    throw new Error("Agent Graph Operator profile snapshot has unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
