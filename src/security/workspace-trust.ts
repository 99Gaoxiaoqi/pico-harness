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
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const TRUST_STORE_VERSION = 1 as const;
const TRUST_DIRECTORY_MODE = 0o700;
const TRUST_FILE_MODE = 0o600;

export const WORKSPACE_TRUST_RISKS = Object.freeze([
  "读取 AGENTS.md 以及项目 Skills，并把它们作为 Agent 指令",
  "启动 .pico/config.json 配置的 LSP 进程和 Provider 端点",
  "启动 .claw 配置的 MCP 服务与 Hook 命令",
  "使用项目配置的凭证环境变量和额外工作区目录",
] as const);

export type WorkspaceTrustDecision = "trust" | "deny";

export interface WorkspaceTrustPromptRequest {
  readonly workspacePath: string;
  readonly risks: readonly string[];
}

/**
 * 由宿主提供的交互端口。业务层不依赖 readline，测试和其他宿主可以注入自己的 UI。
 */
export interface WorkspaceTrustPrompt {
  requestTrust(request: WorkspaceTrustPromptRequest): Promise<WorkspaceTrustDecision>;
}

export interface WorkspaceTrustStoreOptions {
  /** 只由宿主注入的用户状态目录；生产默认为 ~/.pico。 */
  readonly userStateDirectory?: string;
  readonly now?: () => Date;
}

export interface EnsureWorkspaceTrustedOptions {
  readonly store?: WorkspaceTrustStore;
  /** 未提供 prompt 即表示当前为非交互环境，必须 fail-closed。 */
  readonly prompt?: WorkspaceTrustPrompt;
}

export type WorkspaceTrustResult =
  | { readonly status: "already-trusted"; readonly workspacePath: string }
  | { readonly status: "trusted-now"; readonly workspacePath: string };

interface TrustedWorkspaceRecord {
  readonly path: string;
  readonly trustedAt: string;
}

interface WorkspaceTrustFile {
  readonly version: typeof TRUST_STORE_VERSION;
  readonly workspaces: readonly TrustedWorkspaceRecord[];
}

/**
 * 用户级工作区信任库。项目内配置没有任何声明或改写信任的入口。
 */
export class WorkspaceTrustStore {
  readonly directoryPath: string;
  readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: WorkspaceTrustStoreOptions = {}) {
    this.directoryPath = options.userStateDirectory ?? join(homedir(), ".pico");
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
    if (!isAbsolute(canonicalWorkspacePath)) {
      throw new Error(`工作区信任记录必须使用绝对真实路径: ${canonicalWorkspacePath}`);
    }
    const state = await this.read();
    if (state.workspaces.some((record) => record.path === canonicalWorkspacePath)) return;

    const next = {
      version: TRUST_STORE_VERSION,
      workspaces: [
        ...state.workspaces,
        { path: canonicalWorkspacePath, trustedAt: this.now().toISOString() },
      ],
    } satisfies WorkspaceTrustFile;
    await this.write(next);
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

/**
 * 在任何项目级配置或指令被读取之前调用。
 */
export async function ensureWorkspaceTrusted(
  workspacePath: string,
  options: EnsureWorkspaceTrustedOptions = {},
): Promise<WorkspaceTrustResult> {
  const store = options.store ?? new WorkspaceTrustStore();
  const canonicalWorkspacePath = await store.canonicalize(workspacePath);
  if (await store.isTrusted(canonicalWorkspacePath)) {
    return { status: "already-trusted", workspacePath: canonicalWorkspacePath };
  }

  if (!options.prompt) {
    throw new Error(
      `工作区尚未信任: ${canonicalWorkspacePath}。非交互环境不会自动信任项目；请先在交互式终端运行 pico 并确认工作区信任。`,
    );
  }

  const decision = await options.prompt.requestTrust({
    workspacePath: canonicalWorkspacePath,
    risks: WORKSPACE_TRUST_RISKS,
  });
  if (decision !== "trust") {
    throw new Error(`已取消启动：工作区未被信任 (${canonicalWorkspacePath})`);
  }

  await store.trust(canonicalWorkspacePath);
  return { status: "trusted-now", workspacePath: canonicalWorkspacePath };
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
