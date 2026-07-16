import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import type { HookHandler } from "../types.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ReferencedPackageScript {
  readonly manager: PackageManager;
  readonly scriptName: string;
  readonly manifestPath: string;
  readonly canonicalManifestPath: string;
  readonly state: "missing" | "unreadable" | "invalid" | "resolved";
  readonly definitions: Readonly<Record<string, string | null>>;
}

export interface ReferencedScriptResolution {
  readonly paths: readonly string[];
  readonly watchPaths: readonly string[];
  readonly packageScripts: readonly ReferencedPackageScript[];
}

/** Package target selectors inherited from the host must not retarget a trusted invocation. */
export function sanitizePackageInvocationEnvironment(
  handler: Extract<HookHandler, { type: "command" }>,
  baseEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment, ...handler.env };
  const tokens = commandTokens(handler);
  const manager = referencedPackageManager(
    handler.args === undefined ? handler.command : [handler.command, ...handler.args].join(" "),
  );
  if (!manager || !unwrapPackageInvocation(tokens, manager)) return { ...environment };
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !isPackageSelectorEnvironmentName(name)),
  );
  for (const name of Object.keys(handler.env ?? {}).filter(isPackageConfigurationSourceName)) {
    const inherited = environmentValue(baseEnvironment, name);
    if (inherited === undefined) delete sanitized[name];
    else sanitized[name] = inherited;
  }
  return sanitized;
}

/**
 * Resolve only explicit script references. Package-manager commands are read, never executed,
 * and resolution is deliberately limited to the workspace package.json and its direct files.
 */
export async function resolveReferencedScripts(
  handler: HookHandler,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ReferencedScriptResolution> {
  if (handler.type !== "command") return { paths: [], watchPaths: [], packageScripts: [] };
  const tokens = commandTokens(handler);
  const packageTokens = packageInvocationTokens(handler, tokens);
  const paths = [...referencedPathCandidates(tokens, workspace)];
  const invocation = packageTokens ? packageRunInvocation(packageTokens) : undefined;
  const packageScripts: ReferencedPackageScript[] = [];
  if (invocation) {
    assertNoInheritedPackageSelectorEnvironment(environment, invocation.manager);
    paths.push(
      ...(await resolvePackageConfigurationPaths(workspace, environment, invocation.manager)),
    );
    const resolved = await resolvePackageScript(invocation, workspace);
    packageScripts.push(resolved.reference);
    paths.push(...resolved.paths);
  }
  const uniquePaths = sortedUnique(paths);
  const canonicalPaths = await canonicalExistingPaths(uniquePaths);
  return {
    paths: uniquePaths,
    watchPaths: sortedUnique([
      ...uniquePaths,
      ...canonicalPaths,
      ...packageScripts.flatMap((entry) => [entry.manifestPath, entry.canonicalManifestPath]),
    ]),
    packageScripts,
  };
}

async function resolvePackageConfigurationPaths(
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  manager: PackageManager,
): Promise<readonly string[]> {
  const candidates = packageConfigurationCandidates(workspace, environment);
  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw unsupportedPackageInvocation(manager, `无法安全读取 package-manager 配置 ${path}`);
    }
    const selector = packageSelectorConfigurationKey(raw);
    if (selector) {
      throw unsupportedPackageInvocation(
        manager,
        `package-manager 配置 ${path} 通过 ${selector} 改变 package.json 目标`,
      );
    }
  }
  return candidates;
}

