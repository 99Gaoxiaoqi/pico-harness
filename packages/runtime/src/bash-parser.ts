import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

export interface ShellWord {
  readonly value: string;
  readonly dynamic: boolean;
  readonly quotedOrEscaped: boolean;
  readonly unquotedExpansion: boolean;
  readonly outputRedirection: boolean;
  readonly cwd?: string;
  readonly findPathKnown?: boolean;
  readonly expansions?: readonly {
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly quoted: boolean;
  }[];
}

export type ShellFlowEvent =
  | {
      readonly kind:
        | "save"
        | "restore"
        | "join"
        | "isolate"
        | "end_isolate"
        | "forget"
        | "loop_end";
    }
  | {
      readonly kind: "loop";
      readonly variable?: string;
      readonly values: readonly ShellWord[];
      readonly form: "for" | "while";
    };

export interface ShellCommandContext {
  readonly subshellDepth: number;
  readonly subshellPath: readonly number[];
  readonly conditionallyExecuted: boolean;
  readonly isolatedCwd: boolean;
  readonly flow?: ShellFlowEvent;
  readonly stdinPayload?: string;
  readonly opaqueInput?: boolean;
}

export interface ParsedShell {
  readonly commands: readonly (readonly ShellWord[])[];
  readonly commandContexts: readonly ShellCommandContext[];
  readonly nestedCommands: readonly {
    readonly content: string;
    readonly commandIndex: number;
    readonly startIndex?: number;
    readonly endIndex?: number;
  }[];
  readonly ambiguous: boolean;
  readonly destructiveSystemSyntax: boolean;
}

export interface BashAnalysisBudget {
  readonly deadline: number;
  nodes: number;
  exceeded: boolean;
}

const GRAMMAR_SHA256 = "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_AST_NODES = 4096;
let language: Language | undefined;
let initialization: Promise<void> | undefined;

/** Failure of the trusted analyzer is an execution error, never semantic unknown. */
export class BashParserUnavailableError extends Error {
  override readonly name = "BashParserUnavailableError";
}

export function initializeBashParser(): Promise<void> {
  initialization ??= (async () => {
    try {
      const moduleDirectory = dirname(fileURLToPath(import.meta.url));
      const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      const candidates = [
        ...(resourcesPath ? [resolve(resourcesPath, "bash/tree-sitter-bash.wasm")] : []),
        resolve(moduleDirectory, "../../../bash/tree-sitter-bash.wasm"),
        resolve(moduleDirectory, "../assets/bash/tree-sitter-bash.wasm"),
      ];
      const path = candidates.find((candidate) => existsSync(candidate));
      if (!path) throw new Error("Bash grammar resource is missing");
      const grammar = readFileSync(path);
      if (createHash("sha256").update(grammar).digest("hex") !== GRAMMAR_SHA256) {
        throw new Error("Bash grammar resource failed integrity verification");
      }
      const require = createRequire(import.meta.url);
      const runtime = readFileSync(require.resolve("web-tree-sitter/web-tree-sitter.wasm"));
      await Parser.init({
        wasmBinary: runtime.buffer.slice(
          runtime.byteOffset,
          runtime.byteOffset + runtime.byteLength,
        ),
      });
      const loaded = await Language.load(grammar);
      if (loaded.abiVersion !== 15) throw new Error("Unsupported Bash grammar ABI");
      language = loaded;
    } catch (cause) {
      throw new BashParserUnavailableError(
        "[shell_analysis:unavailable] Bash 解析服务不可用，命令未执行。",
        { cause },
      );
    }
  })();
  return initialization;
}

export function createBashAnalysisBudget(): BashAnalysisBudget {
  return { deadline: performance.now() + 50, nodes: 0, exceeded: false };
}

