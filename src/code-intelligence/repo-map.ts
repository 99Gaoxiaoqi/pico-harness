import { AsyncLocalStorage } from "node:async_hooks";
import { constants, realpathSync, type Dirent } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { WorkspaceRoots } from "../tools/workspace-roots.js";
import type {
  CodeCall,
  CodeDiagnostic,
  CodeIntelligenceQueryOptions,
  CodeIntelligenceService,
  CodeLocation,
  CodeRange,
  CodeSymbol,
  PositionQuery,
  SymbolQuery,
} from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".worktrees",
  ".cache",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cs",
]);
const MAX_SOURCE_BYTES = 1_000_000;
export const REPO_MAP_MAX_FILES = 200;
const DEFAULT_SCAN_BATCH = REPO_MAP_MAX_FILES;
const DEFAULT_RESULT_LIMIT = 100;

export interface RepoMapScanReport {
  /** 本次调用真正尝试读取的工作区相对源码路径，包含读取失败的条目。 */
  readonly scannedFiles: readonly string[];
}

interface RepoMapScanObserverContext {
  readonly observer: (report: RepoMapScanReport) => void;
  readonly parent?: RepoMapScanObserverContext;
  remaining?: number;
}

const repoMapScanObserver = new AsyncLocalStorage<RepoMapScanObserverContext>();

/** 将一次 Repo Map 调用的实际扫描集合绑定到当前异步执行链。 */
export function observeRepoMapScans<T>(
  observer: (report: RepoMapScanReport) => void,
  execute: () => Promise<T>,
  maxFiles?: number,
): Promise<T> {
  const parent = repoMapScanObserver.getStore();
  return repoMapScanObserver.run(
    {
      observer,
      ...(parent ? { parent } : {}),
      ...(maxFiles !== undefined ? { remaining: Math.max(0, maxFiles) } : {}),
    },
    execute,
  );
}

function repoMapObserverRemaining(): number | undefined {
  let context = repoMapScanObserver.getStore();
  let remaining: number | undefined;
  while (context) {
    if (context.remaining !== undefined) {
      remaining = Math.min(remaining ?? Number.POSITIVE_INFINITY, context.remaining);
    }
    context = context.parent;
  }
  return remaining;
}

function reportRepoMapScans(scannedFiles: readonly string[]): void {
  if (scannedFiles.length === 0) return;
  let context = repoMapScanObserver.getStore();
  while (context) {
    context.observer({ scannedFiles });
    if (context.remaining !== undefined) {
      context.remaining = Math.max(0, context.remaining - scannedFiles.length);
    }
    context = context.parent;
  }
}

interface IndexedSymbol extends CodeSymbol {
  readonly declarationLine: number;
  endLine: number;
}

interface IndexedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly symbols: readonly IndexedSymbol[];
}

interface RepoMapScanBatch {
  readonly indexed: readonly IndexedFile[];
  readonly scannedFiles: readonly string[];
}

export interface RepoMapSnapshot {
  readonly files: readonly {
    readonly filePath: string;
    readonly symbols: readonly CodeSymbol[];
    readonly score: number;
    readonly reasons: readonly string[];
  }[];
  readonly indexedFiles: number;
  readonly totalFiles: number;
  /** Stable offset of the next repository file to inspect. */
  readonly cursor: number;
  readonly complete: boolean;
  readonly limitReason?: "max_files";
}

/** 无 LSP 时的确定性静态后端：按需分批索引，不在 TUI 启动时全仓扫描。 */
export class RepoMapService implements CodeIntelligenceService {
  readonly backend = "repo-map" as const;
  private readonly rootDir: string;
  private readonly workspaceRoots: WorkspaceRoots;
  private discoveredFiles: readonly string[] | undefined;
  private nextFileIndex = 0;
  private readonly indexedFiles = new Map<string, IndexedFile>();
  private readonly scanBatchSize: number;
  private indexTail: Promise<void> = Promise.resolve();

