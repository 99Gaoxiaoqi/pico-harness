import type {
  MobileConversationItem,
  MobileProject,
  MobileProjectId,
  MobileRun,
  MobileSession,
  MobileTranscript,
  RuntimeConversationItem,
  RuntimeRun,
  RuntimeSession,
  SessionId,
} from "@pico/protocol";
import type { RuntimeClient } from "../daemon/client.js";
import type { MobileProjectAuthority } from "./project-authority.js";

export interface MobileGatewayApi {
  listProjects(): Promise<readonly MobileProject[]>;
  listSessions(projectId: MobileProjectId): Promise<readonly MobileSession[]>;
  getTranscript(
    projectId: MobileProjectId,
    sessionId: SessionId,
    before?: string,
  ): Promise<MobileTranscript>;
}

export class MobileGatewayService implements MobileGatewayApi {
  constructor(
    private readonly authority: Pick<MobileProjectAuthority, "listProjects" | "resolveProjectPath">,
    private readonly runtime: Pick<RuntimeClient, "request">,
  ) {}

  listProjects(): Promise<readonly MobileProject[]> {
    return this.authority.listProjects();
  }

  async listSessions(projectId: MobileProjectId): Promise<readonly MobileSession[]> {
    const workspacePath = await this.authority.resolveProjectPath(projectId);
    const result = await this.runtime.request("session.list", {
      workspacePath,
      includeArchived: false,
    });
    return result.sessions.map((session) => toMobileSession(session, workspacePath));
  }

  async getTranscript(
    projectId: MobileProjectId,
    sessionId: SessionId,
    before?: string,
  ): Promise<MobileTranscript> {
    const workspacePath = await this.authority.resolveProjectPath(projectId);
    const result = await this.runtime.request("session.transcript", {
      workspacePath,
      sessionId,
      limit: 100,
      ...(before ? { before } : {}),
    });
    const session = toMobileSession(result.session, workspacePath);
    if (session.sessionId !== sessionId) {
      throw new Error("Runtime returned a transcript for another session");
    }
    return {
      session,
      items: result.items.map(toMobileConversationItem),
      ...(result.activeRun
        ? { activeRun: toMobileRun(result.activeRun, workspacePath, sessionId) }
        : {}),
      ...(result.nextBefore ? { nextBefore: result.nextBefore } : {}),
      revision: result.revision,
    };
  }
}

function toMobileSession(session: RuntimeSession, expectedWorkspacePath: string): MobileSession {
  if (session.workspacePath !== expectedWorkspacePath) {
    throw new Error("Runtime returned a session outside the authorized project");
  }
  return {
    sessionId: session.sessionId,
    title: session.title,
    status: session.status,
    pinned: session.pinned,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toMobileRun(
  run: RuntimeRun,
  expectedWorkspacePath: string,
  expectedSessionId: SessionId,
): MobileRun {
  if (run.workspacePath !== expectedWorkspacePath || run.sessionId !== expectedSessionId) {
    throw new Error("Runtime returned a run outside the authorized session");
  }
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    description: run.description,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

function toMobileConversationItem(item: RuntimeConversationItem): MobileConversationItem {
  const common = {
    id: item.id,
    ...(typeof item.at === "number" ? { at: item.at } : {}),
    ...(item.truncated === true ? { truncated: true as const } : {}),
    ...(typeof item.originalBytes === "number" ? { originalBytes: item.originalBytes } : {}),
  };
  switch (item.kind) {
    case "userMessage":
    case "systemNotice":
    case "error":
      return { ...common, kind: item.kind, content: item.content };
    case "assistantMessage":
    case "thinking":
      return {
        ...common,
        kind: item.kind,
        content: item.content,
        ...(item.runId ? { runId: item.runId } : {}),
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
    case "skill":
      return {
        ...common,
        kind: item.kind,
        name: item.name,
        args: item.args,
        trigger: item.trigger,
      };
    case "plan":
      return {
        ...common,
        kind: item.kind,
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.state ? { state: item.state } : {}),
      };
    case "tool":
      return {
        ...common,
        kind: item.kind,
        name: item.name,
        args: item.args,
        status: item.status,
        ...(item.summary ? { summary: item.summary } : {}),
      };
    case "runBoundary":
      return {
        ...common,
        kind: item.kind,
        ...(item.runId ? { runId: item.runId } : {}),
        status: item.status,
        startedAt: item.startedAt,
        ...(item.finishedAt !== undefined ? { finishedAt: item.finishedAt } : {}),
        ...(item.error ? { error: item.error } : {}),
      };
    case "approval":
    case "prompt":
    case "changes":
    case "goal":
      return {
        ...common,
        kind: item.kind,
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.state ? { state: item.state } : {}),
      };
    case "subagent":
      return {
        ...common,
        kind: item.kind,
        ...(item.name ? { name: item.name } : {}),
        title: item.title,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.state ? { state: item.state } : {}),
      };
  }
}