function packageConfigurationCandidates(
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  const candidates: string[] = [];
  let current = normalize(resolve(workspace));
  for (;;) {
    candidates.push(resolve(current, ".npmrc"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const userHome =
    environmentValue(environment, "HOME") ??
    environmentValue(environment, "USERPROFILE") ??
    homedir();
  if (userHome) candidates.push(resolve(userHome, ".npmrc"));
  return sortedUnique(candidates);
}

function packageSelectorConfigurationKey(raw: string): string | undefined {
  for (const sourceLine of raw.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    const rawKey = separator < 0 ? line.split(/[\s#;]/u, 1)[0] : line.slice(0, separator);
    const key = (rawKey ?? "").trim().replace(/\[\]$/u, "").toLowerCase().replace(/_/gu, "-");
    if (key && PACKAGE_SELECTOR_CONFIGURATION_KEYS.has(key)) return key;
  }
  return undefined;
}

function assertNoInheritedPackageSelectorEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  manager: PackageManager,
): void {
  const selector = Object.keys(environment).find(isPackageSelectorEnvironmentName);
  if (selector) {
    throw unsupportedPackageInvocation(
      manager,
      `继承环境变量 ${selector} 会改变 package.json 目标`,
    );
  }
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  expectedName: string,
): string | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toLowerCase() === expectedName.toLowerCase(),
  );
  return actualName ? environment[actualName] : undefined;
}

/** Preserve the original direct-path behavior for callers that only need lexical candidates. */
export function resolveReferencedScriptCandidates(
  handler: HookHandler,
  workspace: string,
): readonly string[] {
  if (handler.type !== "command") return [];
  return referencedPathCandidates(commandTokens(handler), workspace);
}

export async function existingReferencedScripts(
  handler: HookHandler,
  workspace: string,
): Promise<readonly string[]> {
  const { paths } = await resolveReferencedScripts(handler, workspace);
  const existing: string[] = [];
  for (const path of paths) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      existing.push(await realpath(path));
    }
  }
  return sortedUnique(existing);
}

interface PackageRunInvocation {
  readonly manager: PackageManager;
  readonly scriptName: string;
  readonly lifecycle: "standard" | "npm-restart" | "npm-start";
}

async function resolvePackageScript(
  invocation: PackageRunInvocation,
  workspace: string,
): Promise<{ reference: ReferencedPackageScript; paths: readonly string[] }> {
  const manifestPath = normalize(resolve(workspace, "package.json"));
  let canonicalManifestPath = manifestPath;
  let raw: string;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return packageResolution(invocation, manifestPath, canonicalManifestPath, "invalid");
    }
    canonicalManifestPath = await realpath(manifestPath);
    raw = await readFile(canonicalManifestPath, "utf8");
  } catch (error) {
    return packageResolution(
      invocation,
      manifestPath,
      canonicalManifestPath,
      isErrno(error, "ENOENT") ? "missing" : "unreadable",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return packageResolution(invocation, manifestPath, canonicalManifestPath, "invalid");
  }
  if (!isRecord(parsed)) {
    return packageResolution(invocation, manifestPath, canonicalManifestPath, "resolved");
  }
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};

  const graph = resolvePackageScriptGraph(invocation, scripts, dirname(manifestPath));
  return {
    reference: {
      manager: invocation.manager,
      scriptName: invocation.scriptName,
      manifestPath,
      canonicalManifestPath,
      state: "resolved",
      definitions: graph.definitions,
    },
    paths: graph.paths,
  };
}

interface PackageScriptGraph {
  readonly definitions: Readonly<Record<string, string | null>>;
  readonly paths: readonly string[];
}

function resolvePackageScriptGraph(
  root: PackageRunInvocation,
  scripts: Readonly<Record<string, unknown>>,
  packageDirectory: string,
): PackageScriptGraph {
  const definitions = new Map<string, string | null>();
  const paths = new Set<string>();
  const visited = new Set<string>();

  const visit = (invocation: PackageRunInvocation, depth: number): void => {
    const invocationKey = packageInvocationKey(invocation);
    if (visited.has(invocationKey)) return;
    if (depth > MAX_NESTED_PACKAGE_SCRIPT_DEPTH) {
      throw unsupportedPackageInvocation(
        invocation.manager,
        `嵌套 package script 超过 ${MAX_NESTED_PACKAGE_SCRIPT_DEPTH} 层`,
      );
    }
    visited.add(invocationKey);

    for (const name of packageLifecycleNames(invocation, scripts)) {
      const definition = packageScriptDefinition(invocation, name, scripts[name]);
      definitions.set(`${invocationKey}#${encodeURIComponent(name)}`, definition);
      if (definition === null) continue;
      for (const segment of splitSimpleShellCommands(definition)) {
        for (const path of referencedPathCandidates(shellWords(segment), packageDirectory)) {
          paths.add(path);
        }
      }
      for (const nested of nestedPackageInvocations(definition)) visit(nested, depth + 1);
    }
  };

  visit(root, 0);
  return {
    definitions: Object.fromEntries(definitions),
    paths: sortedUnique([...paths]),
  };
}