  constructor(
    rootDir: string,
    scanBatchSize = DEFAULT_SCAN_BATCH,
    workspaceRoots = WorkspaceRoots.createSync(rootDir),
  ) {
    this.workspaceRoots = workspaceRoots;
    this.rootDir = realpathSync.native(path.resolve(rootDir));
    this.scanBatchSize = clampMaxFiles(scanBatchSize);
  }

  async definitions(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    const word = await this.wordAt(query.filePath, query.position.line, query.position.character);
    if (!word) return [];
    await this.scanUntil((file) => file.symbols.some((symbol) => symbol.name === word), options);
    return this.allSymbols()
      .filter((symbol) => symbol.name === word)
      .map((symbol) => symbol.location);
  }

  async references(
    query: PositionQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeLocation[]> {
    const word = await this.wordAt(query.filePath, query.position.line, query.position.character);
    if (!word) return [];
    await this.scanNext(this.scanBatchSize, options.signal);
    const matcher = identifierMatcher(word);
    const locations: CodeLocation[] = [];
    for (const file of this.indexedFiles.values()) {
      for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
        const line = file.lines[lineIndex] ?? "";
        matcher.lastIndex = 0;
        for (let match = matcher.exec(line); match; match = matcher.exec(line)) {
          locations.push({
            filePath: file.absolutePath,
            range: singleLineRange(lineIndex + 1, (match.index ?? 0) + 1, word.length),
          });
          if (locations.length >= DEFAULT_RESULT_LIMIT) return locations;
        }
      }
    }
    return locations;
  }

