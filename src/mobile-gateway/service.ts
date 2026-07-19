import type { MobileProject, MobileProjectId, MobileSession, RuntimeSession } from "@pico/protocol";
import type { RuntimeClient } from "../daemon/client.js";
import type { MobileProjectAuthority } from "./project-authority.js";

export interface MobileGatewayApi {
  listProjects(): Promise<readonly MobileProject[]>;
  listSessions(projectId: MobileProjectId): Promise<readonly MobileSession[]>;
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