function packageInvocationKey(invocation: PackageRunInvocation): string {
  return `${invocation.manager}:${invocation.lifecycle}:${encodeURIComponent(invocation.scriptName)}`;
}

function packageResolution(
  invocation: PackageRunInvocation,
  manifestPath: string,
  canonicalManifestPath: string,
  state: ReferencedPackageScript["state"],
): { reference: ReferencedPackageScript; paths: readonly string[] } {
  return {
    reference: {
      manager: invocation.manager,
      scriptName: invocation.scriptName,
      manifestPath,
      canonicalManifestPath,
      state,
      definitions: {},
    },
    paths: [],
  };
}

function packageRunInvocation(tokens: readonly string[]): PackageRunInvocation | undefined {
  const executable = tokens[0];
  if (!executable) return undefined;
  const manager = packageManager(executable);
  if (!manager) return undefined;
  assertNoUnsupportedPackageSelectors(tokens, manager);

  const actionPosition = nextPackageArgument(tokens, 1, manager);
  if (!actionPosition) return undefined;
  const action = actionPosition.value;
  if (isPackageRunAction(manager, action)) {
    const scriptPosition = nextPackageArgument(tokens, actionPosition.nextIndex, manager, true);
    if (!scriptPosition) return undefined;
    return {
      manager,
      scriptName: scriptPosition.value,
      lifecycle: packageLifecycle(manager, scriptPosition.value),
    };
  }

  return directPackageScript(manager, action);
}

interface PackageArgument {
  readonly value: string;
  readonly nextIndex: number;
}

function nextPackageArgument(
  tokens: readonly string[],
  startIndex: number,
  manager: PackageManager,
  delimiterIntroducesValue = false,
): PackageArgument | undefined {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return undefined;
    if (!token.startsWith("-")) return { value: token, nextIndex: index + 1 };
    if (token === "--") {
      const value = delimiterIntroducesValue ? tokens[index + 1] : undefined;
      return value ? { value, nextIndex: index + 2 } : undefined;
    }

    const separator = token.indexOf("=");
    const option = separator === -1 ? token : token.slice(0, separator);
    const behavior = packageOptionBehavior(manager, option);
    if (behavior === "flag") {
      index += 1;
      continue;
    }
    if (behavior === "value") {
      if (separator !== -1) {
        index += 1;
        continue;
      }
      if (!tokens[index + 1]) return undefined;
      index += 2;
      continue;
    }
    if (behavior === "terminal") return undefined;
    throw unsupportedPackageInvocation(manager, `无法安全解析选项 ${option}`);
  }
  return undefined;
}

function isPackageRunAction(manager: PackageManager, action: string): boolean {
  return (
    action === "run" ||
    (manager === "npm" && NPM_RUN_ALIASES.has(action)) ||
    (manager === "pnpm" && action === "run-script")
  );
}

type PackageOptionBehavior = "flag" | "value" | "terminal" | "unsupported";

function packageOptionBehavior(manager: PackageManager, option: string): PackageOptionBehavior {
  if (TERMINAL_PACKAGE_OPTIONS.has(option)) return "terminal";
  if (UNSUPPORTED_PACKAGE_OPTIONS[manager].has(option)) return "unsupported";
  if (PACKAGE_FLAG_OPTIONS[manager].has(option)) return "flag";
  if (PACKAGE_VALUE_OPTIONS[manager].has(option)) return "value";
  return "unsupported";
}