  async symbols(
    query: SymbolQuery,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeSymbol[]> {
    const limit = Math.max(1, query.limit ?? DEFAULT_RESULT_LIMIT);
    if (query.filePath) {
      const file = await this.indexFile(query.filePath, options.signal);
      return filterSymbols(file.symbols, query.query).slice(0, limit);
    }
    const hasEnough = (): boolean => filterSymbols(this.allSymbols(), query.query).length >= limit;
    await this.scanUntil(() => hasEnough(), options);
    return filterSymbols(this.allSymbols(), query.query).slice(0, limit);
  }

  async diagnostics(
    filePath: string,
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeDiagnostic[]> {
    await this.indexFile(filePath, options.signal);
    return [];
  }

  async callHierarchy(
    query: PositionQuery,
    direction: "incoming" | "outgoing",
    options: CodeIntelligenceQueryOptions = {},
  ): Promise<readonly CodeCall[]> {
    const originFile = await this.indexFile(query.filePath, options.signal);
    const word = wordAtPosition(originFile, query.position.line, query.position.character);
    if (!word) return [];
    await this.scanNext(this.scanBatchSize, options.signal);
    const origin =
      originFile.symbols.find(
        (symbol) =>
          symbol.name === word &&
          query.position.line >= symbol.declarationLine &&
          query.position.line <= symbol.endLine,
      ) ?? this.allSymbols().find((symbol) => symbol.name === word);
    if (!origin) return [];
    return direction === "incoming" ? this.incomingCalls(origin) : this.outgoingCalls(origin);
  }

  async snapshot(
    options: {
      readonly query?: string;
      readonly maxFiles?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RepoMapSnapshot> {
    await this.scanNext(clampMaxFiles(options.maxFiles ?? this.scanBatchSize), options.signal);
    const query = options.query?.trim().toLowerCase();
    const files = [...this.indexedFiles.values()]
      .map((file) => scoreRepoMapFile(file, query))
      .filter((file) => file.matched)
      .sort(
        (left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath),
      )
      .map(({ matched: _matched, ...file }) => file);
    const totalFiles = this.discoveredFiles?.length ?? 0;
    const complete = this.nextFileIndex >= totalFiles;
    return {
      files,
      indexedFiles: this.indexedFiles.size,
      totalFiles,
      cursor: this.nextFileIndex,
      complete,
      ...(!complete ? { limitReason: "max_files" as const } : {}),
    };
  }

  async close(): Promise<void> {
    await this.serializeIndex(async () => {
      this.indexedFiles.clear();
      this.discoveredFiles = undefined;
      this.nextFileIndex = 0;
    });
  }

  private async scanUntil(
    predicate: (file: IndexedFile) => boolean,
    options: CodeIntelligenceQueryOptions,
  ): Promise<void> {
    let attempted = 0;
    while (!this.isComplete() && attempted < this.scanBatchSize) {
      const { indexed, scannedFiles } = await this.scanNext(1, options.signal);
      if (scannedFiles.length === 0) return;
      attempted += scannedFiles.length;
      if (indexed.some(predicate)) return;
    }
  }

  private async scanNext(limit: number, signal?: AbortSignal): Promise<RepoMapScanBatch> {
    return this.serializeIndex(async () => {
      const observerLimit = repoMapObserverRemaining();
      const effectiveLimit = Math.min(
        clampMaxFiles(limit),
        observerLimit ?? Number.POSITIVE_INFINITY,
      );
      if (effectiveLimit <= 0) return { indexed: [], scannedFiles: [] };
      await this.discoverFiles();
      return await this.scanNextUnlocked(effectiveLimit, signal);
    });
  }

  private async scanNextUnlocked(limit: number, signal?: AbortSignal): Promise<RepoMapScanBatch> {
    await this.discoverFiles();
    const startIndex = this.nextFileIndex;
    const indexed: IndexedFile[] = [];
    while (
      this.nextFileIndex < (this.discoveredFiles?.length ?? 0) &&
      this.nextFileIndex - startIndex < limit
    ) {
      throwIfAborted(signal);
      const filePath = this.discoveredFiles?.[this.nextFileIndex++];
      if (!filePath) continue;
      reportRepoMapScans([filePath]);
      const file = await this.indexFileUnlocked(filePath, signal).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return undefined;
      });
      if (file) indexed.push(file);
    }
    return {
      indexed,
      scannedFiles: (this.discoveredFiles ?? []).slice(startIndex, this.nextFileIndex),
    };
  }

  private async discoverFiles(): Promise<void> {
    if (this.discoveredFiles) return;
    const output: string[] = [];
    for (const root of this.workspaceRoots.list()) {
      const info = await stat(root).catch(() => undefined);
      if (info?.isFile()) {
        if (SUPPORTED_EXTENSIONS.has(path.extname(root).toLowerCase())) {
          output.push(path.relative(this.rootDir, root));
        }
      } else {
        await collectSourceFiles(this.workspaceRoots, this.rootDir, root, output);
      }
    }
    this.discoveredFiles = [...new Set(output)].sort();
  }

  private isComplete(): boolean {
    return this.discoveredFiles !== undefined && this.nextFileIndex >= this.discoveredFiles.length;
  }

  private async indexFile(filePath: string, signal?: AbortSignal): Promise<IndexedFile> {
    return this.serializeIndex(async () => {
      if ((repoMapObserverRemaining() ?? 1) <= 0) {
        throw new Error("Repo Map 文件检查预算已耗尽");
      }
      const relativePath = path.relative(this.rootDir, path.resolve(this.rootDir, filePath));
      throwIfAborted(signal);
      reportRepoMapScans([relativePath]);
      return await this.indexFileUnlocked(filePath, signal);
    });
  }

  private async indexFileUnlocked(filePath: string, signal?: AbortSignal): Promise<IndexedFile> {
    throwIfAborted(signal);
    const absolutePath = await this.workspaceRoots.assertAllowed(filePath);
    const cached = this.indexedFiles.get(absolutePath);
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`Repo Map 只能索引普通文件: ${filePath}`);
      if (info.size > MAX_SOURCE_BYTES) {
        throw new Error(`Repo Map 跳过超过 ${MAX_SOURCE_BYTES} 字节的文件: ${filePath}`);
      }
      text = await readBoundedUtf8(handle, MAX_SOURCE_BYTES, filePath, signal);
    } finally {
      await handle.close();
    }
    if (cached?.text === text) return cached;
    const lines = text.split(/\r?\n/);
    const symbols = parseSymbols(absolutePath, lines);
    const indexed = {
      absolutePath,
      relativePath: path.relative(this.rootDir, absolutePath).replaceAll("\\", "/"),
      text,
      lines,
      symbols,
    } satisfies IndexedFile;
    this.indexedFiles.set(absolutePath, indexed);
    return indexed;
  }

