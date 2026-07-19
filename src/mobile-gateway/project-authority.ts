import { createHmac, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { MobileProject, MobileProjectId, WorkspaceStatusResult } from "@pico/protocol";
import type { RuntimeClient } from "../daemon/client.js";

const PROJECT_ID_SECRET_BYTES = 32;

export interface MobileProjectAuthorityPort {
  listWorkspaces(): Promise<readonly WorkspaceStatusResult[]>;
  isWorkspaceTrusted(workspacePath: string): Promise<boolean>;
}

export class MobileProjectAccessError extends Error {
  readonly code = "PROJECT_NOT_FOUND";

  constructor() {
    super("Mobile project was not found");
    this.name = "MobileProjectAccessError";
  }
}

/**
 * Maps registered, trusted workspace paths to per-Gateway opaque identifiers.
 * The mapping is rebuilt for every access so revoking trust takes effect before
 * the next Runtime call.
 */
export class MobileProjectAuthority {
  private readonly secret: Uint8Array;

  constructor(
    private readonly port: MobileProjectAuthorityPort,
    secret: Uint8Array = randomBytes(PROJECT_ID_SECRET_BYTES),
  ) {
    if (secret.byteLength < PROJECT_ID_SECRET_BYTES) {
      throw new Error(
        `Mobile project secret must contain at least ${PROJECT_ID_SECRET_BYTES} bytes`,
      );
    }
    this.secret = secret;
  }

  async listProjects(): Promise<readonly MobileProject[]> {
    return (await this.loadAuthorizedProjects()).map(({ project }) => project);
  }

  async resolveProjectPath(projectId: MobileProjectId): Promise<string> {
    const authorized = await this.loadAuthorizedProjects();
    const match = authorized.find((entry) => entry.project.projectId === projectId);
    if (!match) throw new MobileProjectAccessError();
    return match.workspacePath;
  }

  private async loadAuthorizedProjects(): Promise<readonly AuthorizedProject[]> {
    const registered = (await this.port.listWorkspaces()).filter(
      (workspace) => workspace.registered,
    );
    const authorized = await Promise.all(
      registered.map(async (workspace): Promise<AuthorizedProject | undefined> => {
        if (!(await this.port.isWorkspaceTrusted(workspace.workspacePath))) return undefined;
        return {
          workspacePath: workspace.workspacePath,
          project: {
            projectId: this.projectIdFor(workspace.workspacePath),
            name: basename(workspace.workspacePath),
          },
        };
      }),
    );
    return authorized.filter((entry): entry is AuthorizedProject => entry !== undefined);
  }

  private projectIdFor(workspacePath: string): MobileProjectId {
    return createHmac("sha256", this.secret)
      .update(workspacePath)
      .digest("base64url") as MobileProjectId;
  }
}

interface AuthorizedProject {
  readonly workspacePath: string;
  readonly project: MobileProject;
}

export function createMobileProjectAuthorityPort(
  client: Pick<RuntimeClient, "request">,
): MobileProjectAuthorityPort {
  return {
    async listWorkspaces() {
      return (await client.request("workspace.list", {})).workspaces;
    },
    async isWorkspaceTrusted(workspacePath) {
      return (await client.request("workspace.trustStatus", { workspacePath })).trusted;
    },
  };
}