function directPackageScript(
  manager: PackageManager,
  action: string,
): PackageRunInvocation | undefined {
  if (manager === "npm") {
    const scriptName = NPM_LIFECYCLE_SHORTHANDS[action];
    if (!scriptName) return undefined;
    return {
      manager,
      scriptName,
      lifecycle: packageLifecycle(manager, scriptName),
    };
  }
  if (manager === "pnpm") {
    const scriptName = PNPM_LIFECYCLE_SHORTHANDS[action];
    if (scriptName) return { manager, scriptName, lifecycle: "standard" };
  }
  if (NON_DIRECT_SCRIPT_COMMANDS[manager].has(action)) return undefined;
  if (manager === "bun" && looksLikePath(action)) return undefined;
  return { manager, scriptName: action, lifecycle: "standard" };
}

function packageLifecycleNames(
  invocation: PackageRunInvocation,
  scripts: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (invocation.lifecycle === "npm-restart" && typeof scripts.restart !== "string") {
    return [
      "prerestart",
      "prestop",
      "stop",
      "poststop",
      "prestart",
      "start",
      "poststart",
      "postrestart",
    ];
  }
  return [`pre${invocation.scriptName}`, invocation.scriptName, `post${invocation.scriptName}`];
}

function packageScriptDefinition(
  invocation: PackageRunInvocation,
  name: string,
  definition: unknown,
): string | null {
  if (typeof definition === "string") return definition;
  if (
    (invocation.lifecycle === "npm-start" || invocation.lifecycle === "npm-restart") &&
    name === "start"
  ) {
    return "node server.js";
  }
  return null;
}

function packageLifecycle(
  manager: PackageManager,
  scriptName: string,
): PackageRunInvocation["lifecycle"] {
  if (manager !== "npm") return "standard";
  if (scriptName === "restart") return "npm-restart";
  if (scriptName === "start") return "npm-start";
  return "standard";
}

function nestedPackageInvocations(definition: string): readonly PackageRunInvocation[] {
  const manager = referencedPackageManager(definition);
  const dynamicExecutable = looksLikeDynamicPackageInvocation(definition);
  if (!manager && !dynamicExecutable) return [];
  const selectorEnvironment = packageSelectorEnvironmentAssignment(definition);
  if (selectorEnvironment) {
    throw unsupportedNestedPackageInvocation(
      `嵌套脚本通过环境变量 ${selectorEnvironment} 改变 package.json 目标`,
      manager,
    );
  }
  if (hasDisplayOnlyPackagePipeline(definition)) {
    throw unsupportedNestedPackageInvocation(
      "display-only 命令可通过管道执行未绑定的 package script",
      manager,
    );
  }

  const segments = splitSimpleShellCommands(definition);
  if (segments.some(changesPackageDirectory)) {
    throw unsupportedNestedPackageInvocation(
      "嵌套脚本会改变或动态决定 package.json 的工作目录",
      manager,
    );
  }

  const invocations: PackageRunInvocation[] = [];
  for (const segment of segments) {
    if (!referencedPackageManager(segment)) continue;
    const handler = { type: "command", command: segment } as const;
    const tokens = commandTokens(handler);
    const packageTokens = packageInvocationTokens(handler, tokens);
    if (!packageTokens) continue;
    const invocation = packageRunInvocation(packageTokens);
    if (!invocation) {
      if (packageTokens.some(hasDynamicShellToken)) {
        throw unsupportedNestedPackageInvocation("嵌套 package-manager action 不是静态值", manager);
      }
      continue;
    }
    assertStaticPackageScriptName(invocation, manager);
    invocations.push(invocation);
  }
  if (dynamicExecutable) {
    throw unsupportedNestedPackageInvocation("嵌套 package-manager 可执行文件不是静态值", manager);
  }
  return invocations;
}

function packageSelectorEnvironmentAssignment(definition: string): string | undefined {
  for (const segment of splitShellCommands(definition, false)) {
    for (const token of shellWords(segment)) {
      const name = environmentAssignmentName(token);
      if (name && isExplicitPackageConfigurationEnvironmentName(name)) return name;
    }
  }
  return undefined;
}

function hasDisplayOnlyPackagePipeline(definition: string): boolean {
  if (!hasShellPipeline(definition)) return false;
  return splitShellCommands(definition, false).some((segment) => {
    if (!referencedPackageManager(segment)) return false;
    const tokens = shellWords(segment);
    const firstCommand = tokens.find((token) => !isEnvironmentAssignment(token));
    return isDisplayOnlyPackageReference(tokens, firstCommand);
  });
}

