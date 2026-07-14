import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";

export type ResourceOrigin = "claude-compat" | "legacy" | "pico-native" | "runtime-state";
export type ResourceStatus = "missing" | "present" | "unsafe";

export interface ResourceDiagnosticEntry {
  readonly kind: string;
  readonly origin: ResourceOrigin;
  readonly path: string;
  readonly status: ResourceStatus;
  readonly authority: boolean;
  readonly reason?: string;
}

export interface ResourceDoctorReport {
  readonly workDir: string;
  readonly picoHome: string;
  readonly workspaceStateRoot: string;
  readonly entries: readonly ResourceDiagnosticEntry[];
  readonly findings: readonly string[];
}

export interface ResourceDoctorOptions {
  readonly workDir: string;
  readonly picoHome?: string;
  readonly homeDir?: string;
}

interface ResourceCandidate {
  readonly kind: string;
  readonly origin: ResourceOrigin;
  readonly path: string;
  readonly boundary: string;
  readonly rank: number;
}

/** Read-only resource authority report. It never parses prompts or starts extensions. */
export class ResourceDoctor {
  constructor(private readonly options: ResourceDoctorOptions) {}

  async scan(): Promise<ResourceDoctorReport> {
    const home = this.options.homeDir ?? homedir();
    const paths = resolvePicoPaths(this.options.workDir, {
      homeDir: home,
      ...(this.options.picoHome ? { picoHome: this.options.picoHome } : {}),
    });
    const claudeProject = join(paths.canonicalWorkDir, ".claude");
    const claudeUser = join(home, ".claude");
    const legacyRoot = join(paths.canonicalWorkDir, ".claw");
    const candidates: ResourceCandidate[] = [
      candidate("commands", "pico-native", paths.project.commands, paths.project.root, 40),
      candidate("commands", "claude-compat", join(claudeProject, "commands"), claudeProject, 30),
      candidate("commands", "pico-native", paths.home.commands, paths.home.root, 20),
      candidate("commands", "claude-compat", join(claudeUser, "commands"), claudeUser, 10),
      candidate("skills", "pico-native", paths.project.skills, paths.project.root, 40),
      candidate("skills", "claude-compat", join(claudeProject, "skills"), claudeProject, 30),
      candidate("skills", "pico-native", paths.home.skills, paths.home.root, 20),
      candidate("skills", "claude-compat", join(claudeUser, "skills"), claudeUser, 10),
      candidate("agents", "pico-native", paths.project.agents, paths.project.root, 40),
      candidate("agents", "claude-compat", join(claudeProject, "agents"), claudeProject, 30),
      candidate("agents", "pico-native", paths.home.agents, paths.home.root, 20),
      candidate("agents", "claude-compat", join(claudeUser, "agents"), claudeUser, 10),
      candidate("hooks", "pico-native", paths.project.hooks, paths.project.root, 40),
      candidate("hooks", "pico-native", paths.home.hooks, paths.home.root, 20),
      candidate("mcp", "pico-native", paths.project.mcp, paths.project.root, 40),
      candidate("plugins", "pico-native", paths.project.plugins, paths.project.root, 40),
      candidate("plugins", "pico-native", paths.home.plugins, paths.home.root, 20),
      candidate("legacy-root", "legacy", legacyRoot, paths.canonicalWorkDir, 1),
      candidate("workspace-state", "runtime-state", paths.workspace.root, paths.home.root, 1),
    ];

    const inspected = await Promise.all(candidates.map(inspectCandidate));
    const winners = new Map<string, ResourceDiagnosticEntry>();
    for (const item of inspected.toSorted((left, right) => right.candidate.rank - left.candidate.rank)) {
      if (item.entry.status === "missing" || winners.has(item.entry.kind)) continue;
      winners.set(item.entry.kind, item.entry);
    }
    const entries = inspected.map(({ entry }) => ({
      ...entry,
      authority: winners.get(entry.kind)?.path === entry.path,
    }));
    const findings = entries.flatMap((entry) => {
      if (entry.status === "unsafe") return [`${entry.kind}: ${entry.reason ?? "unsafe path"}`];
      if (entry.origin === "legacy" && entry.status === "present") {
        return [`检测到 legacy .claw，运行迁移前保持只读兼容。`];
      }
      return [];
    });
    return {
      workDir: paths.canonicalWorkDir,
      picoHome: paths.home.root,
      workspaceStateRoot: paths.workspace.root,
      entries: Object.freeze(entries),
      findings: Object.freeze([...new Set(findings)]),
    };
  }
}

export function renderResourceDoctorReport(report: ResourceDoctorReport): string[] {
  const active = report.entries.filter((entry) => entry.authority && entry.status === "present");
  const issues = report.findings.slice(0, 5);
  return [
    `Resources PICO_HOME: ${report.picoHome}`,
    `Resources workspace state: ${report.workspaceStateRoot}`,
    `Resources active: ${active.length}`,
    ...active.map((entry) => `Resource ${entry.kind}: ${entry.origin} · ${entry.path}`),
    ...(issues.length > 0
      ? issues.map((finding) => `Resource finding: ${finding}`)
      : ["Resource findings: none"]),
  ];
}

function candidate(
  kind: string,
  origin: ResourceOrigin,
  path: string,
  boundary: string,
  rank: number,
): ResourceCandidate {
  return { kind, origin, path, boundary, rank };
}

async function inspectCandidate(candidate: ResourceCandidate): Promise<{
  candidate: ResourceCandidate;
  entry: ResourceDiagnosticEntry;
}> {
  const info = await lstat(candidate.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    return {
      candidate,
      entry: { ...candidateEntry(candidate), status: "missing", authority: false },
    };
  }
  const physical = await realpath(candidate.path).catch(() => undefined);
  const physicalBoundary = await realpath(candidate.boundary).catch(() => resolve(candidate.boundary));
  if (!physical || !isWithin(physicalBoundary, physical)) {
    return {
      candidate,
      entry: {
        ...candidateEntry(candidate),
        status: "unsafe",
        authority: false,
        reason: `${candidate.path} 解析到资源边界外`,
      },
    };
  }
  return {
    candidate,
    entry: { ...candidateEntry(candidate), status: "present", authority: false },
  };
}

function candidateEntry(
  candidate: ResourceCandidate,
): Pick<ResourceDiagnosticEntry, "kind" | "origin" | "path"> {
  return { kind: candidate.kind, origin: candidate.origin, path: candidate.path };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}
