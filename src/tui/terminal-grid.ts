const CPR_QUERY = "\u001b[?1049h\u001b[?6l\u001b[r\u001b[999;999H\u001b[6n";
const CPR_QUERY_CLEANUP = "\u001b[?1049l";
const DEFAULT_PROBE_TIMEOUT_MS = 180;
const CPR_RESPONSE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(\\d{1,5});(\\d{1,5})R`, "u");

export interface TerminalGrid {
  columns: number;
  rows: number;
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

      const remainder = responseRange
        ? Buffer.concat([
            buffered.subarray(0, responseRange[0]),
            buffered.subarray(responseRange[1]),
          ])
        : buffered;
      if (remainder.length > 0) {
        try {
          stdin.unshift(remainder);
        } catch {
          // Ignore input restoration only when the stream has already ended.
        }
      }
      resolve(grid);
    };

    const onReadable = (): void => {
      let chunk: string | Buffer | null;
      while ((chunk = stdin.read() as string | Buffer | null) !== null) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
        buffered = Buffer.concat([buffered, bytes]);
        const response = findCursorPositionResponse(buffered);
        if (!response) continue;
        finish(response.grid, response.range);
        return;
      }
    };

    stdin.on("readable", onReadable);
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    try {
      stdin.setRawMode(true);
      enteredAlternateScreen = true;
      stdout.write(CPR_QUERY);
    } catch {
      finish(null);
      return;
    }
  });
}

/**
 * Start from the frontend grid as one coherent snapshot. The PTY can lag behind
 * on both axes (for example frontend 87x40 while the PTY still says 166x17), so
 * taking a per-axis minimum would invent a grid that exists in neither place.
 * Width remains conservatively capped by the PTY to protect Ink from wrapping
 * after a shrink; height stays authoritative to the frontend CPR snapshot.
 */
export function capTerminalGrid(
  stdout: NodeJS.WriteStream,
  frontendGrid: TerminalGrid,
): NodeJS.WriteStream {
  const frontend = {
    columns: normalizeDimension(frontendGrid.columns, 80),
    rows: normalizeDimension(frontendGrid.rows, 24),
  };
  const effectiveGrid = (): TerminalGrid => ({
    columns: Math.min(frontend.columns, normalizeDimension(stdout.columns, frontend.columns)),
    rows: frontend.rows,
  });

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

export async function resolveTuiRenderStdout(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<NodeJS.WriteStream> {
  if (env["CODEX_SHELL"] !== "1") return stdout;
  const frontendGrid = await probeTerminalGrid(stdin, stdout, timeoutMs);
  return frontendGrid ? capTerminalGrid(stdout, frontendGrid) : stdout;
}

function findCursorPositionResponse(
  buffer: Buffer,
): { grid: TerminalGrid; range: [number, number] } | null {
  const value = buffer.toString("latin1");
  const match = CPR_RESPONSE_PATTERN.exec(value);
  if (!match || match.index === undefined) return null;
  const rows = Number(match[1]);
  const columns = Number(match[2]);
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) {
    return null;
  }
  return {
    grid: { columns, rows },
    range: [match.index, match.index + match[0].length],
  };
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}
