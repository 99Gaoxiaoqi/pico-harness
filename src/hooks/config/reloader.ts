import { createHash } from "node:crypto";
import { watch, type FSWatcher, type Stats } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import {
  loadHookSnapshot,
  parentDirectories,
  type LoadHookSnapshotOptions,
  type LoadHookSnapshotResult,
} from "../config.js";
import { resolveReferencedScripts } from "./command-shell.js";
import type { HookOutput, HookSnapshot, HookSource } from "../types.js";
import { raceWithDeadline } from "../../util/race-with-deadline.js";

const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 1_000;
const WATCH_FILE_FALLBACK_INTERVAL_MS = 250;

interface PreparedHookWatchers {
  readonly directories: Map<string, FSWatcher>;
  readonly timers: Set<NodeJS.Timeout>;
  readonly fingerprints: Map<string, string>;
  readonly hookifyFingerprint: { value: string };
  readonly lease: { active: boolean };
}

interface HookWatchBaseline {
  readonly exactPaths: readonly string[];
  readonly wantedDirectories: readonly string[];
  readonly fingerprints: ReadonlyMap<string, string>;
  readonly hookifyFingerprint: string;
}

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
  private readonly watchTimers = new Set<NodeJS.Timeout>();
  private watchLease?: { active: boolean };
  private readonly changed = new Set<string>();
  private readonly scheduledFingerprints = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private scheduledDrain?: Promise<void>;
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
    let current = this.current ?? (await loadHookSnapshot(this.loadOptions()));
    if (!this.isActive(generation)) return current;
    let watcherBaseline = await this.captureWatchBaseline(current, generation);
    if (!watcherBaseline || !this.isActive(generation)) return current;
    const confirmedCurrent = await loadHookSnapshot({
      ...this.loadOptions(),
      version: current.snapshot.version,
    });
    if (!this.isActive(generation)) return current;
    if (confirmedCurrent.hasErrors || confirmedCurrent.snapshot.id !== current.snapshot.id) {
      this.current = current;
      await this.reload([...confirmedCurrent.watchedPaths]);
      if (!this.isActive(generation)) return this.current ?? current;
      current = this.current ?? current;
      watcherBaseline = await this.captureWatchBaseline(current, generation);
      if (!watcherBaseline || !this.isActive(generation)) return current;
    }
    const preparedWatchers = await this.prepareWatchers(current, generation, watcherBaseline);
    if (!preparedWatchers) return current;
    if (!this.isActive(generation)) {
      closePreparedWatchers(preparedWatchers);
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
        const watcherBaseline = await this.captureWatchBaseline(candidate, generation);
        if (!watcherBaseline || !this.isActive(generation)) return;
        const confirmedCandidate = await loadHookSnapshot({
          ...this.loadOptions(),
          version: candidate.snapshot.version,
        });
        if (!this.isActive(generation)) return;
        if (
          confirmedCandidate.hasErrors ||
          confirmedCandidate.snapshot.id !== candidate.snapshot.id
        ) {
          // candidate 读取与 watcher 基线捕获之间发生了变化；交给串行尾重新加载，
          // 不能把较新的磁盘状态误认成旧 candidate 的监视基线。
          for (const path of watcherBaseline.exactPaths) this.schedule(path, generation);
          this.schedule(resolve(this.options.workDir, ".claw"), generation);
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
        const preparedWatchers = await this.prepareWatchers(candidate, generation, watcherBaseline);
        if (!preparedWatchers) return;
        if (!this.isActive(generation)) {
          closePreparedWatchers(preparedWatchers);
          return;
        }
        try {
          const swapResult = this.options.onSwap(candidate);
          if (swapResult !== undefined) {
            throw new TypeError("Hook onSwap 必须同步完成且不返回值");
          }
          this.current = candidate;
          this.discardChangesCoveredBy(watcherBaseline);
          this.replaceWatchers(preparedWatchers);
          accepted = true;
        } catch (error) {
          closePreparedWatchers(preparedWatchers);
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
          closePreparedWatchers(preparedWatchers);
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
          closePreparedWatchers(preparedWatchers);
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

  private schedule(path: string, generation: number, fingerprint?: string): void {
    if (!this.isActive(generation)) return;
    const canonicalPath = resolve(path);
    if (fingerprint !== undefined) {
      if (this.scheduledFingerprints.get(canonicalPath) === fingerprint) return;
      this.scheduledFingerprints.set(canonicalPath, fingerprint);
    }
    this.changed.add(canonicalPath);
    this.armScheduledReload(generation);
  }

  private armScheduledReload(generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = undefined;
      if (!this.isActive(generation)) return;
      this.flushScheduledReloads(generation);
    }, this.options.debounceMs ?? 120);
    this.timer = timer;
  }

  private flushScheduledReloads(generation: number): void {
    if (this.scheduledDrain) return;
    const draining = (async () => {
      while (this.isActive(generation) && this.changed.size > 0) {
        const changed = [...this.changed];
        this.changed.clear();
        await this.reload(changed);
      }
    })();
    const tracked = draining
      .catch((error: unknown) => {
        if (!this.isActive(generation)) return;
        try {
          this.options.onReject?.(`Hook 重载失败: ${String(error)}`);
        } catch {
          // Watcher 回调没有可传递的 caller，避免二次报错变成 unhandled rejection。
        }
      })
      .finally(() => {
        if (this.scheduledDrain === tracked) this.scheduledDrain = undefined;
        if (this.isActive(generation) && this.changed.size > 0) {
          this.armScheduledReload(generation);
        }
      });
    this.scheduledDrain = tracked;
  }

  private async prepareWatchers(
    result: LoadHookSnapshotResult,
    generation: number,
    capturedBaseline?: HookWatchBaseline,
  ): Promise<PreparedHookWatchers | undefined> {
    const baseline = capturedBaseline ?? (await this.captureWatchBaseline(result, generation));
    if (!baseline || !this.isActive(generation)) return undefined;
    const exactPaths = new Set(baseline.exactPaths);
    const wantedDirectories = baseline.wantedDirectories;
    const fingerprints = new Map(baseline.fingerprints);
    const hookifyFingerprint = { value: baseline.hookifyFingerprint };
    const lease = { active: true };
    const isPreparedActive = (): boolean => lease.active && this.isActive(generation);
    let dirtySinceBaseline = false;
    const scheduleChangedPaths = async (paths: readonly string[]): Promise<boolean> => {
      let detected = false;
      for (const path of paths) {
        const next = await fileFingerprint(path);
        if (!isPreparedActive()) return detected;
        if (next === fingerprints.get(path)) continue;
        fingerprints.set(path, next);
        dirtySinceBaseline = true;
        detected = true;
        this.schedule(path, generation, next);
      }
      return detected;
    };
    const scheduleHookifyIfChanged = async (): Promise<boolean> => {
      const next = await hookifyFilesFingerprint(this.options.workDir);
      if (!isPreparedActive() || next === hookifyFingerprint.value) return false;
      hookifyFingerprint.value = next;
      dirtySinceBaseline = true;
      this.schedule(resolve(this.options.workDir, ".claw"), generation, next);
      return true;
    };
    const prepared: PreparedHookWatchers = {
      directories: new Map<string, FSWatcher>(),
      timers: new Set<NodeJS.Timeout>(),
      fingerprints,
      hookifyFingerprint,
      lease,
    };
    try {
      for (const directory of wantedDirectories) {
        if (!isPreparedActive()) {
          closePreparedWatchers(prepared);
          return undefined;
        }
        const exists = await access(directory).then(
          () => true,
          () => false,
        );
        if (!isPreparedActive()) {
          closePreparedWatchers(prepared);
          return undefined;
        }
        if (!exists) continue;
        const watcher = watch(directory, { recursive: false }, (_event, filename) => {
          // Node 不保证 fs.watch 始终提供 filename；所有通知先与共享指纹对账，
          // 避免漏变更，也避免快速通知与轮询兜底重复执行 ConfigChange。
          if (!filename) {
            void Promise.all([
              scheduleChangedPaths([...exactPaths]),
              scheduleHookifyIfChanged(),
            ]).catch((error: unknown) => {
              if (isPreparedActive()) {
                this.options.onReject?.(`Hook watcher 复核失败: ${String(error)}`);
              }
            });
            return;
          }
          const path = resolve(directory, filename.toString());
          const affectedPaths = [...exactPaths].filter(
            (target) => target === path || target.startsWith(`${path}${sep}`),
          );
          if (affectedPaths.length > 0) {
            void scheduleChangedPaths(affectedPaths).catch((error: unknown) => {
              if (isPreparedActive()) {
                this.options.onReject?.(`Hook watcher 复核失败: ${String(error)}`);
              }
            });
          } else if (isHookifyFile(path, this.options.workDir)) {
            void scheduleHookifyIfChanged().catch((error: unknown) => {
              if (isPreparedActive()) {
                this.options.onReject?.(`Hook watcher 复核失败: ${String(error)}`);
              }
            });
          }
        });
        watcher.on("error", (error) => {
          if (isPreparedActive()) {
            this.options.onReject?.(`Hook watcher 失败: ${String(error)}`);
          }
        });
        prepared.directories.set(directory, watcher);
      }
      const [exactChanged, hookifyChanged] = await Promise.all([
        scheduleChangedPaths([...exactPaths]),
        scheduleHookifyIfChanged(),
      ]);
      if (!isPreparedActive() || dirtySinceBaseline || exactChanged || hookifyChanged) {
        // guard/安装期间出现的新磁盘状态时，不允许提交旧 candidate；已排入的
        // 串行 reload 会重新加载最新内容。这样 onSwap 内 stop 也不会吞掉变化。
        closePreparedWatchers(prepared);
        return undefined;
      }
      // fs.watch 是有损通知；主动审计始终与代码捕获的 baseline 比较，既覆盖
      // watcher 安装窗口，也不会依赖 watchFile 自身异步建立的内部 baseline。
      let auditRunning = false;
      const auditTimer = setInterval(() => {
        if (!isPreparedActive() || auditRunning) return;
        auditRunning = true;
        void Promise.all([scheduleChangedPaths([...exactPaths]), scheduleHookifyIfChanged()])
          .catch((error: unknown) => {
            if (isPreparedActive()) {
              this.options.onReject?.(`Hook watcher 复核失败: ${String(error)}`);
            }
          })
          .finally(() => {
            auditRunning = false;
          });
      }, WATCH_FILE_FALLBACK_INTERVAL_MS);
      auditTimer.unref();
      prepared.timers.add(auditTimer);
      return prepared;
    } catch (error) {
      closePreparedWatchers(prepared);
      throw error;
    }
  }

  private async captureWatchBaseline(
    result: LoadHookSnapshotResult,
    generation: number,
  ): Promise<HookWatchBaseline | undefined> {
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
    const fingerprints = new Map<string, string>();
    for (const path of exactPaths) {
      fingerprints.set(path, await fileFingerprint(path));
      if (!this.isActive(generation)) return undefined;
    }
    const hookifyFingerprint = await hookifyFilesFingerprint(this.options.workDir);
    if (!this.isActive(generation)) return undefined;
    return {
      exactPaths: [...exactPaths],
      wantedDirectories,
      fingerprints,
      hookifyFingerprint,
    };
  }

  private replaceWatchers(next: PreparedHookWatchers): void {
    const previous = [...this.watchers.values()];
    const previousTimers = [...this.watchTimers];
    if (this.watchLease) this.watchLease.active = false;
    this.watchLease = next.lease;
    this.watchers.clear();
    this.watchTimers.clear();
    for (const [directory, watcher] of next.directories) this.watchers.set(directory, watcher);
    for (const timer of next.timers) this.watchTimers.add(timer);
    this.scheduledFingerprints.clear();
    for (const [path, fingerprint] of next.fingerprints) {
      this.scheduledFingerprints.set(path, fingerprint);
    }
    this.scheduledFingerprints.set(
      resolve(this.options.workDir, ".claw"),
      next.hookifyFingerprint.value,
    );
    for (const watcher of previous) safeCloseWatcher(watcher);
    for (const timer of previousTimers) clearInterval(timer);
  }

  private discardChangesCoveredBy(accepted: HookWatchBaseline): void {
    // A slow write can enqueue an intermediate and the final fingerprint while one reload is
    // guarded. Consume only notifications represented by the accepted disk baseline; a newer
    // fingerprint stays queued for the serial tail.
    for (const [path, fingerprint] of accepted.fingerprints) {
      if (this.scheduledFingerprints.get(path) === fingerprint) this.changed.delete(path);
    }
    const hookifyPath = resolve(this.options.workDir, ".claw");
    if (this.scheduledFingerprints.get(hookifyPath) === accepted.hookifyFingerprint) {
      this.changed.delete(hookifyPath);
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
    if (this.watchLease) this.watchLease.active = false;
    this.watchLease = undefined;
    for (const watcher of this.watchers.values()) safeCloseWatcher(watcher);
    this.watchers.clear();
    for (const timer of this.watchTimers) clearInterval(timer);
    this.watchTimers.clear();
    this.scheduledFingerprints.clear();
  }

  private async finishStop(draining: Promise<void>): Promise<void> {
    await raceWithDeadline(draining, this.stopDrainTimeoutMs);
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

function closePreparedWatchers(watchers: PreparedHookWatchers): void {
  watchers.lease.active = false;
  for (const watcher of watchers.directories.values()) safeCloseWatcher(watcher);
  for (const timer of watchers.timers) clearInterval(timer);
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

async function fileFingerprint(path: string): Promise<string> {
  return await stat(path).then(statsFingerprint, () => "missing");
}

function statsFingerprint(stats: Stats): string {
  if (stats.nlink === 0) return "missing";
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

async function hookifyFilesFingerprint(workDir: string): Promise<string> {
  const directory = resolve(workDir, ".claw");
  const names = await readdir(directory).catch(() => [] as string[]);
  const hookifyNames = names
    .filter((name) => isHookifyFile(resolve(directory, name), workDir))
    .sort();
  const fingerprints = await Promise.all(
    hookifyNames.map(async (name) => `${name}:${await fileFingerprint(resolve(directory, name))}`),
  );
  return fingerprints.join("|");
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
