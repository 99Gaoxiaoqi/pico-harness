// Method registry aggregation. Domain imports stay type-only; keep the Desktop allowlist explicit.
import type { AutomationMethodMap } from "./automation.js";
import { isJsonObject, isJsonValue } from "./base.js";
import type { CapabilitiesMethodMap } from "./capabilities.js";
import type { ConfigMethodMap } from "./config.js";
import { protocolError } from "./errors.js";
import type { MemoryMethodMap } from "./memory.js";
import type { NotificationsMethodMap } from "./notifications.js";
import type { PlanningMethodMap } from "./planning.js";
import type { SubagentsMethodMap } from "./subagents.js";
import type { SessionMethodMap } from "./session.js";
import type { TranscriptMethodMap } from "./transcript.js";
import type { WorkbarMethodMap } from "./workbar.js";
import type { WorkspaceMethodMap } from "./workspace.js";

export type RuntimeMethodMap = SessionMethodMap &
  TranscriptMethodMap &
  ConfigMethodMap &
  SubagentsMethodMap &
  MemoryMethodMap &
  PlanningMethodMap &
  CapabilitiesMethodMap &
  WorkspaceMethodMap &
  AutomationMethodMap &
  WorkbarMethodMap &
  NotificationsMethodMap;

export const RUNTIME_METHODS = [
  "runtime.ping",
  "workspace.init",
  "diagnostics.run",
  "diagnostics.resources",
  "session.list",
  "session.get",
  "session.create",
  "session.archive",
  "session.restore",
  "session.pin",
  "session.unpin",
  "session.delete",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.get",
  "session.context.get",
  "session.tasks.query",
  "session.tasks.command",
  "session.artifacts.query",
  "session.artifacts.command",
  "session.trace.query",
  "session.graph.query",
  "session.graph.retryWake",
  "session.graph.stop",
  "git.review.snapshot",
  "git.review.diff",
  "browser.agent.lease",
  "browser.agent.next",
  "browser.agent.resolve",
  "terminal.create",
  "terminal.list",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
  "terminal.detach",
  "terminal.stopAll",
  "terminal.resume",
  "sideChat.create",
  "sideChat.close",
  "session.settings.update",
  "session.directories.add",
  "hooks.manage",
  "operations.manage",
  "plugin.manage",
  "goal.get",
  "session.send",
  "session.subscription.open",
  "session.subscription.close",
  "session.transcript.page",
  "session.transcript.advance",
  "session.evidence.read",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "plan.respond",
  "prompt.respond",
  "prompt.cancel",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "rewind.changes",
  "rewind.restoreFile",
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "automation.credential.import",
  "automation.create",
  "config.get",
  "config.update",
  "config.user.get",
  "config.user.update",
  "config.effective.get",
  "provider.list",
  "provider.upsert",
  "provider.importEnvironment",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "subagents.get",
  "subagents.update",
  "catalog.agents",
  "catalog.skills",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
  "mcp.effective.list",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.storageRepair.prepare",
  "workspace.storageRepair.respond",
  "workspace.list",
  "workspace.temporary.ensure",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
  "events.subscribe",
] as const satisfies readonly (keyof RuntimeMethodMap)[];

export type RuntimeMethod = keyof RuntimeMethodMap;

export type RuntimeMethodName = RuntimeMethod;

export type RuntimeParams<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["params"];

export type RuntimeResult<Method extends RuntimeMethod> = RuntimeMethodMap[Method]["result"];

/**
 * Runtime methods that the Electron preload may expose to its sandboxed Renderer.
 *
 * This is an explicit security surface rather than a derived subset of RUNTIME_METHODS:
 * trusted-host methods that import credentials or create background automations must not
 * become Renderer-accessible merely because they exist in the local daemon protocol.
 */
export const DESKTOP_RUNTIME_METHODS = [
  "runtime.ping",
  "workspace.init",
  "diagnostics.run",
  "diagnostics.resources",
  "session.list",
  "session.get",
  "session.create",
  "session.archive",
  "session.restore",
  "session.pin",
  "session.unpin",
  "session.delete",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.get",
  "session.context.get",
  "session.tasks.query",
  "session.tasks.command",
  "session.artifacts.query",
  "session.artifacts.command",
  "session.trace.query",
  "session.graph.query",
  "session.graph.retryWake",
  "session.graph.stop",
  "git.review.snapshot",
  "git.review.diff",
  "browser.agent.lease",
  "browser.agent.next",
  "browser.agent.resolve",
  "terminal.create",
  "terminal.list",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
  "terminal.detach",
  "sideChat.create",
  "sideChat.close",
  "session.settings.update",
  "session.directories.add",
  "hooks.manage",
  "operations.manage",
  "plugin.manage",
  "goal.get",
  "session.send",
  "session.subscription.open",
  "session.subscription.close",
  "session.transcript.page",
  "session.transcript.advance",
  "session.evidence.read",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "runs.list",
  "approval.respond",
  "plan.respond",
  "prompt.respond",
  "prompt.cancel",
  "changes.list",
  "changes.diff",
  "changes.review",
  "changes.apply",
  "rewind.list",
  "rewind.preview",
  "rewind.apply",
  "rewind.changes",
  "rewind.restoreFile",
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "config.get",
  "config.user.get",
  "config.user.update",
  "config.effective.get",
  "provider.list",
  "provider.upsert",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "subagents.get",
  "subagents.update",
  "catalog.agents",
  "catalog.skills",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "skills.effective.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
  "mcp.effective.list",
  "usage.get",
  "workspace.register",
  "workspace.unregister",
  "workspace.status",
  "workspace.list",
  "workspace.temporary.ensure",
  "workspace.trust",
  "workspace.trustStatus",
  "events.replay",
] as const satisfies readonly RuntimeMethod[];

export type DesktopRuntimeMethod = (typeof DESKTOP_RUNTIME_METHODS)[number];

export function isRuntimeMethod(value: string): value is RuntimeMethod {
  return (RUNTIME_METHODS as readonly string[]).includes(value);
}

/**
 * Validates the transport-level invariant shared by every method. Business
 * services remain responsible for validating required fields and permissions.
 */
export function parseRuntimeParams<Method extends RuntimeMethod>(
  method: Method,
  input: unknown,
): RuntimeParams<Method> {
  if (!isRuntimeMethod(method)) {
    throw protocolError("METHOD_NOT_FOUND", "IPC request method 无效");
  }
  if (!isJsonObject(input) || !isJsonValue(input)) {
    throw protocolError("INVALID_PARAMS", "IPC request params 必须是 JSON 对象");
  }
  return input as RuntimeParams<Method>;
}