  private serializeIndex<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.indexTail.then(operation, operation);
    this.indexTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async wordAt(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string | undefined> {
    const file = await this.indexFile(filePath);
    return wordAtPosition(file, line, character);
  }

  private allSymbols(): IndexedSymbol[] {
    return [...this.indexedFiles.values()].flatMap((file) => file.symbols);
  }

  private incomingCalls(origin: IndexedSymbol): CodeCall[] {
    const matcher = identifierMatcher(origin.name, true);
    const calls: CodeCall[] = [];
    for (const file of this.indexedFiles.values()) {
      for (const caller of file.symbols) {
        if (caller === origin) continue;
        const ranges = findMatches(file, matcher, caller.declarationLine, caller.endLine);
        if (ranges.length > 0) calls.push({ caller, callee: origin, ranges });
      }
    }
    return calls.slice(0, DEFAULT_RESULT_LIMIT);
  }

  private outgoingCalls(origin: IndexedSymbol): CodeCall[] {
    const originFile = this.indexedFiles.get(origin.location.filePath);
    if (!originFile) return [];
    const calls: CodeCall[] = [];
    for (const callee of this.allSymbols()) {
      if (callee === origin) continue;
      const ranges = findMatches(
        originFile,
        identifierMatcher(callee.name, true),
        origin.declarationLine,
        origin.endLine,
      );
      if (ranges.length > 0) calls.push({ caller: origin, callee, ranges });
    }
    return calls.slice(0, DEFAULT_RESULT_LIMIT);
  }
}

async function collectSourceFiles(
  workspaceRoots: WorkspaceRoots,
  rootDir: string,
  dir: string,
  output: string[],
): Promise<void> {
  let physicalDirectory: string;
  try {
    physicalDirectory = await workspaceRoots.assertAllowed(dir);
  } catch {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(physicalDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectSourceFiles(
          workspaceRoots,
          rootDir,
          path.join(physicalDirectory, entry.name),
          output,
        );
      }
      continue;
    }
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      continue;
    output.push(path.relative(rootDir, path.join(physicalDirectory, entry.name)));
  }
}

