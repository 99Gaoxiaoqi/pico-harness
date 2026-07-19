import type {
  MobileConversationItem,
  MobileProject,
  MobileProjectId,
  MobileRealtimeEvent,
  MobileRun,
  MobileSendMessageBody,
  MobileSendMessageResult,
  MobileSession,
  MobileTranscript,
  RuntimeConversationItem,
  RuntimeNotification,
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
  sendMessage(
    projectId: MobileProjectId,
    body: MobileSendMessageBody,
  ): Promise<MobileSendMessageResult>;
}

export interface MobileGatewayRealtimeApi {
  subscribeEvents(
    projectId: MobileProjectId,
    sessionId: SessionId,
    listener: (event: MobileRealtimeEvent) => void,
  ): Promise<{ readonly dispose: () => void }>;
}

export class MobileGatewayService implements MobileGatewayApi {
  constructor(
    private readonly authority: Pick<MobileProjectAuthority, "listProjects" | "resolveProjectPath">,
    private readonly runtime: Pick<RuntimeClient, "request"> &
      Partial<Pick<RuntimeClient, "subscribe">>,
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

  async sendMessage(
    projectId: MobileProjectId,
    body: MobileSendMessageBody,
  ): Promise<MobileSendMessageResult> {
    const workspacePath = await this.authority.resolveProjectPath(projectId);
    if (body.sessionId) {
      const current = await this.runtime.request("session.get", {
        workspacePath,
        sessionId: body.sessionId,
      });
      const session = toMobileSession(current.session, workspacePath);
      if (session.sessionId !== body.sessionId) {
        throw new Error("Runtime returned another session before Mobile send");
      }
    }
    const result = await this.runtime.request("session.send", {
      workspacePath,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      input: { kind: "text", text: body.text },
      idempotencyKey: body.idempotencyKey,
    });
    const session = toMobileSession(result.session, workspacePath);
    if (body.sessionId && session.sessionId !== body.sessionId) {
      throw new Error("Runtime returned another session after Mobile send");
    }
    return {
      session,
      ...(result.run ? { run: toMobileRun(result.run, workspacePath, session.sessionId) } : {}),
      disposition: result.disposition,
    };
  }

  async subscribeEvents(
    projectId: MobileProjectId,
    sessionId: SessionId,
    listener: (event: MobileRealtimeEvent) => void,
  ): Promise<{ readonly dispose: () => void }> {
    if (!this.runtime.subscribe) throw new Error("Runtime event subscription is unavailable");
    const workspacePath = await this.authority.resolveProjectPath(projectId);
    const current = await this.runtime.request("session.get", { workspacePath, sessionId });
    const session = toMobileSession(current.session, workspacePath);
    if (session.sessionId !== sessionId) {
      throw new Error("Runtime returned another session before Mobile subscription");
    }

    const deliver = (notification: RuntimeNotification) => {
      const event = safeProjectRealtimeEvent(notification, workspacePath, sessionId);
      if (event) listener(event);
    };
    const subscription = await this.runtime.subscribe({ workspacePath }, deliver);
    return { dispose: subscription.dispose };
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

function safeProjectRealtimeEvent(
  notification: RuntimeNotification,
  workspacePath: string,
  sessionId: SessionId,
): MobileRealtimeEvent | undefined {
  if (
    notification.scope.workspacePath !== workspacePath ||
    notification.scope.sessionId !== sessionId
  ) {
    return undefined;
  }
  try {
    switch (notification.topic) {
      case "run.started":
      case "run.updated":
      case "run.finished": {
        const typed = notification as RuntimeNotification<
          "run.started" | "run.updated" | "run.finished"
        >;
        return { type: "run", run: toMobileRun(typed.payload.run, workspacePath, sessionId) };
      }
      case "run.live": {
        const typed = notification as RuntimeNotification<"run.live">;
        return {
          type: "live",
          runId: typed.payload.runId,
          item: {
            kind: typed.payload.item.kind,
            operation: typed.payload.item.operation,
            ...(typed.payload.item.streamId ? { streamId: typed.payload.item.streamId } : {}),
            ...(typed.payload.item.turnId ? { turnId: typed.payload.item.turnId } : {}),
            ...(typed.payload.item.delta !== undefined ? { delta: typed.payload.item.delta } : {}),
            ...(typed.payload.item.truncated === true ? { truncated: true } : {}),
          },
        };
      }
      case "session.transcriptUpdated": {
        const typed = notification as RuntimeNotification<"session.transcriptUpdated">;
        if (typed.payload.sessionId !== sessionId) return undefined;
        return {
          type: "transcriptUpdated",
          sessionId,
          ...(typed.payload.revision ? { revision: typed.payload.revision } : {}),
        };
      }
      default:
        return undefined;
    }
  } catch {
    return { type: "resync", reason: "unknown" };
  }
}