function hasShellPipeline(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
      return true;
    }
  }
  return false;
}

function assertStaticPackageScriptName(
  invocation: PackageRunInvocation,
  parentManager: PackageManager | undefined,
): void {
  if (
    invocation.scriptName.length === 0 ||
    /[$`*?[\]{}()<>;&|\\~\r\n]/u.test(invocation.scriptName)
  ) {
    throw unsupportedNestedPackageInvocation(
      `嵌套 package script 名不是静态值: ${invocation.scriptName}`,
      parentManager ?? invocation.manager,
    );
  }
}

function hasDynamicShellToken(token: string): boolean {
  return /[$`*?[\]{}()<>;&|\\~\r\n]/u.test(token);
}

function looksLikeDynamicPackageInvocation(definition: string): boolean {
  return splitShellCommands(definition, false).some((segment) => {
    const tokens = shellWords(segment);
    let index = skipEnvironmentAssignments(tokens, 0);
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token) return false;
      if (isDynamicShellExecutable(token)) return true;
      const name = executableName(token);
      if (name === "env") {
        index = skipDynamicEnvWrapper(tokens, index + 1);
        index = skipEnvironmentAssignments(tokens, index);
        continue;
      }
      if (name === "command") {
        index = skipDynamicCommandWrapper(tokens, index + 1);
        if (index < 0) return false;
        continue;
      }
      if (name === "exec") {
        index += 1;
        if (tokens[index] === "--") index += 1;
        if (tokens[index]?.startsWith("-")) {
          return tokens.slice(index + 1).some(isDynamicShellExecutable);
        }
        continue;
      }
      return false;
    }
    return false;
  });
}

