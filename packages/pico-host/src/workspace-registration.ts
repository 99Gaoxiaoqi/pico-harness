import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isPicoIsolatedTemporaryWorkspace, resolvePicoHome } from "./pico-paths.js";
import { logger } from "./logger.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VERSION = 2 as const;
const LEGACY_VERSION = 1 as const;

interface RegisteredWorkspace {
  readonly workspacePath: string;
  readonly projectId: string | null;
}

interface RegisteredProject {
  readonly projectId: string;
  readonly name: string;
  readonly identity: string;
  readonly gitIdentityPending?: true;
}

interface ProjectRegistryState {
  readonly version: typeof VERSION;
  readonly projects: readonly RegisteredProject[];
  readonly workspaces: readonly RegisteredWorkspace[];
}

export interface WorkspaceProjectMetadata {
  readonly projectId: string | null;
  readonly projectName: string | null;
}

/** User-level discovery index; authoritative Jobs/Runs remain in each workspace Runtime store. */
export class WorkspaceRegistrationStore {
  readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly diagnosticMessages: string[] = [];
  private legacyFallback:
    | { readonly source: string; readonly state: ProjectRegistryState }
    | undefined;

  constructor(filePath = join(resolvePicoHome(), "daemon-workspaces.json")) {
    this.filePath = filePath;
  }

  /** Paths remain per-worktree Runtime identities; projects are only a discovery/grouping layer. */
  async list(): Promise<readonly string[]> {
    return (await this.listRegistrations()).map((entry) => entry.workspacePath);
  }

  async listRegistrations(): Promise<readonly (RegisteredWorkspace & WorkspaceProjectMetadata)[]> {
    let registrations: readonly (RegisteredWorkspace & WorkspaceProjectMetadata)[] = [];
    await this.mutate(async () => {
      const readState = await this.read();
      const { state, changed } = await reconcilePendingProjects(
        readState,
        dirname(this.filePath),
        (message) => this.addDiagnostic(message),
      );
      if (changed) await this.write(state);
      const persistedWorkspaces = await normalizeRegistrations(
        state.workspaces,
        dirname(this.filePath),
      );
      if (!sameRegistrations(state.workspaces, persistedWorkspaces)) {
        await this.write({ ...state, workspaces: persistedWorkspaces });
      }
      const availableWorkspaces = await normalizeRegistrations(
        persistedWorkspaces,
        dirname(this.filePath),
        true,
      );
      registrations = availableWorkspaces.map((workspace) => ({
        ...workspace,
        ...projectMetadata(state, workspace.projectId),
      }));
    });
    return registrations;
  }

  async projectMetadata(workspacePath: string): Promise<WorkspaceProjectMetadata> {
    const candidates = await unregisterCandidates(workspacePath, dirname(this.filePath));
    let metadata: WorkspaceProjectMetadata = { projectId: null, projectName: null };
    await this.mutate(async () => {
      const readState = await this.read();
      const { state, changed } = await reconcilePendingProjects(
        readState,
        dirname(this.filePath),
        (message) => this.addDiagnostic(message),
      );
      if (changed) await this.write(state);
      const normalized = await normalizeRegistrations(state.workspaces, dirname(this.filePath));
      const entry = normalized.find((candidate) => candidates.includes(candidate.workspacePath));
      metadata = projectMetadata(state, entry?.projectId ?? null);
    });
    return metadata;
  }

  async register(workspacePath: string): Promise<string> {
    const picoHome = dirname(this.filePath);
    const canonical = await canonicalizeWorkspacePath(workspacePath, picoHome);
    const identity = await resolveProjectIdentity(canonical, picoHome, (message) =>
      this.addDiagnostic(message),
    );
    await this.mutate(async () => {
      const readState = await this.read();
      const { state: reconciledState } = await reconcilePendingProjects(
        readState,
        picoHome,
        (message) => this.addDiagnostic(message),
      );
      const state = reconciledState;
      const workspaces = await normalizeRegistrations(state.workspaces, picoHome);
      const existingWorkspace = workspaces.find((entry) => entry.workspacePath === canonical);
      const projects = [...state.projects];
      let projectId: string | null = null;
      if (identity) {
        const matchingProject = projects.find((project) => project.identity === identity.identity);
        const priorProject = existingWorkspace?.projectId
          ? projects.find((project) => project.projectId === existingWorkspace.projectId)
          : undefined;
        const project =
          matchingProject ?? (identity.gitIdentityPending ? priorProject : undefined);
        if (project) {
          projectId = project.projectId;
          const index = projects.findIndex(
            (candidate) => candidate.projectId === project.projectId,
          );
          const { gitIdentityPending: _pending, ...resolvedProject } = project;
          projects[index] = { ...resolvedProject, ...identity };
        } else {
          projectId = randomUUID();
          projects.push({ projectId, ...identity });
        }
      }
      const nextWorkspaces = [
        ...workspaces.filter((entry) => entry.workspacePath !== canonical),
        { workspacePath: canonical, projectId },
      ].sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
      await this.write({ version: VERSION, projects, workspaces: nextWorkspaces });
    });
    return canonical;
  }

