import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import {
  loadHookSnapshot,
  parentDirectories,
  type LoadHookSnapshotOptions,
  type LoadHookSnapshotResult,
} from "../config.js";
import { resolveReferencedScripts } from "./referenced-scripts.js";
import type { HookOutput, HookSnapshot, HookSource } from "../types.js";

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
  /** 组件激活集在会话期间可变，每次候选加载时重新取值。 */
  dynamicSources?: () =>
    | Pick<LoadHookSnapshotOptions, "componentSources" | "extensionSources">
    | undefined;
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
  /** stop 使当前代立即失效；只有等待 stop 完成后的 start 才会开启新代。 */
  private generation = 0;
  private serial = Promise.resolve();
  private stoppingPromise?: Promise<void>;

  constructor(private readonly options: HookConfigReloaderOptions) {
    this.current = options.initial;
  }

  async start(): Promise<LoadHookSnapshotResult> {
    const stopping = this.stoppingPromise;
    if (stopping) await stopping;
    if (this.stopped) {
      this.stopped = false;
      this.generation++;
    }
    const generation = this.generation;
    const current = this.current ?? (await loadHookSnapshot(this.loadOptions()));
    if (!this.isActive(generation)) return current;
    this.current = current;
    await this.refreshWatchers(current, generation);
    return current;
  }

  async reload(changedPaths: readonly string[] = []): Promise<boolean> {
    if (this.stopped) return false;
    const generation = this.generation;
    let accepted = false;
    this.serial = this.serial
      .catch(() => undefined)
      .then(async () => {
        if (!this.isActive(generation)) return;
        const previous = this.current ?? (await loadHookSnapshot(this.loadOptions()));
        if (!this.isActive(generation)) return;
        this.current = previous;
        let candidate: LoadHookSnapshotResult;
        try {
          candidate = await loadHookSnapshot({
            ...this.loadOptions(),
            version: previous.snapshot.version + 1,
          });
        } catch (error) {
          if (this.isActive(generation)) {
            this.options.onReject?.(`Hook 重载失败: ${String(error)}`);
          }
          return;
        }
        if (!this.isActive(generation)) return;
        if (candidate.hasErrors) {
          this.options.onReject?.(formatInvalidSources(candidate), candidate);
          return;
        }
        const guard = await this.options.beforeSwap?.({
          oldSnapshot: previous.snapshot,
          candidate,
          changedPaths,
        });
        if (!this.isActive(generation)) return;
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
        if (!this.isActive(generation)) return;
        await this.refreshWatchers(candidate, generation);
        if (!this.isActive(generation)) return;
        accepted = true;
      });
    await this.serial;
    return accepted;
  }

  /**
   * 从已接受快照中退租动态 source，不读取可能已同时变更的磁盘配置。
   * 退租后的常规 reload 仍会通过 ConfigChange 守卫，因此既不会被旧组件
   * 永久自阻断，也不会把同期静态配置变更捆绑放行。
   */
  async retireSources(matches: (source: HookSource) => boolean): Promise<boolean> {
    if (this.stopped) return false;
    const generation = this.generation;
    let retired = false;
    this.serial = this.serial
      .catch(() => undefined)
      .then(async () => {
        if (!this.isActive(generation)) return;
        const previous = this.current ?? (await loadHookSnapshot(this.loadOptions()));
        if (!this.isActive(generation)) return;
        this.current = previous;
        const sources = previous.sources.filter((entry) => !matches(entry.source));
        if (sources.length === previous.sources.length) return;
        const version = previous.snapshot.version + 1;
        const handlers = Object.fromEntries(
          Object.entries(previous.snapshot.handlers).map(([event, entries]) => [
            event,
            Object.freeze(entries.filter((entry) => !matches(entry.source))),
          ]),
        ) as HookSnapshot["handlers"];
        const diagnostics = Object.freeze(
          previous.snapshot.diagnostics.filter((entry) => !matches(entry.source)),
        );
        const snapshot = Object.freeze({
          ...previous.snapshot,
          id: createHash("sha256")
            .update(`${previous.snapshot.id}:retire:${version}`)
            .digest("hex"),
          version,
          createdAt: new Date().toISOString(),
          handlers,
          diagnostics,
        });
        const next = Object.freeze({ ...previous, snapshot, sources: Object.freeze(sources) });
        if (!this.isActive(generation)) return;
        await this.options.onSwap(next);
        this.current = next;
        if (!this.isActive(generation)) return;
        await this.refreshWatchers(next, generation);
        if (!this.isActive(generation)) return;
        retired = true;
      });
    await this.serial;
    return retired;
  }

  stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.generation++;
    this.clearScheduledReload();
    this.closeWatchers();
    const stopping = this.finishStop();
    const tracked = stopping.finally(() => {
      if (this.stoppingPromise === tracked) this.stoppingPromise = undefined;
    });
    this.stoppingPromise = tracked;
    return tracked;
  }

  currentResult(): LoadHookSnapshotResult | undefined {
    return this.current;
  }

  private loadOptions(): LoadHookSnapshotOptions {
    return { ...this.options, ...(this.options.dynamicSources?.() ?? {}) };
  }

  private schedule(path: string, generation: number): void {
    if (!this.isActive(generation)) return;
    this.changed.add(resolve(path));
    if (this.timer) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = undefined;
      if (!this.isActive(generation)) return;
      const changed = [...this.changed];
      this.changed.clear();
      void this.reload(changed);
    }, this.options.debounceMs ?? 120);
    this.timer = timer;
  }

  private async refreshWatchers(result: LoadHookSnapshotResult, generation: number): Promise<void> {
    if (!this.isActive(generation)) return;
    const exactPaths = new Set(result.watchedPaths.map((path) => resolve(path)));
    for (const eventHandlers of Object.values(result.snapshot.handlers)) {
      for (const entry of eventHandlers) {
        const references = await resolveReferencedScripts(entry.handler, this.options.workDir);
        if (!this.isActive(generation)) return;
        for (const path of references.watchPaths) {
          exactPaths.add(resolve(path));
        }
      }
    }
    const wantedDirectories = await existingWatchDirectories([...exactPaths]);
    if (!this.isActive(generation)) return;
    for (const [directory, watcher] of this.watchers) {
      if (wantedDirectories.includes(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of wantedDirectories) {
      if (!this.isActive(generation)) return;
      if (this.watchers.has(directory)) continue;
      const exists = await access(directory).then(
        () => true,
        () => false,
      );
      if (!this.isActive(generation)) return;
      if (!exists) continue;
      const watcher = watch(directory, { recursive: false }, (_event, filename) => {
        if (!filename) return;
        const path = resolve(directory, filename.toString());
        if (
          exactPaths.has(path) ||
          [...exactPaths].some((target) => target.startsWith(`${path}${sep}`)) ||
          isHookifyFile(path, this.options.workDir)
        )
          this.schedule(path, generation);
      });
      watcher.on("error", (error) => {
        if (this.isActive(generation)) {
          this.options.onReject?.(`Hook watcher 失败: ${String(error)}`);
        }
      });
      this.watchers.set(directory, watcher);
    }
  }

  private isActive(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  private clearScheduledReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed.clear();
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private async finishStop(): Promise<void> {
    await this.serial.catch(() => undefined);
    this.clearScheduledReload();
    this.closeWatchers();
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