async function readBoundedUtf8(
  handle: FileHandle,
  maxBytes: number,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    throwIfAborted(signal);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new Error(`Repo Map 跳过超过 ${maxBytes} 字节的文件: ${filePath}`);
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function parseSymbols(filePath: string, lines: readonly string[]): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  const patterns: readonly { kind: string; regex: RegExp }[] = [
    { kind: "class", regex: /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "enum", regex: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    {
      kind: "function",
      regex: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: "variable",
      regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    },
    { kind: "class", regex: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/ },
    { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
    { kind: "function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
    { kind: "function", regex: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/ },
    { kind: "struct", regex: /\b(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: "trait", regex: /\b(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
  ];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      const name = match?.[1];
      if (!match || !name) continue;
      const nameOffset = line.indexOf(name, match.index);
      symbols.push({
        name,
        kind: pattern.kind,
        location: {
          filePath,
          range: singleLineRange(lineIndex + 1, nameOffset + 1, name.length),
        },
        declarationLine: lineIndex + 1,
        endLine: lines.length,
      });
      break;
    }
  }
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    if (symbol) symbol.endLine = (symbols[index + 1]?.declarationLine ?? lines.length + 1) - 1;
  }
  return symbols;
}

function filterSymbols(symbols: readonly IndexedSymbol[], query?: string): IndexedSymbol[] {
  const needle = query?.trim().toLowerCase();
  return needle
    ? symbols.filter((symbol) => symbol.name.toLowerCase().includes(needle))
    : [...symbols];
}

function clampMaxFiles(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SCAN_BATCH;
  return Math.min(REPO_MAP_MAX_FILES, Math.max(1, Math.trunc(value)));
}

function scoreRepoMapFile(
  file: IndexedFile,
  query?: string,
): {
  readonly filePath: string;
  readonly symbols: readonly CodeSymbol[];
  readonly score: number;
  readonly reasons: readonly string[];
  readonly matched: boolean;
} {
  if (!query) {
    return {
      filePath: file.relativePath,
      symbols: file.symbols,
      score: 1,
      reasons: ["indexed"],
      matched: true,
    };
  }

  const normalizedPath = file.relativePath.toLowerCase();
  const baseName = path.basename(normalizedPath);
  const matchingSymbols = file.symbols.filter((symbol) =>
    symbol.name.toLowerCase().includes(query),
  );
  const exactSymbol = matchingSymbols.some((symbol) => symbol.name.toLowerCase() === query);
  const prefixSymbol = matchingSymbols.some((symbol) =>
    symbol.name.toLowerCase().startsWith(query),
  );
  const reasons: string[] = [];
  let pathScore = 0;
  let symbolScore = 0;

  if (normalizedPath === query) {
    pathScore = 100;
    reasons.push("path_exact");
  } else if (baseName === query) {
    pathScore = 95;
    reasons.push("basename_exact");
  } else if (normalizedPath.startsWith(query)) {
    pathScore = 80;
    reasons.push("path_prefix");
  } else if (baseName.startsWith(query)) {
    pathScore = 75;
    reasons.push("basename_prefix");
  } else if (normalizedPath.includes(query)) {
    pathScore = 60;
    reasons.push("path_contains");
  }

  if (exactSymbol) {
    symbolScore = 90;
    reasons.push("symbol_exact");
  } else if (prefixSymbol) {
    symbolScore = 70;
    reasons.push("symbol_prefix");
  } else if (matchingSymbols.length > 0) {
    symbolScore = 50;
    reasons.push("symbol_contains");
  }

  return {
    filePath: file.relativePath,
    symbols: pathScore > 0 ? file.symbols : matchingSymbols,
    score: pathScore + symbolScore,
    reasons,
    matched: pathScore > 0 || symbolScore > 0,
  };
}

function wordAtPosition(file: IndexedFile, line: number, character: number): string | undefined {
  const sourceLine = file.lines[Math.max(0, line - 1)];
  if (sourceLine === undefined) return undefined;
  const offset = Math.min(Math.max(0, character - 1), sourceLine.length);
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w$]/.test(sourceLine[start - 1] ?? "")) start--;
  while (end < sourceLine.length && /[\w$]/.test(sourceLine[end] ?? "")) end++;
  const word = sourceLine.slice(start, end);
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : undefined;
}

function identifierMatcher(identifier: string, callsOnly = false): RegExp {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b${callsOnly ? "(?=\\s*\\()" : ""}`, "g");
}

function findMatches(
  file: IndexedFile,
  matcher: RegExp,
  startLine: number,
  endLine: number,
): CodeRange[] {
  const ranges: CodeRange[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const line = file.lines[lineNumber - 1] ?? "";
    matcher.lastIndex = 0;
    for (let match = matcher.exec(line); match; match = matcher.exec(line)) {
      ranges.push(singleLineRange(lineNumber, (match.index ?? 0) + 1, match[0].length));
    }
  }
  return ranges;
}

function singleLineRange(line: number, character: number, length: number): CodeRange {
  return {
    start: { line, character },
    end: { line, character: character + length },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Repo Map 索引已取消");
}