  async unregister(workspacePath: string): Promise<string> {
    const candidates = await unregisterCandidates(workspacePath, dirname(this.filePath));
    let canonical = candidates[0] ?? resolve(workspacePath);
    await this.mutate(async () => {
      const readState = await this.read();
      const { state, changed } = await reconcilePendingProjects(
        readState,
        dirname(this.filePath),
        (message) => this.addDiagnostic(message),
      );
      if (changed) await this.write(state);
      const normalized = await normalizeRegistrations(state.workspaces, dirname(this.filePath));
      canonical =
        candidates.find((candidate) =>
          normalized.some((entry) => entry.workspacePath === candidate),
        ) ?? canonical;
      const workspaces = normalized.filter((entry) => !candidates.includes(entry.workspacePath));
      if (!sameRegistrations(state.workspaces, workspaces)) {
        // Keep the project record so re-registering a worktree retains its identity.
        await this.write({ ...state, workspaces });
      }
    });
    return canonical;
  }

  async resolveRegisteredPath(workspacePath: string): Promise<string> {
    const candidates = await unregisterCandidates(workspacePath, dirname(this.filePath));
    let canonical = candidates[0] ?? resolve(workspacePath);
    await this.mutate(async () => {
      const state = await this.read();
      const normalized = await normalizeRegistrations(state.workspaces, dirname(this.filePath));
      canonical =
        candidates.find((candidate) =>
          normalized.some((entry) => entry.workspacePath === candidate),
        ) ?? canonical;
    });
    return canonical;
  }

  /** Git discovery and migration fallbacks are inspectable by host diagnostics. */
  diagnostics(): readonly string[] {
    return [...this.diagnosticMessages];
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutationQueue.then(operation, operation);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  private async read(): Promise<ProjectRegistryState> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIRECTORY_MODE });
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { version: VERSION, projects: [], workspaces: [] };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(`daemon workspace registry JSON 无效: ${this.filePath}`, { cause: error });
    }
    if (isProjectRegistryState(value)) return value;
    if (!isLegacyState(value)) {
      throw new Error(`daemon workspace registry 格式无效: ${this.filePath}`);
    }

    const state =
      this.legacyFallback?.source === source
        ? cloneState(this.legacyFallback.state)
        : await this.migrateLegacy(value.workspaces);
    try {
      await this.write(state);
      this.legacyFallback = undefined;
    } catch (error) {
      // Keep the v1 file intact. In-memory grouping remains available and a later
      // access retries the atomic migration; stable fallback IDs are reused meanwhile.
      this.addDiagnostic(
        `项目注册表迁移写入失败，保留旧文件并将在后续访问重试：${errorMessage(error)}`,
      );
      this.legacyFallback = { source, state: cloneState(state) };
    }
    return state;
  }

  private async migrateLegacy(paths: readonly string[]): Promise<ProjectRegistryState> {
    const normalized = await normalizeRegistrations(
      paths.map((workspacePath) => ({ workspacePath, projectId: null })),
      dirname(this.filePath),
    );
    const projects = new Map<string, RegisteredProject>();
    const workspaces: RegisteredWorkspace[] = [];
    for (const entry of normalized) {
      const identity = await resolveProjectIdentity(
        entry.workspacePath,
        dirname(this.filePath),
        (message) => this.addDiagnostic(message),
      );
      if (!identity) {
        workspaces.push({ workspacePath: entry.workspacePath, projectId: null });
        continue;
      }
      let project = projects.get(identity.identity);
      if (!project) {
        project = { projectId: randomUUID(), ...identity };
        projects.set(identity.identity, project);
      }
      workspaces.push({ workspacePath: entry.workspacePath, projectId: project.projectId });
    }
    return {
      version: VERSION,
      projects: [...projects.values()].sort((left, right) =>
        left.projectId.localeCompare(right.projectId),
      ),
      workspaces,
    };
  }

  private addDiagnostic(message: string): void {
    if (this.diagnosticMessages.includes(message)) return;
    this.diagnosticMessages.push(message);
    logger.warn(
      { registryPath: this.filePath, diagnostic: message },
      "Workspace project registry fallback",
    );
  }

  private async write(state: ProjectRegistryState): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      await chmod(temporary, FILE_MODE);
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }
}

