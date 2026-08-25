import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { canonicalizeWorkspacePath, resolvePicoTemporaryWorkspace } from "../paths/pico-paths.js";

const TEMPORARY_WORKSPACE_MODE = 0o700;

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
}

/** Owns the fixed, Runtime-controlled workspace used when Desktop has no selected project. */
export class TemporaryWorkspaceAuthority {
  readonly workspacePath: string;
  private inFlight?: Promise<string>;

  constructor(private readonly options: TemporaryWorkspaceAuthorityOptions) {
    this.workspacePath = resolvePicoTemporaryWorkspace({ picoHome: options.picoHome });
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
    return (
      canonicalizeWorkspacePath(workspacePath) === canonicalizeWorkspacePath(this.workspacePath)
    );
  }

  private async ensureOnce(): Promise<string> {
    await this.prepareDirectory();
    const canonical = await realpath(this.workspacePath);
    const registered = await this.options.register(canonical);
    await this.options.trust(registered);
    return registered;
  }

  private async prepareDirectory(): Promise<void> {
    const before = await lstat(this.workspacePath).catch((error: unknown) => {
      if (isNodeCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (before) this.assertSafeDirectory(before);
    else await mkdir(this.workspacePath, { recursive: true, mode: TEMPORARY_WORKSPACE_MODE });

    const after = await lstat(this.workspacePath).catch((error: unknown) => {
      throw new TemporaryWorkspaceUnavailableError(
        `无法创建 Pico 临时工作区: ${this.workspacePath}`,
        { cause: error },
      );
    });
    this.assertSafeDirectory(after);
    await chmod(this.workspacePath, TEMPORARY_WORKSPACE_MODE);
  }

  private assertSafeDirectory(info: Awaited<ReturnType<typeof lstat>>): void {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TemporaryWorkspaceUnavailableError(
        `Pico 临时工作区必须是普通目录，不能是符号链接或其他文件: ${this.workspacePath}`,
      );
    }
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
