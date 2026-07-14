import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import {
  loadHookSnapshot,
  parentDirectories,
  resolveReferencedScriptCandidates,
  type LoadHookSnapshotOptions,
  type LoadHookSnapshotResult,
} from "../config.js";
import type { HookOutput, HookSnapshot } from "../types.js";

export interface HookConfigChangeContext {
  oldSnapshot: HookSnapshot;
  candidate: LoadHookSnapshotResult;
  changedPaths: readonly string[];
}

export interface HookConfigReloaderOptions extends LoadHookSnapshotOptions {
  debounceMs?: number;
  initial?: LoadHookSnapshotResult;
  /** 由集成层使用旧 HookService snapshot 发 ConfigChange；deny 时不交换。 */
  beforeSwap?: (context: HookConfigChangeContext) => Promise<HookOutput | boolean>;
  onSwap: (result: LoadHookSnapshotResult) => void | Promise<void>;
  onReject?: (message: string, candidate?: LoadHookSnapshotResult) => void;
}

/**
 * 仅监视已知配置/脚本的父目录，不做全工作区 recursive watch。
 * 加载完成后一次性交换快照，在途 dispatch 仍持有旧对象。
 */
export class HookConfigReloader {
  private current?: LoadHookSnapshotResult;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly changed = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private serial = Promise.resolve();

  constructor(private readonly options: HookConfigReloaderOptions) {
    this.current = options.initial;
  }

  async start(): Promise<LoadHookSnapshotResult> {
    this.stopped = false;
    if (!this.current) this.current = await loadHookSnapshot(this.options);
    await this.refreshWatchers(this.current);
    return this.current;
  }

  async reload(changedPaths: readonly string[] = []): Promise<boolean> {
    let accepted = false;
    this.serial = this.serial
      .catch(() => undefined)
      .then(async () => {
        const previous = this.current ?? (await this.start());
        let candidate: LoadHookSnapshotResult;
        try {
          candidate = await loadHookSnapshot({
            ...this.options,
            version: previous.snapshot.version + 1,
          });
        } catch (error) {
          this.options.onReject?.(`Hook 重载失败: ${String(error)}`);
          return;
        }
        if (candidate.hasErrors) {
          this.options.onReject?.(formatInvalidSources(candidate), candidate);
          return;
        }
        const guard = await this.options.beforeSwap?.({
          oldSnapshot: previous.snapshot,
          candidate,
          changedPaths,
        });
        if (guard === false || (typeof guard === "object" && guard.decision !== "allow")) {
          this.options.onReject?.(
            typeof guard === "object"
              ? (guard.reason ?? "ConfigChange Hook 拒绝新配置")
              : "新配置被拒绝",
            candidate,
          );
          return;
        }
        await this.options.onSwap(candidate);
        this.current = candidate;
        await this.refreshWatchers(candidate);
        accepted = true;
      });
    await this.serial;
    return accepted;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  currentResult(): LoadHookSnapshotResult | undefined {
    return this.current;
  }

  private schedule(path: string): void {
    if (this.stopped) return;
    this.changed.add(resolve(path));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changed = [...this.changed];
      this.changed.clear();
      void this.reload(changed);
    }, this.options.debounceMs ?? 120);
  }

  private async refreshWatchers(result: LoadHookSnapshotResult): Promise<void> {
    const exactPaths = new Set(result.watchedPaths.map((path) => resolve(path)));
    for (const eventHandlers of Object.values(result.snapshot.handlers)) {
      for (const entry of eventHandlers) {
        for (const path of resolveReferencedScriptCandidates(entry.handler, this.options.workDir)) {
          exactPaths.add(resolve(path));
        }
      }
    }
    const wantedDirectories = await existingWatchDirectories([...exactPaths]);
    for (const [directory, watcher] of this.watchers) {
      if (wantedDirectories.includes(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of wantedDirectories) {
      if (this.watchers.has(directory)) continue;
      if (
        !(await access(directory).then(
          () => true,
          () => false,
        ))
      )
        continue;
      const watcher = watch(directory, { recursive: false }, (_event, filename) => {
        if (!filename) return;
        const path = resolve(directory, filename.toString());
        if (
          exactPaths.has(path) ||
          [...exactPaths].some((target) => target.startsWith(`${path}${sep}`)) ||
          isHookifyFile(path, this.options.workDir)
        )
          this.schedule(path);
      });
      watcher.on("error", (error) =>
        this.options.onReject?.(`Hook watcher 失败: ${String(error)}`),
      );
      this.watchers.set(directory, watcher);
    }
  }
}

async function existingWatchDirectories(paths: readonly string[]): Promise<readonly string[]> {
  const directories = new Set<string>();
  for (const path of parentDirectories(paths)) {
    let candidate = path;
    while (
      !(await access(candidate).then(
        () => true,
        () => false,
      ))
    ) {
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    directories.add(candidate);
  }
  return [...directories];
}

function isHookifyFile(path: string, workDir: string): boolean {
  return (
    dirname(path) === resolve(workDir, ".claw") &&
    /^hookify\.[a-z0-9-]+\.local\.md$/.test(basename(path))
  );
}

function formatInvalidSources(result: LoadHookSnapshotResult): string {
  return result.sources
    .filter((source) => source.status === "invalid")
    .map((source) => `${source.source.path}: ${source.error ?? "无效"}`)
    .join("\n");
}