async function resolveProjectIdentity(
  workspacePath: string,
  picoHome: string,
  report: (message: string) => void,
): Promise<Omit<RegisteredProject, "projectId"> | undefined> {
  if (isPicoIsolatedTemporaryWorkspace(workspacePath, { picoHome })) return undefined;
  const git = await resolveGitCommonDirectory(workspacePath, report);
  if (git.kind === "git") {
    return {
      name: basename(dirname(git.commonDirectory)),
      identity: `git:${git.commonDirectory}`,
    };
  }
  return {
    name: basename(workspacePath) || workspacePath,
    identity: `folder:${workspacePath}`,
    ...(git.kind === "unavailable" ? { gitIdentityPending: true as const } : {}),
  };
}

type GitCommonDirectoryResult =
  | { readonly kind: "git"; readonly commonDirectory: string }
  | { readonly kind: "folder" }
  | { readonly kind: "unavailable" };

function resolveGitCommonDirectory(
  workspacePath: string,
  report: (message: string) => void,
): Promise<GitCommonDirectoryResult> {
  return new Promise((resolveResult) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    );
    execFile(
      "git",
      ["rev-parse", "--git-common-dir"],
      {
        cwd: workspacePath,
        encoding: "utf8",
        env: { ...environment, LANG: "C", LC_ALL: "C" },
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          if (/not a git repository/iu.test(detail)) {
            resolveResult({ kind: "folder" });
            return;
          }
          report(
            `无法识别工作区 Git common directory，暂按独立路径项目处理：${workspacePath} (${detail})`,
          );
          resolveResult({ kind: "unavailable" });
          return;
        }
        const output = stdout.trim();
        if (!output) {
          report(`Git 未返回 common directory，暂按独立路径项目处理：${workspacePath}`);
          resolveResult({ kind: "unavailable" });
          return;
        }
        void realpath(resolve(workspacePath, output)).then(
          (physical) => resolveResult({ kind: "git", commonDirectory: normalizePath(physical) }),
          (cause: unknown) => {
            report(
              `无法规范化 Git common directory，暂按独立路径项目处理：${workspacePath} (${errorMessage(cause)})`,
            );
            resolveResult({ kind: "unavailable" });
          },
        );
      },
    );
  });
}

async function reconcilePendingProjects(
  state: ProjectRegistryState,
  picoHome: string,
  report: (message: string) => void,
): Promise<{ readonly state: ProjectRegistryState; readonly changed: boolean }> {
  const projects = state.projects.map((project) => ({ ...project }));
  const workspaces = state.workspaces.map((workspace) => ({ ...workspace }));
  const reassignments = new Map<string, string | null>();
  let changed = false;

  for (const pending of state.projects.filter((project) => project.gitIdentityPending === true)) {
    const associated = workspaces.filter((workspace) => workspace.projectId === pending.projectId);
    for (const workspace of associated) {
      const identity = await resolveProjectIdentity(workspace.workspacePath, picoHome, report);
      if (!identity) {
        reassignments.set(pending.projectId, null);
        changed = true;
        break;
      }
      if (identity.gitIdentityPending) continue;

      const matchingProject = projects.find(
        (project) =>
          project.projectId !== pending.projectId &&
          project.gitIdentityPending !== true &&
          project.identity === identity.identity,
      );
      if (matchingProject) {
        reassignments.set(pending.projectId, matchingProject.projectId);
        changed = true;
      } else {
        const index = projects.findIndex((project) => project.projectId === pending.projectId);
        if (index >= 0) {
          const { gitIdentityPending: _pending, ...resolvedProject } = projects[index]!;
          projects[index] = { ...resolvedProject, ...identity };
          changed = true;
        }
      }
      break;
    }
  }

  if (reassignments.size > 0) {
    for (let index = 0; index < workspaces.length; index += 1) {
      const workspace = workspaces[index]!;
      if (!workspace.projectId || !reassignments.has(workspace.projectId)) continue;
      workspaces[index] = { ...workspace, projectId: reassignments.get(workspace.projectId)! };
    }
  }
  return changed
    ? { state: { version: VERSION, projects, workspaces }, changed: true }
    : { state, changed: false };
}

