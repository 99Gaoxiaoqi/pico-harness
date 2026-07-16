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

const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 1_000;

export interface HookConfigChangeContext {
  oldSnapshot: HookSnapshot;
  candidate: LoadHookSnapshotResult;
  changedPaths: readonly string[];
}

export interface HookConfigReloaderOptions extends LoadHookSnapshotOptions {
  debounceMs?: number;
  /** stop 等待旧 generation 串行尾收口的最长时间。 */
  stopDrainTimeoutMs?: number;
  initial?: LoadHookSnapshotResult;
  /**
   * 由集成层使用旧 HookService snapshot 发 ConfigChange；deny 时不交换。
   * stop deadline 后旧代 guard 可能晚返回，候选准备态必须绑定 context.candidate。
   */
  beforeSwap?: (context: HookConfigChangeContext) => Promise<HookOutput | boolean>;
  /** 同步提交回调；所有异步准备必须在 beforeSwap 内完成。 */
  onSwap: (result: LoadHookSnapshotResult) => undefined;
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
  private readonly stopDrainTimeoutMs: number;

  constructor(private readonly options: HookConfigReloaderOptions) {
    this.current = options.initial;
    this.stopDrainTimeoutMs = boundedDrainTimeout(options.stopDrainTimeoutMs);
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
    const preparedWatchers = await this.prepareWatchers(current, generation);
    if (!preparedWatchers) return current;
    if (!this.isActive(generation)) {
      closeWatcherMap(preparedWatchers);
      return current;
    }
    this.current = current;
    this.replaceWatchers(preparedWatchers);
    return current;
  }

  async reload(changedPaths: readonly string[] = []): Promise<boolean> {
    if (this.stopped) return false;
    const generation = this.generation;
    let accepted = false;
    const running = (this.serial = this.serial
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
        const preparedWatchers = await this.prepareWatchers(candidate, generation);
        if (!preparedWatchers) return;
        if (!this.isActive(generation)) {
          closeWatcherMap(preparedWatchers);
          return;
        }
        try {
          const swapResult = this.options.onSwap(candidate);
          if (swapResult !== undefined) {
            throw new TypeError("Hook onSwap 必须同步完成且不返回值");
          }
          this.current = candidate;
          this.replaceWatchers(preparedWatchers);
          accepted = true;
        } catch (error) {
          closeWatcherMap(preparedWatchers);
          throw error;
        }
      }));
    try {
      await running;
    } catch (error) {
      if (!this.isActive(generation)) return false;
      throw error;
    }
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
    const running = (this.serial = this.serial
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
        const preparedWatchers = await this.prepareWatchers(next, generation);
        if (!preparedWatchers) return;
        if (!this.isActive(generation)) {
          closeWatcherMap(preparedWatchers);
          return;
        }
        try {
          const swapResult = this.options.onSwap(next);
          if (swapResult !== undefined) {
            throw new TypeError("Hook onSwap 必须同步完成且不返回值");
          }
          this.current = next;
          this.replaceWatchers(preparedWatchers);
          retired = true;
        } catch (error) {
          closeWatcherMap(preparedWatchers);
          throw error;
        }
      }));
    try {
      await running;
    } catch (error) {
      if (!this.isActive(generation)) return false;
      throw error;
    }
    return retired;
  }

  stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise;
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.generation++;
    this.clearScheduledReload();
    this.closeWatchers();
    const draining = this.serial.catch(() => undefined);
    // 旧 generation 可能永久卡在外部 beforeSwap。新一代不能继承该串行尾。
    this.serial = Promise.resolve();
    const stopping = this.finishStop(draining);
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
      void this.reload(changed).catch((error: unknown) => {
        if (!this.isActive(generation)) return;
        try {
          this.options.onReject?.(`Hook 重载失败: ${String(error)}`);
        } catch {
          // Watcher 回调没有可传递的 caller，避免二次报错变成 unhandled rejection。
        }
      });
    }, this.options.debounceMs ?? 120);
    this.timer = timer;
  }

  private async prepareWatchers(
    result: LoadHookSnapshotResult,
    generation: number,
  ): Promise<Map<string, FSWatcher> | undefined> {
    if (!this.isActive(generation)) return undefined;
    const exactPaths = new Set(result.watchedPaths.map((path) => resolve(path)));
    for (const eventHandlers of Object.values(result.snapshot.handlers)) {
      for (const entry of eventHandlers) {
        const references = await (
          this.options.trustStore
            ? this.options.trustStore.referencedScripts(this.options.workDir, entry.handler)
            : resolveReferencedScripts(entry.handler, this.options.workDir)
        ).catch(() => undefined);
        if (!this.isActive(generation)) return undefined;
        // Unsupported indirect invocations are already fail-closed as pending and cannot be trusted.
        if (!references) continue;
        for (const path of references.watchPaths) {
          exactPaths.add(resolve(path));
        }
      }
    }
    const wantedDirectories = await existingWatchDirectories([...exactPaths]);
    if (!this.isActive(generation)) return undefined;
    const prepared = new Map<string, FSWatcher>();
    try {
      for (const directory of wantedDirectories) {
        if (!this.isActive(generation)) {
          closeWatcherMap(prepared);
          return undefined;
        }
        const exists = await access(directory).then(
          () => true,
          () => false,
        );
        if (!this.isActive(generation)) {
          closeWatcherMap(prepared);
          return undefined;
        }
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
        prepared.set(directory, watcher);
      }
      return prepared;
    } catch (error) {
      closeWatcherMap(prepared);
      throw error;
    }
  }

  private replaceWatchers(next: ReadonlyMap<string, FSWatcher>): void {
    const previous = [...this.watchers.values()];
    this.watchers.clear();
    for (const [directory, watcher] of next) this.watchers.set(directory, watcher);
    for (const watcher of previous) safeCloseWatcher(watcher);
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
    for (const watcher of this.watchers.values()) safeCloseWatcher(watcher);
    this.watchers.clear();
  }

  private async finishStop(draining: Promise<void>): Promise<void> {
    await settleWithinDeadline(draining, this.stopDrainTimeoutMs);
    this.clearScheduledReload();
    this.closeWatchers();
  }
}

function boundedDrainTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_STOP_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Hook reloader stopDrainTimeoutMs 必须是非负有限数");
  }
  return timeoutMs;
}

async function settleWithinDeadline(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeWatcherMap(watchers: ReadonlyMap<string, FSWatcher>): void {
  for (const watcher of watchers.values()) safeCloseWatcher(watcher);
}

function safeCloseWatcher(watcher: FSWatcher): void {
  try {
    watcher.close();
  } catch {
    // Closing an already-closed watcher is harmless during stop/rollback.
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