function skipDynamicEnvWrapper(tokens: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return index;
    if (token === "--") return index + 1;
    if (isEnvironmentAssignment(token) || !token.startsWith("-")) return index;
    if (token === "-u" || token === "--unset") {
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function skipDynamicCommandWrapper(tokens: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (token === "-p") {
      index += 1;
      continue;
    }
    if (token === "-v" || token === "-V") return -1;
    return index;
  }
  return index;
}

function isDynamicShellExecutable(token: string): boolean {
  return /[$`]/u.test(token) || /%[^%]+%/u.test(token) || /![^!]+!/u.test(token);
}

function changesPackageDirectory(segment: string): boolean {
  const tokens = shellWords(segment);
  let index = skipEnvironmentAssignments(tokens, 0);
  let name = executableName(tokens[index] ?? "");
  while (name === "command" || name === "builtin") {
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      if (tokens[index] === "--") {
        index += 1;
        break;
      }
      index += 1;
    }
    name = executableName(tokens[index] ?? "");
  }
  return PACKAGE_DIRECTORY_COMMANDS.has(name) || DYNAMIC_SHELL_CONTEXT_COMMANDS.has(name);
}

function splitSimpleShellCommands(command: string): readonly string[] {
  const manager = referencedPackageManager(command);
  const strict = manager !== undefined || looksLikeDynamicPackageInvocation(command);
  return splitShellCommands(command, strict, manager);
}

function splitShellCommands(
  command: string,
  strict: boolean,
  manager?: PackageManager,
): readonly string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === undefined) continue;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      current += character;
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      current += character;
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (strict && (character === "`" || (character === "$" && command[index + 1] === "("))) {
        throw unsupportedNestedPackageInvocation("嵌套 package script 含动态 shell 展开", manager);
      }
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }
    if (
      strict &&
      ("`(){}<>".includes(character) || (character === "$" && command[index + 1] === "("))
    ) {
      throw unsupportedNestedPackageInvocation("嵌套 package script 含复杂 shell 语法", manager);
    }
    if (";&|\n\r".includes(character)) {
      push();
      if ((character === "&" || character === "|") && command[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    current += character;
  }
  if (strict && quote !== undefined) {
    throw unsupportedNestedPackageInvocation("嵌套 package script 引号未闭合", manager);
  }
  push();
  return segments;
}

function unsupportedNestedPackageInvocation(reason: string, manager?: PackageManager): Error {
  return manager
    ? unsupportedPackageInvocation(manager, reason)
    : new Error(`不支持为动态 package-manager Hook 建立间接脚本信任: ${reason}`);
}

function assertNoUnsupportedPackageSelectors(
  tokens: readonly string[],
  manager: PackageManager,
): void {
  for (const token of tokens.slice(1)) {
    if (token === "--") return;
    if (!token.startsWith("-")) continue;
    const separator = token.indexOf("=");
    const option = separator === -1 ? token : token.slice(0, separator);
    if (UNSUPPORTED_PACKAGE_OPTIONS[manager].has(option)) {
      throw unsupportedPackageInvocation(manager, `选择器 ${option} 会改变 package.json 目标`);
    }
  }
}

function packageInvocationTokens(
  handler: Extract<HookHandler, { type: "command" }>,
  tokens: readonly string[],
): readonly string[] | undefined {
  const commandText =
    handler.args === undefined ? handler.command : [handler.command, ...handler.args].join(" ");
  const manager = referencedPackageManager(commandText);
  if (!manager) return undefined;

  const unwrapped = unwrapPackageInvocation(tokens, manager);
  if (handler.args === undefined && hasShellControlSyntax(handler.command)) {
    throw unsupportedPackageInvocation(manager, "shell 组合可能执行未绑定的间接脚本");
  }
  if (unwrapped) {
    assertNoExplicitPackageSelectorEnvironment(handler, tokens, manager);
    return unwrapped;
  }

  const firstCommand = tokens.find((token) => !isEnvironmentAssignment(token));
  if (isDisplayOnlyPackageReference(tokens, firstCommand)) return undefined;
  throw unsupportedPackageInvocation(
    manager,
    `无法证明前置命令 ${firstCommand ? executableName(firstCommand) : "<missing>"} 不会执行包管理器`,
  );
}

function assertNoExplicitPackageSelectorEnvironment(
  handler: Extract<HookHandler, { type: "command" }>,
  tokens: readonly string[],
  manager: PackageManager,
): void {
  const names = [
    ...Object.keys(handler.env ?? {}),
    ...tokens.flatMap((token) => {
      const name = environmentAssignmentName(token);
      return name ? [name] : [];
    }),
  ];
  const selector = names.find(isExplicitPackageConfigurationEnvironmentName);
  if (selector) {
    throw unsupportedPackageInvocation(manager, `环境变量 ${selector} 会改变 package.json 目标`);
  }
}

function isDisplayOnlyPackageReference(
  tokens: readonly string[],
  firstCommand: string | undefined,
): boolean {
  if (!firstCommand) return false;
  const name = executableName(firstCommand);
  if (DISPLAY_ONLY_COMMANDS.has(name)) return true;
  return name === "command" && tokens.some((token) => token === "-v" || token === "-V");
}

function unwrapPackageInvocation(
  tokens: readonly string[],
  manager: PackageManager,
): readonly string[] | undefined {
  let index = skipEnvironmentAssignments(tokens, 0);
  while (index < tokens.length) {
    const executable = tokens[index];
    if (!executable) return undefined;
    if (packageManager(executable)) return tokens.slice(index);

    const name = executableName(executable);
    if (name === "env") {
      index = consumeEnvWrapper(tokens, index + 1, manager);
      index = skipEnvironmentAssignments(tokens, index);
      continue;
    }
    if (name === "command") {
      index = consumeCommandWrapper(tokens, index + 1, manager);
      if (index < 0) return undefined;
      continue;
    }
    if (name === "exec") {
      index += 1;
      if (tokens[index] === "--") index += 1;
      if (tokens[index]?.startsWith("-")) {
        throw unsupportedPackageInvocation(manager, `无法安全解析 exec 选项 ${tokens[index]}`);
      }
      continue;
    }
    return undefined;
  }
  return undefined;
}

function consumeEnvWrapper(
  tokens: readonly string[],
  startIndex: number,
  manager: PackageManager,
): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return index;
    if (token === "--") return index + 1;
    if (isEnvironmentAssignment(token)) return index;
    if (!token.startsWith("-")) return index;
    if (
      token === "-i" ||
      token === "--ignore-environment" ||
      token === "-0" ||
      token === "--null"
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("--unset=")) {
      index += 1;
      continue;
    }
    if (token === "-u" || token === "--unset") {
      if (!tokens[index + 1]) {
        throw unsupportedPackageInvocation(manager, `${token} 缺少环境变量名`);
      }
      index += 2;
      continue;
    }
    throw unsupportedPackageInvocation(manager, `无法安全解析 env 选项 ${token}`);
  }
  return index;
}

function consumeCommandWrapper(
  tokens: readonly string[],
  startIndex: number,
  manager: PackageManager,
): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return index + 1;
    if (token === "-p") {
      index += 1;
      continue;
    }
    if (token === "-v" || token === "-V") return -1;
    if (token?.startsWith("-")) {
      throw unsupportedPackageInvocation(manager, `无法安全解析 command 选项 ${token}`);
    }
    return index;
  }
  return index;
}

