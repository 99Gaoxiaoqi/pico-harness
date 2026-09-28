import type { TuiEntry } from "./tui-reporter.js";

const labels: Readonly<Record<string, string>> = {
  achieved: "已达成",
  impossible: "无法完成",
  stalled: "进展停滞",
  budget_limited: "已达 token 限额",
  max_iterations: "已达迭代上限",
  cleared: "已清除",
};

export function goalEntryText(entry: Extract<TuiEntry, { kind: "goal" }>): string {
  const data = entry.data;
  const usage =
    data && typeof data.iterations === "number"
      ? `迭代 ${data.iterations}/${data.maxIterations} · Goal token ${data.tokensUsed}${typeof data.tokenBudget === "number" ? `/${data.tokenBudget}` : ""}`
      : undefined;
  return [
    `Goal ${labels[entry.state ?? ""] ?? entry.state ?? ""} · ${entry.title}`,
    entry.detail,
    usage,
  ]
    .filter(Boolean)
    .join("\n");
}