export function parseBashScript(command: string, budget: BashAnalysisBudget): ParsedShell {
  if (!language)
    throw new BashParserUnavailableError(
      "[shell_analysis:unavailable] Bash 解析服务尚未初始化，命令未执行。",
    );
  const empty = (ambiguous: boolean): ParsedShell => ({
    commands: [],
    commandContexts: [],
    nestedCommands: [],
    ambiguous,
    destructiveSystemSyntax: false,
  });
  if (
    Buffer.byteLength(command, "utf8") > MAX_INPUT_BYTES ||
    budget.exceeded ||
    performance.now() > budget.deadline
  ) {
    budget.exceeded = true;
    return empty(true);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  let tree;
  try {
    let source = command;
    let recoveredHeredocs = new Map<string, readonly HeredocInput[]>();
    tree = parser.parse(source, null, {
      progressCallback: () => performance.now() > budget.deadline,
    });
    if (!tree) return empty(true);
    if (tree.rootNode.hasError) {
      const recovered = recoverMultipleHeredocs(source, tree.rootNode, budget);
      if (!recovered) return empty(true);
      tree.delete();
      tree = undefined;
      source = recovered.source;
      recoveredHeredocs = recovered.inputs;
      tree = parser.parse(source, null, {
        progressCallback: () => performance.now() > budget.deadline,
      });
      if (!tree || tree.rootNode.hasError) return empty(true);
    }
    const commands: ShellWord[][] = [];
    const commandContexts: ShellCommandContext[] = [];
    const nestedCommands: {
      content: string;
      commandIndex: number;
      startIndex?: number;
      endIndex?: number;
    }[] = [];
    let ambiguous = false;
    let invalidHeredoc = false;
    let destructiveSystemSyntax = false;
    const context: ShellCommandContext = {
      subshellDepth: 0,
      subshellPath: [],
      conditionallyExecuted: false,
      isolatedCwd: false,
    };
    const account = (node: Node): boolean => {
      budget.nodes++;
      if (budget.nodes > MAX_AST_NODES || performance.now() > budget.deadline) {
        budget.exceeded = true;
        ambiguous = true;
        return false;
      }
      if (node.isMissing || node.type === "ERROR") ambiguous = true;
      return true;
    };
    const emit = (words: ShellWord[], extra: Partial<ShellCommandContext> = {}): number => {
      const index = commands.length;
      commands.push(words);
      commandContexts.push({ ...context, ...extra });
      return index;
    };
    const event = (flow: ShellFlowEvent): void => {
      emit([], { flow });
    };
    const substitutions = (node: Node, index: number, quotedExpansion = false): void => {
      if (!account(node)) return;
      if (node.type === "command_substitution" || node.type === "process_substitution") {
        const raw = node.text;
        nestedCommands.push({
          content: substitutionContent(raw),
          commandIndex: index,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
        });
        return;
      }
      // The grammar leaves legacy backticks in parameter operands as plain words.
      // Reparse only those AST-bounded operands, never the surrounding data as code.
      const defaultOperand = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[+?=-]/u.test(node.text);
      for (const child of node.namedChildren) {
        if (
          node.type === "expansion" &&
          (child.type === "word" ||
            (child.type === "raw_string" && quotedExpansion && defaultOperand)) &&
          child.text.includes("`")
        ) {
          const view = heredocExpansionView(child.text);
          const parsed = parseBashScript(view.source, budget);
          ambiguous ||= parsed.ambiguous;
          for (const nested of parsed.nestedCommands) {
            const start =
              nested.startIndex === undefined ? undefined : view.positions[nested.startIndex];
            const end =
              nested.endIndex === undefined ? undefined : view.positions[nested.endIndex - 1];
            if (start === undefined || end === undefined) ambiguous = true;
            else
              nestedCommands.push({
                content: substitutionContent(child.text.slice(start, end + 1)),
                commandIndex: index,
                startIndex: child.startIndex + start,
                endIndex: child.startIndex + end + 1,
              });
          }
        } else substitutions(child, index, quotedExpansion || node.type === "string");
      }
    };
    const word = (node: Node, quoted = false): ShellWord => {
      account(node);
      const base = {
        dynamic: false,
        quotedOrEscaped: quoted,
        unquotedExpansion: false,
        outputRedirection: false,
      };
      if (node.type === "command_name") return word(node.namedChildren[0]!, quoted);
      if (node.type === "variable_assignment") {
        const valueNode = node.childForFieldName("value");
        const value = valueNode ? word(valueNode, true) : { ...base, value: "" };
        const prefix = `${node.childForFieldName("name")?.text ?? ""}=`;
        return {
          ...value,
          value: `${prefix}${value.value}`,
          ...(value.expansions
            ? {
                expansions: value.expansions.map((expansion) => ({
                  ...expansion,
                  start: expansion.start + prefix.length,
                  end: expansion.end + prefix.length,
                })),
              }
            : {}),
          dynamic: value.dynamic || node.children.some((child) => child.text === "+="),
        };
      }
      if (node.type === "raw_string")
        return { ...base, value: node.text.slice(1, -1), quotedOrEscaped: true };
      if (node.type === "ansi_c_string") {
        const value = decodeAnsiString(node.text.slice(2, -1));
        return {
          ...base,
          value: value ?? "__dynamic__",
          dynamic: value === undefined,
          quotedOrEscaped: true,
        };
      }
      if (node.type === "string" || node.type === "concatenation") {
        const parts = node.namedChildren.map((child) =>
          word(child, quoted || node.type === "string"),
        );
        let offset = 0;
        const expansions = parts.flatMap((part) => {
          const entries = (part.expansions ?? []).map((expansion) => ({
            ...expansion,
            start: expansion.start + offset,
            end: expansion.end + offset,
          }));
          offset += part.value.length;
          return entries;
        });
        return {
          ...base,
          value: parts.map((part) => part.value).join(""),
          dynamic: parts.some((part) => part.dynamic),
          quotedOrEscaped:
            quoted || node.type === "string" || parts.some((part) => part.quotedOrEscaped),
          unquotedExpansion: parts.some((part) => part.unquotedExpansion),
          expansions,
        };
      }
      if (node.type === "simple_expansion" || node.type === "expansion") {
        const name = node.namedChildren.find((child) => child.type === "variable_name")?.text;
        const simple = name && (node.text === `$${name}` || node.text === `\${${name}}`);
        return {
          ...base,
          value: simple ? `$${name}` : "__dynamic__",
          dynamic: true,
          unquotedExpansion: !quoted,
          ...(simple ? { expansions: [{ start: 0, end: name.length + 1, name, quoted }] } : {}),
        };
      }
      if (
        node.type === "command_substitution" ||
        node.type === "process_substitution" ||
        node.type === "arithmetic_expansion"
      ) {
        return { ...base, value: "__dynamic__", dynamic: true, unquotedExpansion: !quoted };
      }
      const raw = node.text;
      return {
        ...base,
        value: raw.replace(/\\\n/gu, "").replace(quoted ? /\\([\\$`"])/gu : /\\(.)/gsu, "$1"),
        quotedOrEscaped: quoted || raw.includes("\\"),
        unquotedExpansion: !quoted && /(^|[^\\])[*?[~{]/u.test(raw),
      };
    };
    const wordsForNodes = (nodes: readonly Node[]): ShellWord[] => {
      const tokens: ShellWord[] = [];
      for (const [position, part] of nodes.entries()) {
        const next = word(part);
        const previous = tokens.at(-1);
        const gap =
          position > 0 ? source.slice(nodes[position - 1]!.endIndex, part.startIndex) : "";
        // The grammar splits argv at escaped newlines; Bash removes that
        // continuation before forming the word.
        if (previous && /^(?:\\\n)+$/u.test(gap)) {
          tokens[tokens.length - 1] = {
            ...previous,
            value: previous.value + next.value,
            dynamic: previous.dynamic || next.dynamic,
            unquotedExpansion: previous.unquotedExpansion || next.unquotedExpansion,
            quotedOrEscaped: previous.quotedOrEscaped || next.quotedOrEscaped,
            expansions: [
              ...(previous.expansions ?? []),
              ...(next.expansions ?? []).map((expansion) => ({
                ...expansion,
                start: expansion.start + previous.value.length,
                end: expansion.end + previous.value.length,
              })),
            ],
          };
        } else tokens.push(next);
      }
      return tokens;
    };
    const redirects = (nodes: readonly Node[], index: number): void => {
      for (const redirect of nodes) {
        account(redirect);
        if (redirect.type === "file_redirect") {
          const destinations = redirect.childrenForFieldName("destination");
          const destination = wordsForNodes(destinations)[0];
          const operator = redirect.children
            .filter((child) => !child.isNamed)
            .map((child) => child.text)
            .join("");
          if (destination) {
            for (const part of destinations) substitutions(part, index);
            commands[index]!.push(...wordsForNodes(destinations).slice(1));
            if (operator.includes("<"))
              commandContexts[index] = { ...commandContexts[index]!, opaqueInput: true };
            if (operator.includes(">")) {
              commands[index]!.push(
                {
                  value: operator,
                  dynamic: false,
                  quotedOrEscaped: false,
                  unquotedExpansion: false,
                  outputRedirection: true,
                },
                destination,
              );
            }
          }
        } else if (
          redirect.type === "heredoc_redirect" ||
          redirect.type === "herestring_redirect"
        ) {
          const delimiter = redirect.namedChildren.find((child) => child.type === "heredoc_start");
          const body = redirect.namedChildren.find((child) => child.type === "heredoc_body");
          const recovered = delimiter && recoveredHeredocs.get(delimiter.text.slice(1, -1));
          if (recovered) {
            // The official grammar cannot queue multiple heredocs on one header.
            // Parse each AST-identified input separately, preserving all expansion
            // checks and using the last input as the executable's stdin.
            for (const input of recovered) {
              const parsed = parseBashScript(
                `cat ${input.operator}${input.rawDelimiter}\n${input.body}${input.delimiter}\n`,
                budget,
              );
              ambiguous ||= parsed.ambiguous;
              nestedCommands.push(
                ...parsed.nestedCommands.map((nested) => ({ ...nested, commandIndex: index })),
              );
              const stdin = parsed.commandContexts.find(
                (entry) => entry.stdinPayload !== undefined || entry.opaqueInput,
              );
              if (stdin)
                commandContexts[index] = {
                  ...commandContexts[index]!,
                  ...(stdin.stdinPayload !== undefined ? { stdinPayload: stdin.stdinPayload } : {}),
                  ...(stdin.opaqueInput !== undefined ? { opaqueInput: stdin.opaqueInput } : {}),
                };
            }
            redirects(
              redirect.namedChildren.filter((child) => child.type === "file_redirect"),
              index,
            );
            continue;
          }
          if (body) {
            const end = redirect.namedChildren.find((child) => child.type === "heredoc_end");
            const stripTabs = source
              .slice(redirect.startIndex, delimiter?.startIndex)
              .includes("<<-");
            const expected = delimiter && removeDelimiterQuotes(delimiter.text);
            const endLineStart = end ? source.lastIndexOf("\n", end.startIndex - 1) + 1 : 0;
            const endLineEnd = end ? source.indexOf("\n", end.startIndex) : -1;
            const endLine = end
              ? source.slice(endLineStart, endLineEnd < 0 ? source.length : endLineEnd)
              : undefined;
            if (
              expected === undefined ||
              endLine === undefined ||
              (stripTabs ? endLine.replace(/^\t+/u, "") : endLine) !== expected
            ) {
              invalidHeredoc = true;
              continue;
            }
            const arguments_ = redirect.childrenForFieldName("argument");
            const headerEnd = heredocHeaderEnd(source, delimiter!.endIndex, [
              ...arguments_,
              ...redirect.namedChildren.filter((child) => child.type === "file_redirect"),
            ]);
            if (headerEnd === undefined || headerEnd >= endLineStart) {
              invalidHeredoc = true;
              continue;
            }
            for (const argument of arguments_) {
              if (argument.endIndex <= headerEnd) {
                commands[index]!.push(word(argument));
                substitutions(argument, index);
              }
            }
            const quoted = delimiter ? /['"\\]/u.test(delimiter.text) : false;
            const rawPayload = source.slice(headerEnd + 1, endLineStart);
            const payload = stripTabs ? rawPayload.replace(/^\t+/gmu, "") : rawPayload;
            let opaqueInput = false;
            if (!quoted && /\\\n/u.test(payload)) {
              invalidHeredoc = true;
              continue;
            }
            if (!quoted) {
              for (const child of redirect.namedChildren) {
                if (
                  child.endIndex > headerEnd &&
                  child.type !== "heredoc_end" &&
                  child.type !== "file_redirect"
                )
                  substitutions(child, index, true);
              }
              // A quoted-word AST view exposes legacy backticks omitted by the
              // heredoc scanner. Map expansions back to their original source.
              const view = heredocExpansionView(payload);
              const expanded = parseBashScript(view.source, budget);
              ambiguous ||= expanded.ambiguous;
              opaqueInput = expanded.commands.some((words) => words.some((entry) => entry.dynamic));
              for (const nested of expanded.nestedCommands) {
                if (nested.startIndex === undefined || nested.endIndex === undefined) {
                  ambiguous = true;
                  continue;
                }
                const start = view.positions[nested.startIndex];
                const end = view.positions[nested.endIndex - 1];
                if (start === undefined || end === undefined) {
                  ambiguous = true;
                  continue;
                }
                const raw = payload.slice(start, end + 1);
                if (!raw.startsWith("`")) continue;
                nestedCommands.push({
                  content: substitutionContent(raw),
                  commandIndex: index,
                });
              }
            }
            commandContexts[index] = {
              ...commandContexts[index]!,
              stdinPayload: payload,
              opaqueInput,
            };
            redirects(
              redirect.namedChildren.filter((child) => child.type === "file_redirect"),
              index,
            );
          } else {
            commandContexts[index] = { ...commandContexts[index]!, opaqueInput: true };
            substitutions(redirect, index);
          }
        } else ambiguous = true;
      }
    };
    const visit = (node: Node, trailingRedirects: readonly Node[] = []): void => {
      if (!account(node)) return;
      if (trailingRedirects.length && !["command", "list", "pipeline"].includes(node.type))
        redirects(trailingRedirects, emit([]));
      switch (node.type) {
        case "program":
        case "compound_statement":
        case "do_group":
          for (const child of node.namedChildren) visit(child);
          return;
        case "comment":
          return;
        case "command":
        case "variable_assignment":
        case "declaration_command":
        case "unset_command": {
          const nodes =
            node.type === "variable_assignment"
              ? [node]
              : node.namedChildren.filter((child) => !child.type.endsWith("_redirect"));
          const tokens = wordsForNodes(nodes);
          if (node.type === "declaration_command" || node.type === "unset_command") {
            tokens.unshift({
              value: node.children[0]!.text,
              dynamic: false,
              quotedOrEscaped: false,
              unquotedExpansion: false,
              outputRedirection: false,
            });
          }
          const index = emit(tokens);
          substitutions(node, index);
          redirects(
            [
              ...node.namedChildren.filter((child) => child.type.endsWith("_redirect")),
              ...trailingRedirects,
            ],
            index,
          );
          return;
        }
        case "test_command": {
          const index = emit([
            {
              value: "test",
              dynamic: false,
              quotedOrEscaped: false,
              unquotedExpansion: false,
              outputRedirection: false,
            },
          ]);
          substitutions(node, index);
          return;
        }
        case "redirected_statement": {
          const body = node.childForFieldName("body");
          const redirectNodes = node.namedChildren.filter(
            (child) => child !== body && child.type.endsWith("_redirect"),
          );
          const start = commands.length;
          if (body && (body.type === "list" || body.type === "pipeline")) {
            visit(body, redirectNodes);
            return;
          }
          if (body && body.type !== "command") redirects(redirectNodes, emit([]));
          if (body) {
            // The grammar can omit a trailing '-' before a redirect; reparse that
            // AST-bounded command prefix instead of silently dropping argv.
            const first = redirectNodes[0];
            const prefix =
              first && body.type === "command"
                ? source.slice(body.startIndex, first.startIndex).trimEnd()
                : undefined;
            if (prefix !== undefined && prefix !== body.text && !prefix.includes("\n")) {
              const parsed = parseBashScript(prefix, budget);
              for (let i = 0; i < parsed.commands.length; i++)
                emit([...parsed.commands[i]!], parsed.commandContexts[i]);
              nestedCommands.push(
                ...parsed.nestedCommands.map((nested) => ({
                  ...nested,
                  commandIndex: nested.commandIndex + start,
                })),
              );
              ambiguous ||= parsed.ambiguous;
            } else visit(body);
          }
          if (commands.length === start) emit([]);
          // A group's final entry may be a scope event; use a separate command
          // so its redirections are checked in the surrounding shell.
          const redirectIndex =
            commands.length === start + 1 && !commandContexts[start]?.flow ? start : emit([]);
          if (!body || body.type === "command") redirects(redirectNodes, redirectIndex);
          return;
        }
        case "subshell":
          event({ kind: "isolate" });
          for (const child of node.namedChildren) visit(child);
          event({ kind: "end_isolate" });
          return;
        case "pipeline":
          for (const [index, child] of node.namedChildren.entries()) {
            event({ kind: "isolate" });
            visit(child, index === node.namedChildCount - 1 ? trailingRedirects : []);
            event({ kind: "end_isolate" });
          }
          return;
        case "list": {
          const children = node.namedChildren;
          if (children[0]) visit(children[0], children.length === 1 ? trailingRedirects : []);
          if (children.length > 1) {
            event({ kind: "save" });
            for (const [index, child] of children.entries())
              if (index > 0) visit(child, index === children.length - 1 ? trailingRedirects : []);
            event({ kind: "join" });
          }
          return;
        }
        case "if_statement": {
          const conditions = node.childrenForFieldName("condition");
          for (const condition of conditions) visit(condition);
          event({ kind: "save" });
          for (const child of node.namedChildren) {
            if (conditions.some((condition) => condition.id === child.id)) continue;
            if (child.type === "else_clause" || child.type === "elif_clause") {
              event({ kind: "restore" });
              for (const branch of child.namedChildren) visit(branch);
            } else visit(child);
          }
          event({ kind: "join" });
          return;
        }
        case "for_statement":
        case "while_statement":
        case "c_style_for_statement": {
          const body = node.childForFieldName("body");
          event({ kind: "save" });
          const variable = node.childForFieldName("variable")?.text;
          const valueNodes = node.childrenForFieldName("value");
          const valueIndex = emit([]);
          for (const value of valueNodes) substitutions(value, valueIndex);
          if (node.type === "c_style_for_statement") {
            ambiguous = true;
            substitutions(node.childForFieldName("initializer") ?? node, valueIndex);
            event({ kind: "forget" });
          }
          event({
            kind: "loop",
            ...(variable ? { variable } : {}),
            values: valueNodes.map((value) => word(value)),
            form: node.type === "for_statement" ? "for" : "while",
          });
          for (const condition of node.childrenForFieldName("condition"))
            if (condition.isNamed) visit(condition);
          if (body) visit(body);
          else ambiguous = true;
          const update = node.childForFieldName("update");
          if (update) substitutions(update, emit([]));
          event({ kind: "loop_end" });
          return;
        }
        case "function_definition":
          // Definitions are not executed now. Existing explicit fork-bomb syntax
          // remains a deny signal, never searched in strings/heredoc data.
          destructiveSystemSyntax ||= isForkBombDefinition(node);
          ambiguous = true;
          return;
        default:
          ambiguous = true;
          event({ kind: "forget" });
          substitutions(node, emit([]));
          // Traverse executable structures in unsupported control flow while
          // excluding words and opaque data from statement classification.
          for (const child of node.namedChildren) {
            if (
              [
                "command",
                "redirected_statement",
                "compound_statement",
                "do_group",
                "list",
                "pipeline",
                "subshell",
                "case_item",
                "case_statement",
              ].includes(child.type)
            )
              visit(child);
          }
      }
    };
    visit(tree.rootNode);
    if (invalidHeredoc) return empty(true);
    return {
      commands,
      commandContexts,
      nestedCommands,
      ambiguous: ambiguous || budget.exceeded,
      destructiveSystemSyntax,
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function heredocHeaderEnd(
  source: string,
  delimiterEnd: number,
  nodes: readonly Node[],
): number | undefined {
  let cursor = delimiterEnd;
  const newlineInGap = (end: number): number | undefined => {
    for (let index = cursor; index <= end; index++) {
      if (source[index] === "\\" && source[index + 1] === "\n") index++;
      else if (source[index] === "\n") return index;
    }
    return undefined;
  };
  for (const node of [...nodes].sort((left, right) => left.startIndex - right.startIndex)) {
    const newline = newlineInGap(node.startIndex);
    if (newline !== undefined) return newline;
    cursor = node.endIndex;
  }
  return newlineInGap(source.length);
}

function isForkBombDefinition(node: Node): boolean {
  if (node.childForFieldName("name")?.text !== ":") return false;
  const body = node.childForFieldName("body");
  if (body?.type !== "compound_statement") return false;
  return body.children.some((child, index, children) => {
    if (child.type !== "pipeline" || children[index + 1]?.text !== "&") return false;
    return (
      child.namedChildCount === 2 &&
      child.namedChildren.every(
        (command) =>
          command.type === "command" &&
          command.childForFieldName("name")?.namedChildren[0]?.type === "word" &&
          command.childForFieldName("name")?.text === ":" &&
          command.namedChildCount === 1,
      )
    );
  });
}

function substitutionContent(raw: string): string {
  return raw.startsWith("`") ? raw.slice(1, -1).replace(/\\([\\$`])/gu, "$1") : raw.slice(2, -1);
}

interface HeredocInput {
  readonly operator: "<<" | "<<-";
  readonly rawDelimiter: string;
  readonly delimiter: string;
  readonly body: string;
}

function heredocExpansionView(body: string): { source: string; positions: (number | undefined)[] } {
  let source = 'printf "%s" "';
  const positions: (number | undefined)[] = Array.from({ length: source.length });
  const append = (text: string, index: number): void => {
    source += text;
    for (let offset = 0; offset < text.length; offset++) positions.push(index);
  };
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character === "\\") {
      const next = body[index + 1];
      if (next !== undefined && "\\$`\n".includes(next)) {
        append(character, index);
        append(next, ++index);
      } else append("\\\\", index);
    } else append(character === '"' ? '\\"' : character, index);
  }
  source += '"';
  return { source, positions };
}

/** Narrow adapter for the grammar's missing FIFO heredoc support, not a Shell scanner. */
function recoverMultipleHeredocs(
  source: string,
  root: Node,
  budget: BashAnalysisBudget,
): { source: string; inputs: Map<string, readonly HeredocInput[]> } | undefined {
  const candidates: Node[] = [];
  const collect = (node: Node): void => {
    if (++budget.nodes > MAX_AST_NODES || performance.now() > budget.deadline) {
      budget.exceeded = true;
      return;
    }
    if (node.type === "heredoc_redirect" && node.hasError) {
      candidates.push(node);
      return;
    }
    for (const child of node.namedChildren) collect(child);
  };
  collect(root);
  if (!candidates.length || budget.exceeded) return undefined;
  const replacements: { start: number; end: number; text: string }[] = [];
  const inputs = new Map<string, readonly HeredocInput[]>();
  for (const candidate of candidates) {
    const first = candidate.namedChildren.find((child) => child.type === "heredoc_start");
    const firstBody = candidate.namedChildren.find((child) => child.type === "heredoc_body");
    if (
      !first ||
      !firstBody ||
      candidate.namedChildren.some((child) => child.type === "file_descriptor")
    )
      return undefined;
    const headers = [
      {
        start: candidate.startIndex,
        end: first.endIndex,
        raw: first.text,
        operator: source.slice(candidate.startIndex, first.startIndex).trim(),
      },
    ];
    const collectHeaders = (node: Node): void => {
      if (++budget.nodes > MAX_AST_NODES || performance.now() > budget.deadline) {
        budget.exceeded = true;
        return;
      }
      if (
        node.type === "file_redirect" &&
        node.startIndex < firstBody.startIndex &&
        source.slice(node.startIndex - 1, node.startIndex + 1) === "<<"
      ) {
        const destination = node.childForFieldName("destination");
        if (destination) {
          const stripTabs = source[node.startIndex + 1] === "-";
          headers.push({
            start: node.startIndex - 1,
            end: destination.endIndex,
            raw: destination.text.slice(stripTabs ? 1 : 0),
            operator: stripTabs ? "<<-" : "<<",
          });
        }
        return;
      }
      for (const child of node.namedChildren)
        if (child.startIndex < firstBody.startIndex) collectHeaders(child);
    };
    collectHeaders(candidate);
    if (headers.length < 2 || budget.exceeded) return undefined;
    headers.sort((left, right) => left.start - right.start);
    let cursor = firstBody.startIndex;
    const bodies: HeredocInput[] = [];
    for (const header of headers) {
      if (header.operator !== "<<" && header.operator !== "<<-") return undefined;
      const delimiter = removeDelimiterQuotes(header.raw);
      if (delimiter === undefined || delimiter.includes("\n")) return undefined;
      const bodyStart = cursor;
      let found = false;
      while (cursor <= source.length && performance.now() <= budget.deadline) {
        const newline = source.indexOf("\n", cursor);
        const end = newline < 0 ? source.length : newline;
        const line = source.slice(cursor, end);
        if ((header.operator === "<<-" ? line.replace(/^\t+/u, "") : line) === delimiter) {
          if (!/['"\\]/u.test(header.raw) && /\\\n/u.test(source.slice(bodyStart, cursor)))
            return undefined;
          bodies.push({
            operator: header.operator,
            rawDelimiter: header.raw,
            delimiter,
            body: source.slice(bodyStart, cursor),
          });
          cursor = newline < 0 ? end : end + 1;
          found = true;
          break;
        }
        if (newline < 0) break;
        cursor = end + 1;
      }
      if (!found) return undefined;
    }
    if (bodies.some((input) => !/['"\\]/u.test(input.rawDelimiter) && /\\\n/u.test(input.body)))
      return undefined;
    const marker = `__PICO_HEREDOC_ANALYSIS_${inputs.size}__`;
    if (source.includes(marker)) return undefined;
    inputs.set(marker, bodies);
    replacements.push({ start: headers[0]!.start, end: headers[0]!.end, text: `<<'${marker}'` });
    for (const header of headers.slice(1))
      replacements.push({ start: header.start, end: header.end, text: "" });
    replacements.push({ start: firstBody.startIndex, end: cursor, text: `${marker}\n` });
  }
  replacements.sort((left, right) => right.start - left.start);
  let nextBoundary = source.length;
  for (const replacement of replacements) {
    if (replacement.end > nextBoundary) return undefined;
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
    nextBoundary = replacement.start;
  }
  return { source, inputs };
}

function removeDelimiterQuotes(raw: string): string | undefined {
  const parts = raw.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|([^'"\\\s]+)/gsu);
  let value = "";
  let cursor = 0;
  for (const part of parts) {
    if (part.index !== cursor) return undefined;
    value += part[1] ?? part[2]?.replace(/\\([\\$`"])/gu, "$1") ?? part[3] ?? part[4];
    cursor += part[0].length;
  }
  return cursor === raw.length ? value : undefined;
}

function decodeAnsiString(text: string): string | undefined {
  let value = "";
  const escapes: Readonly<Record<string, string>> = {
    a: "\x07",
    b: "\b",
    e: "\x1b",
    E: "\x1b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\\") {
      value += text[index];
      continue;
    }
    const escaped = text[++index];
    if (escaped === undefined) return undefined;
    let byte: number | undefined;
    const octal = text.slice(index).match(/^[0-7]{1,3}/u)?.[0];
    if (octal) {
      byte = Number.parseInt(octal, 8) & 0xff;
      index += octal.length - 1;
    } else if (escaped === "x") {
      const hex = text.slice(index + 1).match(/^[0-9a-fA-F]{1,2}/u)?.[0];
      if (!hex) return undefined;
      byte = Number.parseInt(hex, 16);
      index += hex.length;
    } else if (escaped in escapes) value += escapes[escaped];
    else return undefined; // Unicode/control escapes depend on Bash version and locale.
    if (byte === 0) return value; // Bash strings terminate at the first encoded NUL.
    if (byte !== undefined) {
      if (byte >= 0x80) return undefined; // Do not mistake arbitrary bytes for UTF-8 characters.
      value += String.fromCharCode(byte);
    }
  }
  return value;
}