function skipEnvironmentAssignments(tokens: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (isEnvironmentAssignment(tokens[index] ?? "")) index += 1;
  return index;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function environmentAssignmentName(token: string): string | undefined {
  return token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u)?.[1];
}

function isPackageSelectorEnvironmentName(name: string): boolean {
  return PACKAGE_SELECTOR_ENVIRONMENT_NAMES.has(normalizePackageEnvironmentName(name));
}

function isPackageConfigurationSourceName(name: string): boolean {
  return PACKAGE_CONFIGURATION_SOURCE_ENVIRONMENT_NAMES.has(normalizePackageEnvironmentName(name));
}

function normalizePackageEnvironmentName(name: string): string {
  return name.toLowerCase().replace(/-/gu, "_").replace(/\[\]$/u, "");
}

function isExplicitPackageConfigurationEnvironmentName(name: string): boolean {
  return isPackageSelectorEnvironmentName(name) || isPackageConfigurationSourceName(name);
}

function referencedPackageManager(command: string): PackageManager | undefined {
  const match = command.match(/\b(npm|pnpm|yarn|bun)(?:\.cmd)?\b/iu)?.[1]?.toLowerCase();
  return match === "npm" || match === "pnpm" || match === "yarn" || match === "bun"
    ? match
    : undefined;
}

function hasShellControlSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || (character === "$" && command[index + 1] === "(")) return true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (";&|<>`(){}\n\r".includes(character)) return true;
    if (character === "$" && command[index + 1] === "(") return true;
  }
  return false;
}

function unsupportedPackageInvocation(manager: PackageManager, reason: string): Error {
  return new Error(`不支持为该 ${manager} Hook 建立间接脚本信任: ${reason}`);
}

const NPM_LIFECYCLE_SHORTHANDS: Readonly<Record<string, string>> = {
  test: "test",
  t: "test",
  tst: "test",
  start: "start",
  stop: "stop",
  restart: "restart",
};

const NPM_RUN_ALIASES = wordSet("run-script rum urn");

const PNPM_LIFECYCLE_SHORTHANDS: Readonly<Record<string, string>> = {
  test: "test",
  t: "test",
  start: "start",
};

const TERMINAL_PACKAGE_OPTIONS = wordSet("-h --help -v --version --revision");
const MAX_NESTED_PACKAGE_SCRIPT_DEPTH = 32;

const DISPLAY_ONLY_COMMANDS = wordSet("echo printf type which where whence hash");
const PACKAGE_DIRECTORY_COMMANDS = wordSet("cd pushd popd");
const DYNAMIC_SHELL_CONTEXT_COMMANDS = wordSet(". source eval alias unalias");
const PACKAGE_SELECTOR_ENVIRONMENT_NAMES = wordSet(
  "npm_config_workspace npm_config_workspaces npm_config_include_workspace_root npm_config_prefix npm_config_dir npm_config_filter npm_config_recursive npm_config_workspace_root npm_config_global npm_config_location npm_config_cwd npm_config_local_prefix npm_config_global_prefix npm_config_userconfig npm_config_globalconfig",
);
const PACKAGE_CONFIGURATION_SOURCE_ENVIRONMENT_NAMES = wordSet("home userprofile");
const PACKAGE_SELECTOR_CONFIGURATION_KEYS = wordSet(
  "workspace workspaces include-workspace-root prefix dir filter recursive workspace-root global location cwd local-prefix global-prefix userconfig globalconfig",
);

