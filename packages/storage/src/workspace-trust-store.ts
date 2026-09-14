import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const TRUST_STORE_VERSION = 1 as const;
const TRUST_DIRECTORY_MODE = 0o700;
const TRUST_FILE_MODE = 0o600;

export interface WorkspaceTrustStoreOptions {
  /** Host-owned user state directory; Storage never resolves a product home itself. */
  readonly userStateDirectory: string;
  readonly now?: () => Date;
}

interface TrustedWorkspaceRecord {
  readonly path: string;
  readonly trustedAt: string;
}

interface WorkspaceTrustFile {
  readonly version: typeof TRUST_STORE_VERSION;
  readonly workspaces: readonly TrustedWorkspaceRecord[];
}

/**
 * Durable user-level workspace trust store.  It protects file mode, symlink
 * shape, atomic publication, and concurrent mutations; trust policy belongs
 * to the Host layer.
 */
export class WorkspaceTrustStore {
  readonly directoryPath: string;
  readonly filePath: string;
  private readonly now: () => Date;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceTrustStoreOptions) {
    this.directoryPath = options.userStateDirectory;
    this.filePath = join(this.directoryPath, "trusted-workspaces.json");
    this.now = options.now ?? (() => new Date());
  }

  canonicalize(workspacePath: string): Promise<string> {
    return realpath(workspacePath);
  }

  async isTrusted(canonicalWorkspacePath: string): Promise<boolean> {
    const state = await this.read();
    return state.workspaces.some((record) => record.path === canonicalWorkspacePath);
  }

  async trust(canonicalWorkspacePath: string): Promise<void> {
    await this.setTrusted(canonicalWorkspacePath, true);
  }

  async setTrusted(canonicalWorkspacePath: string, trusted: boolean): Promise<void> {
    if (!isAbsolute(canonicalWorkspacePath)) {
      throw new Error(`工作区信任记录必须使用绝对真实路径: ${canonicalWorkspacePath}`);
    }
    const operation = async () => {
      const state = await this.read();
      const exists = state.workspaces.some((record) => record.path === canonicalWorkspacePath);
      if (exists === trusted) return;

      const workspaces = trusted
        ? [
            ...state.workspaces,
            { path: canonicalWorkspacePath, trustedAt: this.now().toISOString() },
          ]
        : state.workspaces.filter((record) => record.path !== canonicalWorkspacePath);
      await this.write({ version: TRUST_STORE_VERSION, workspaces });
    };
    const queued = this.mutationQueue.then(operation, operation);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  private async read(): Promise<WorkspaceTrustFile> {
    await this.secureDirectory();
    let info;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return emptyTrustFile();
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`工作区信任库必须是普通文件，不能是符号链接: ${this.filePath}`);
    }
    await chmod(this.filePath, TRUST_FILE_MODE);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`无法读取工作区信任库 ${this.filePath}；为避免误信任已停止启动`, {
        cause: error,
      });
    }
    return parseTrustFile(parsed, this.filePath);
  }

  private async write(state: WorkspaceTrustFile): Promise<void> {
    await this.secureDirectory();
    const temporaryPath = join(
      this.directoryPath,
      `.trusted-workspaces.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: TRUST_FILE_MODE,
      });
      await chmod(temporaryPath, TRUST_FILE_MODE);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, TRUST_FILE_MODE);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      });
    }
  }

  private async secureDirectory(): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true, mode: TRUST_DIRECTORY_MODE });
    const info = await lstat(this.directoryPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`工作区信任状态目录必须是普通目录，不能是符号链接: ${this.directoryPath}`);
    }
    await chmod(this.directoryPath, TRUST_DIRECTORY_MODE);
  }
}

function emptyTrustFile(): WorkspaceTrustFile {
  return { version: TRUST_STORE_VERSION, workspaces: [] };
}

function parseTrustFile(value: unknown, filePath: string): WorkspaceTrustFile {
  if (!isRecord(value) || value["version"] !== TRUST_STORE_VERSION) {
    throw new Error(`工作区信任库格式无效: ${filePath}`);
  }
  const workspaces = value["workspaces"];
  if (!Array.isArray(workspaces)) {
    throw new Error(`工作区信任库缺少 workspaces 数组: ${filePath}`);
  }

  const records: TrustedWorkspaceRecord[] = [];
  for (const entry of workspaces) {
    if (
      !isRecord(entry) ||
      typeof entry["path"] !== "string" ||
      !isAbsolute(entry["path"]) ||
      typeof entry["trustedAt"] !== "string" ||
      Number.isNaN(Date.parse(entry["trustedAt"]))
    ) {
      throw new Error(`工作区信任库包含无效记录: ${filePath}`);
    }
    records.push({ path: entry["path"], trustedAt: entry["trustedAt"] });
  }
  return { version: TRUST_STORE_VERSION, workspaces: records };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}