async function unregisterCandidates(workspacePath: string, picoHome: string): Promise<string[]> {
  const absolute = resolve(workspacePath);
  try {
    return [await canonicalizeWorkspacePath(absolute, picoHome)];
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const ancestor = await nearestExistingAncestor(absolute);
  if (!ancestor) return [absolute];
  const canonicalAncestor = await canonicalizeWorkspacePath(ancestor.physical, picoHome);
  const physicalTarget = resolve(ancestor.physical, relative(ancestor.logical, absolute));
  return [...new Set([canonicalAncestor, physicalTarget, absolute])];
}

async function nearestExistingAncestor(
  input: string,
): Promise<{ logical: string; physical: string } | undefined> {
  let candidate = input;
  while (true) {
    try {
      return { logical: candidate, physical: await realpath(candidate) };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function normalizeRegistrations(
  entries: readonly RegisteredWorkspace[],
  picoHome: string,
  dropMissing = false,
): Promise<RegisteredWorkspace[]> {
  const normalized = await Promise.all(
    entries.map(async (entry) => {
      try {
        return {
          workspacePath: await canonicalizeWorkspacePath(entry.workspacePath, picoHome),
          projectId: entry.projectId,
        };
      } catch (error) {
        if (dropMissing && isErrno(error, "ENOENT")) return undefined;
        if (isErrno(error, "ENOENT")) {
          return {
            workspacePath: normalizePath(resolve(entry.workspacePath)),
            projectId: entry.projectId,
          };
        }
        throw error;
      }
    }),
  );
  const byPath = new Map<string, RegisteredWorkspace>();
  for (const entry of normalized) {
    if (entry && !byPath.has(entry.workspacePath)) byPath.set(entry.workspacePath, entry);
  }
  return [...byPath.values()].sort((left, right) =>
    left.workspacePath.localeCompare(right.workspacePath),
  );
}

function projectMetadata(
  state: ProjectRegistryState,
  projectId: string | null,
): WorkspaceProjectMetadata {
  if (!projectId) return { projectId: null, projectName: null };
  const project = state.projects.find((candidate) => candidate.projectId === projectId);
  return project
    ? { projectId: project.projectId, projectName: project.name }
    : { projectId: null, projectName: null };
}

function normalizePath(path: string): string {
  const normalized = resolve(path).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameRegistrations(
  left: readonly RegisteredWorkspace[],
  right: readonly RegisteredWorkspace[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.workspacePath === right[index]?.workspacePath &&
        entry.projectId === right[index]?.projectId,
    )
  );
}

function cloneState(state: ProjectRegistryState): ProjectRegistryState {
  return {
    version: VERSION,
    projects: state.projects.map((project) => ({ ...project })),
    workspaces: state.workspaces.map((workspace) => ({ ...workspace })),
  };
}

function isLegacyState(
  value: unknown,
): value is { version: typeof LEGACY_VERSION; workspaces: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === LEGACY_VERSION &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    (value as { workspaces: unknown[] }).workspaces.every((path) => typeof path === "string")
  );
}

function isProjectRegistryState(value: unknown): value is ProjectRegistryState {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== VERSION ||
    !Array.isArray((value as { projects?: unknown }).projects) ||
    !Array.isArray((value as { workspaces?: unknown }).workspaces)
  ) {
    return false;
  }
  const projects = (value as { projects: unknown[] }).projects;
  const workspaces = (value as { workspaces: unknown[] }).workspaces;
  if (
    !projects.every(
      (project) =>
        typeof project === "object" &&
        project !== null &&
        typeof (project as RegisteredProject).projectId === "string" &&
        typeof (project as RegisteredProject).name === "string" &&
        typeof (project as RegisteredProject).identity === "string" &&
        ((project as RegisteredProject).gitIdentityPending === undefined ||
          (project as RegisteredProject).gitIdentityPending === true),
    ) ||
    !workspaces.every(
      (workspace) =>
        typeof workspace === "object" &&
        workspace !== null &&
        typeof (workspace as RegisteredWorkspace).workspacePath === "string" &&
        ((workspace as RegisteredWorkspace).projectId === null ||
          typeof (workspace as RegisteredWorkspace).projectId === "string"),
    )
  ) {
    return false;
  }
  const projectIds = new Set(projects.map((project) => (project as RegisteredProject).projectId));
  return workspaces.every(
    (workspace) =>
      (workspace as RegisteredWorkspace).projectId === null ||
      projectIds.has((workspace as RegisteredWorkspace).projectId!),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
