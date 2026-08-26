import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  canonicalizeWorkspacePath,
  resolvePicoHome,
  resolvePicoIsolatedTemporaryWorkspace,
  resolvePicoTemporaryWorkspace,
} from "../paths/pico-paths.js";

const TEMPORARY_WORKSPACE_MODE = 0o700;
const TEMPORARY_WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISOLATED_TEMPORARY_WORKSPACE_PATTERN =
  /^temporary-workspace-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class TemporaryWorkspaceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemporaryWorkspaceUnavailableError";
  }
}

export interface TemporaryWorkspaceAuthorityOptions {
  readonly picoHome: string;
  readonly register: (workspacePath: string) => Promise<string>;
  readonly trust: (workspacePath: string) => Promise<void>;
  readonly createId?: () => string;
}

/** Allocates one Runtime-controlled workspace for each Desktop task without a selected project. */
export class TemporaryWorkspaceAuthority {
  private inFlight?: Promise<string>;
  private readonly picoHome: string;
  private readonly legacyWorkspacePath: string;

  constructor(private readonly options: TemporaryWorkspaceAuthorityOptions) {
    this.picoHome = resolvePicoHome({ picoHome: options.picoHome });
    this.legacyWorkspacePath = resolvePicoTemporaryWorkspace({ picoHome: options.picoHome });
  }

  ensure(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    const operation = this.ensureOnce();
    this.inFlight = operation;
    const clear = () => {
      if (this.inFlight === operation) this.inFlight = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  matches(workspacePath: string): boolean {
    const canonical = canonicalizeWorkspacePath(workspacePath);
    if (canonical === canonicalizeWorkspacePath(this.legacyWorkspacePath)) return true;
    return (
      canonicalizeWorkspacePath(dirname(canonical)) === canonicalizeWorkspacePath(this.picoHome) &&
      ISOLATED_TEMPORARY_WORKSPACE_PATTERN.test(basename(canonical))
    );
  }

  private async ensureOnce(): Promise<string> {
    const instanceId = (this.options.createId ?? randomUUID)();
    if (!TEMPORARY_WORKSPACE_ID_PATTERN.test(instanceId)) {
      throw new TemporaryWorkspaceUnavailableError("Pico 临时工作区 ID 格式无效");
    }
    const workspacePath = resolvePicoIsolatedTemporaryWorkspace(instanceId, {
      picoHome: this.options.picoHome,
    });
    await this.prepareDirectory(workspacePath);
    const canonical = await realpath(workspacePath);
    const registered = await this.options.register(canonical);
    await this.options.trust(registered);
    return registered;
  }

  private async prepareDirectory(workspacePath: string): Promise<void> {
    await mkdir(this.options.picoHome, { recursive: true, mode: TEMPORARY_WORKSPACE_MODE });
    await mkdir(workspacePath, { mode: TEMPORARY_WORKSPACE_MODE }).catch((error: unknown) => {
      throw new TemporaryWorkspaceUnavailableError(
        `无法创建独立的 Pico 临时工作区: ${workspacePath}`,
        { cause: error },
      );
    });

    const after = await lstat(workspacePath).catch((error: unknown) => {
      throw new TemporaryWorkspaceUnavailableError(`无法验证 Pico 临时工作区: ${workspacePath}`, {
        cause: error,
      });
    });
    this.assertSafeDirectory(after, workspacePath);
    await chmod(workspacePath, TEMPORARY_WORKSPACE_MODE);
  }

  private assertSafeDirectory(
    info: Awaited<ReturnType<typeof lstat>>,
    workspacePath: string,
  ): void {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TemporaryWorkspaceUnavailableError(
        `Pico 临时工作区必须是普通目录，不能是符号链接或其他文件: ${workspacePath}`,
      );
    }
  }
}
