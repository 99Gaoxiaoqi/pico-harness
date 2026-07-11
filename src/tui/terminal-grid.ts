import { EventEmitter } from "node:events";

const CPR_QUERY = "\u001b[?1049h\u001b[?6l\u001b[r\u001b[999;999H\u001b[6n";
const CPR_QUERY_CLEANUP = "\u001b[?1049l";
const LIVE_CPR_QUERY = "\u001b[s\u001b[999;999H\u001b[6n\u001b[u";
const DEFAULT_PROBE_TIMEOUT_MS = 180;
const LATE_CPR_DRAIN_MS = 250;
const MIN_LIVE_COLUMNS = 10;
const MIN_LIVE_ROWS = 3;
const CPR_RESPONSE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[(\\d{1,5});(\\d{1,5})R`,
  "gu",
);

export interface TerminalGrid {
  columns: number;
  rows: number;
}

export interface TuiTerminalGridSession {
  stdout: NodeJS.WriteStream;
  dispose: () => Promise<void>;
}

/**
 * ChatGPT.app can resize its xterm grid before the PTY winsize catches up. Ask
 * the frontend for its clamped cursor position before Ink enters alt-screen so
 * layout uses the grid that actually wraps output.
 */
export async function probeTerminalGrid(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<TerminalGrid | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return null;

  const wasRaw = Boolean(stdin.isRaw);
  let buffered = Buffer.alloc(0);
  let enteredAlternateScreen = false;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (grid: TerminalGrid | null, responseRange?: [number, number]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("readable", onReadable);

      if (enteredAlternateScreen) {
        try {
          stdout.write(CPR_QUERY_CLEANUP);
        } catch {
          // The stream may already be closing; raw mode and buffered input still need restoring.
        }
      }

      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // A closing TTY can reject mode changes. The probe must still settle.
      }

      restoreBufferedInput(stdin, buffered, responseRange);
      resolve(grid);
    };

    const onReadable = (): void => {
      let chunk: string | Buffer | null;
      while ((chunk = stdin.read() as string | Buffer | null) !== null) {
        buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
        const response = findCursorPositionResponse(buffered);
        if (!response) continue;
        finish(response.grid, response.range);
        return;
      }
    };

    stdin.prependListener("readable", onReadable);
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    try {
      stdin.setRawMode(true);
      enteredAlternateScreen = true;
      stdout.write(CPR_QUERY);
    } catch {
      finish(null);
    }
  });
}

/**
 * Resolve one terminal session instead of one immutable stdout snapshot.
 *
 * The facade withholds the underlying resize event until a fresh, non-
 * destructive CPR has updated both dimensions. Ink therefore never renders a
 * full frame using the stale startup height. CPR bytes are consumed before
 * Ink's readable listener and any interleaved user input is restored.
 */
export async function createTuiTerminalGridSession(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<TuiTerminalGridSession> {
  if (env["CODEX_SHELL"] !== "1") return passthroughSession(stdout);
  const frontendGrid = await probeTerminalGrid(stdin, stdout, timeoutMs);
  if (!frontendGrid) return passthroughSession(stdout);
  return createResizeAwareSession(stdin, stdout, frontendGrid, timeoutMs);
}

/**
 * Start from the frontend grid as one coherent snapshot. Kept for callers that
 * only need a fixed snapshot; the production TUI uses the session API above.
 */
export function capTerminalGrid(
  stdout: NodeJS.WriteStream,
  frontendGrid: TerminalGrid,
): NodeJS.WriteStream {
  const frontend = normalizeGrid(frontendGrid, { columns: 80, rows: 24 });
  const effectiveGrid = (): TerminalGrid => effectiveTerminalGrid(stdout, frontend);

  return new Proxy(stdout, {
    get(target, property) {
      if (property === "columns") return effectiveGrid().columns;
      if (property === "rows") return effectiveGrid().rows;
      if (property === "getWindowSize") {
        return (): [number, number] => {
          const grid = effectiveGrid();
          return [grid.columns, grid.rows];
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

function createResizeAwareSession(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  initialFrontendGrid: TerminalGrid,
  timeoutMs: number,
): TuiTerminalGridSession {
  const resizeEvents = new EventEmitter();
  let frontendGrid = normalizeGrid(initialFrontendGrid, { columns: 80, rows: 24 });
  let publishedGrid = effectiveTerminalGrid(stdout, frontendGrid);
  let disposed = false;
  let resizeGeneration = 0;
  let resizeQueued = false;
  let refreshRequested = false;
  let refreshPromise: Promise<void> | undefined;
  let liveProbe:
    | {
        buffered: Buffer;
        drained: Promise<void>;
        finish: (grid: TerminalGrid | null, responseRange?: [number, number]) => void;
      }
    | undefined;

  const effectiveGrid = (): TerminalGrid => publishedGrid;

  const onReadable = (): void => {
    if (!liveProbe) return;
    let chunk: string | Buffer | null;
    while (liveProbe && (chunk = stdin.read() as string | Buffer | null) !== null) {
      liveProbe.buffered = Buffer.concat([liveProbe.buffered, Buffer.from(chunk)]);
      const response = findCursorPositionResponse(liveProbe.buffered, isPlausibleLiveGrid);
      if (!response) continue;
      liveProbe.finish(response.grid, response.range);
    }
  };

  const probeLiveGrid = async (): Promise<TerminalGrid | null> => {
    if (liveProbe) await liveProbe.drained;
    if (disposed) return null;

    let resolveResult!: (grid: TerminalGrid | null) => void;
    let resolveDrained!: () => void;
    const result = new Promise<TerminalGrid | null>((resolve) => {
      resolveResult = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    let resultSettled = false;
    let quarantine: ReturnType<typeof setTimeout> | undefined;

    const settleResult = (grid: TerminalGrid | null): void => {
      if (resultSettled) return;
      resultSettled = true;
      resolveResult(grid);
    };
    const drain = (responseRange?: [number, number]): void => {
      clearTimeout(timeout);
      if (quarantine) clearTimeout(quarantine);
      const buffered = liveProbe?.buffered ?? Buffer.alloc(0);
      liveProbe = undefined;
      restoreBufferedInput(stdin, buffered, responseRange);
      resolveDrained();
    };
    const finish = (grid: TerminalGrid | null, responseRange?: [number, number]): void => {
      settleResult(grid);
      drain(responseRange);
    };

    liveProbe = { buffered: Buffer.alloc(0), drained, finish };
    const timeout = setTimeout(
      () => {
        // Publish a conservative fallback promptly, but keep consuming one late
        // CPR for a bounded window so it cannot become keyboard input or leak to
        // the shell during teardown.
        settleResult(null);
        quarantine = setTimeout(() => drain(), LATE_CPR_DRAIN_MS);
        quarantine.unref?.();
      },
      Math.max(1, timeoutMs),
    );
    try {
      // Save and restore the cursor in the same write. Unlike the startup
      // probe this never enters or exits the alternate screen.
      stdout.write(LIVE_CPR_QUERY);
    } catch {
      finish(null);
    }
    return result;
  };

  const publishIfChanged = (): void => {
    const next = effectiveTerminalGrid(stdout, frontendGrid);
    if (sameGrid(next, publishedGrid)) return;
    publishedGrid = next;
    resizeEvents.emit("resize");
  };

  const runRefreshLoop = async (): Promise<void> => {
    while (refreshRequested && !disposed) {
      refreshRequested = false;
      const generation = resizeGeneration;
      const refreshed = await probeLiveGrid();
      if (disposed) return;
      if (generation !== resizeGeneration) {
        continue;
      }
      if (refreshed) {
        frontendGrid = normalizeGrid(refreshed, frontendGrid);
      } else {
        // A failed probe must never keep a height larger than the only live
        // size we can observe. A later successful resize probe can expand it.
        frontendGrid = conservativeFallbackGrid(stdout, frontendGrid);
      }
      publishIfChanged();
    }
  };

  const startRefresh = (): void => {
    refreshRequested = true;
    if (refreshPromise) return;
    refreshPromise = runRefreshLoop().finally(() => {
      refreshPromise = undefined;
      if (refreshRequested && !disposed) startRefresh();
    });
  };

  const onUnderlyingResize = (): void => {
    if (disposed) return;
    resizeGeneration++;
    if (resizeQueued) return;
    resizeQueued = true;
    queueMicrotask(() => {
      resizeQueued = false;
      if (disposed) return;
      startRefresh();
    });
  };

  const facade = new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === "columns") return effectiveGrid().columns;
      if (property === "rows") return effectiveGrid().rows;
      if (property === "getWindowSize") {
        return (): [number, number] => {
          const grid = effectiveGrid();
          return [grid.columns, grid.rows];
        };
      }
      if (property === "on" || property === "addListener") {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === "resize") resizeEvents.on(event, listener);
          else Reflect.apply(target.on, target, [event, listener]);
          return receiver;
        };
      }
      if (
        property === "once" ||
        property === "prependListener" ||
        property === "prependOnceListener"
      ) {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === "resize")
            Reflect.apply(Reflect.get(resizeEvents, property), resizeEvents, [event, listener]);
          else Reflect.apply(Reflect.get(target, property, target), target, [event, listener]);
          return receiver;
        };
      }
      if (property === "off" || property === "removeListener") {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === "resize") resizeEvents.off(event, listener);
          else Reflect.apply(target.off, target, [event, listener]);
          return receiver;
        };
      }
      if (property === "removeAllListeners") {
        return (event?: string | symbol) => {
          if (event === "resize") resizeEvents.removeAllListeners(event);
          else if (event === undefined) resizeEvents.removeAllListeners("resize");
          else Reflect.apply(target.removeAllListeners, target, [event]);
          return receiver;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });

  stdin.prependListener("readable", onReadable);
  stdout.on("resize", onUnderlyingResize);

  return {
    stdout: facade,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      resizeGeneration++;
      stdout.off("resize", onUnderlyingResize);
      await refreshPromise?.catch(() => undefined);
      while (liveProbe) await liveProbe.drained;
      stdin.off("readable", onReadable);
      resizeEvents.removeAllListeners();
    },
  };
}

function passthroughSession(stdout: NodeJS.WriteStream): TuiTerminalGridSession {
  return { stdout, dispose: async () => undefined };
}

function restoreBufferedInput(
  stdin: NodeJS.ReadStream,
  buffered: Buffer,
  responseRange?: [number, number],
): void {
  const remainder = responseRange
    ? Buffer.concat([buffered.subarray(0, responseRange[0]), buffered.subarray(responseRange[1])])
    : buffered;
  if (remainder.length === 0) return;
  try {
    stdin.unshift(remainder);
  } catch {
    // Ignore input restoration only when the stream has already ended.
  }
}

function findCursorPositionResponse(
  buffer: Buffer,
  accept: (grid: TerminalGrid) => boolean = () => true,
): { grid: TerminalGrid; range: [number, number] } | null {
  const value = buffer.toString("latin1");
  for (const match of value.matchAll(CPR_RESPONSE_PATTERN)) {
    if (match.index === undefined) continue;
    const rows = Number(match[1]);
    const columns = Number(match[2]);
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) {
      continue;
    }
    const grid = { columns, rows };
    if (!accept(grid)) continue;
    return {
      grid,
      range: [match.index, match.index + match[0].length],
    };
  }
  return null;
}

function isPlausibleLiveGrid(grid: TerminalGrid): boolean {
  return grid.columns >= MIN_LIVE_COLUMNS && grid.rows >= MIN_LIVE_ROWS;
}

function effectiveTerminalGrid(
  stdout: NodeJS.WriteStream,
  frontendGrid: TerminalGrid,
): TerminalGrid {
  return {
    columns: Math.min(
      frontendGrid.columns,
      normalizeDimension(stdout.columns, frontendGrid.columns),
    ),
    rows: frontendGrid.rows,
  };
}

function conservativeFallbackGrid(
  stdout: NodeJS.WriteStream,
  frontendGrid: TerminalGrid,
): TerminalGrid {
  return {
    columns: Math.min(
      frontendGrid.columns,
      normalizeDimension(stdout.columns, frontendGrid.columns),
    ),
    rows: Math.min(frontendGrid.rows, normalizeDimension(stdout.rows, frontendGrid.rows)),
  };
}

function normalizeGrid(grid: TerminalGrid, fallback: TerminalGrid): TerminalGrid {
  return {
    columns: normalizeDimension(grid.columns, fallback.columns),
    rows: normalizeDimension(grid.rows, fallback.rows),
  };
}

function sameGrid(left: TerminalGrid, right: TerminalGrid): boolean {
  return left.columns === right.columns && left.rows === right.rows;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}
