import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transformSync } from "esbuild";

type Node = { type: unknown; props: Record<string, unknown> };
type Cell = {
  value?: unknown;
  current?: unknown;
  deps?: unknown[];
  cleanup?: (() => void) | undefined;
};
/** Exercises actual mobile screen callbacks without loading native modules in Node. */
export function mobileComponent(source: URL, modules: Record<string, unknown>) {
  let cells: Cell[] = [],
    cursor = 0,
    dirty = false;
  let effects: Array<() => void> = [];
  const same = (a: unknown[] | undefined, b: unknown[]) =>
    a?.length === b?.length && a.every((x, i) => Object.is(x, b[i]));
  const effect = (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = cursor++;
    if (!cells[i] || !same(cells[i]!.deps, deps))
      effects.push(() => {
        cells[i]?.cleanup?.();
        cells[i] = { deps, cleanup: fn() };
      });
  };
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = cursor++;
    if (!cells[i] || !same(cells[i]!.deps, deps)) cells[i] = { deps, value: fn() };
    return cells[i]!.value;
  };
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    }),
    useState(initial: unknown) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === "function" ? initial() : initial };
      return [
        cells[i]!.value,
        (value: unknown) => {
          cells[i]!.value = typeof value === "function" ? value(cells[i]!.value) : value;
          dirty = true;
        },
      ];
    },
    useRef(value: unknown) {
      return (cells[cursor++] ??= { current: value });
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
  };
  const compiled = transformSync(readFileSync(source, "utf8"), {
    loader: "tsx",
    format: "cjs",
    jsx: "transform",
    sourcefile: fileURLToPath(source),
  }).code;
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (name === "react") return react;
      if (!(name in modules)) throw new Error(`Unstubbed screen dependency: ${name}`);
      return modules[name];
    },
  });
  let tree: unknown;
  return {
    render<T = Node>(name = "default", props: unknown = {}, ...args: unknown[]): T {
      for (let count = 0; count < 20; count++) {
        dirty = false;
        cursor = 0;
        effects = [];
        tree = module.exports[name]!(props, ...args);
        effects.forEach((effect) => effect());
        if (!dirty) return tree as T;
      }
      throw new Error("Screen failed to settle");
    },
    nodes(type: unknown) {
      function visit(node: unknown): Node[] {
        if (!node || typeof node !== "object") return [];
        const candidate = node as Partial<Node>;
        const children = candidate.props?.children;
        return [
          ...(candidate.type === type ? [candidate as Node] : []),
          ...(Array.isArray(children) ? children.flat(Infinity) : []).flatMap(visit),
        ];
      }
      return visit(tree);
    },
    dispose() {
      for (const cell of cells) cell?.cleanup?.();
      cells = [];
    },
  };
}
export const mobileTags = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, name]));
export const settleScreen = () => new Promise<void>((resolve) => setImmediate(resolve));