const PACKAGE_FLAG_OPTIONS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
  npm: wordSet(
    "-s --silent --if-present --ignore-scripts --foreground-scripts --color --no-color --json --timing",
  ),
  pnpm: wordSet(
    "-s --silent --if-present --stream --aggregate-output --parallel --sequential --color --no-color --use-stderr --reverse --sort",
  ),
  yarn: wordSet(
    "-s --silent --verbose --json --no-progress --non-interactive --offline --ignore-scripts --ignore-engines",
  ),
  bun: wordSet(
    "--silent --if-present --no-install --prefer-offline --prefer-latest --watch --hot --smol --no-clear-screen --bun -b --no-env-file",
  ),
};

const PACKAGE_VALUE_OPTIONS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
  npm: wordSet("--loglevel --script-shell"),
  pnpm: wordSet("--reporter --loglevel"),
  yarn: wordSet("--network-timeout --mutex --registry"),
  bun: wordSet("--shell --env-file --config -c --preload -r --require --import --install"),
};

/** These selectors can change the package.json being executed and need separate resolution. */
const UNSUPPORTED_PACKAGE_OPTIONS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
  npm: wordSet("--workspace -w --workspaces --include-workspace-root --prefix"),
  pnpm: wordSet("--dir -C --filter -F --recursive -r --workspace-root -w --resume-from"),
  yarn: wordSet("--cwd --focus"),
  bun: wordSet("--cwd --filter -F --workspaces"),
};

const NON_DIRECT_SCRIPT_COMMANDS: Readonly<
  Record<Exclude<PackageManager, "npm">, ReadonlySet<string>>
> = {
  pnpm: wordSet(
    "add audit approve-builds bin c cache cat-file cat-index completion config create dedupe deploy dlx doctor env exec fetch find-hash help i ignored-builds import info init install install-test it licenses link list ln ls outdated pack patch patch-commit patch-remove pkg prune publish rb rebuild remove rm root self-update server setup store unlink uninstall up update upgrade view why",
  ),
  yarn: wordSet(
    "add audit autoclean bin cache check config constraints create dedupe dlx exec explain generate-lock-entry global help import info init install licenses link list login logout node npm outdated owner pack patch patch-commit plugin policies publish rebuild remove search self-update set stage tag team unlink unplug unset up upgrade upgrade-interactive version versions why workspace workspaces",
  ),
  bun: wordSet(
    "a add audit build c create exec feedback help i info init install link outdated patch pm publish remove repl rm unlink update upgrade why x",
  ),
};

function wordSet(words: string): ReadonlySet<string> {
  return new Set(words.split(/\s+/u));
}

function packageManager(executable: string): PackageManager | undefined {
  const name = executableName(executable);
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

function executableName(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, "");
}

function commandTokens(handler: Extract<HookHandler, { type: "command" }>): readonly string[] {
  return handler.args ? [handler.command, ...handler.args] : shellWords(handler.command);
}

function referencedPathCandidates(tokens: readonly string[], basePath: string): readonly string[] {
  return sortedUnique(tokens.filter(looksLikePath).map((token) => resolve(basePath, token)));
}

function shellWords(command: string): string[] {
  return (
    command
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((part) => part.replace(/^(['"])(.*)\1$/u, "$2")) ?? []
  );
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl)$/u.test(value)
  );
}

async function canonicalExistingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const canonical: string[] = [];
  for (const path of paths) {
    try {
      canonical.push(await realpath(path));
    } catch {
      // The logical path is still watched. Trust hashing handles unreadable files fail-closed.
    }
  }
  return sortedUnique(canonical);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
