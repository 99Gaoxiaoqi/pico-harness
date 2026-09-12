import { isRecord, recordArray, stringValue } from "../runtime-projections/values.js";
import type { WebSearchRecordView } from "./types.js";

export function parseWebSearchRecord(value: unknown): WebSearchRecordView | undefined {
  if (!isRecord(value)) return undefined;
  const calls = recordArray(value.calls).flatMap<WebSearchRecordView["calls"][number]>((call) => {
    if (
      !stringValue(call.toolCallId) ||
      !stringValue(call.toolName) ||
      (call.status !== "completed" && call.status !== "error" && call.status !== "pending")
    )
      return [];
    return [
      {
        toolCallId: stringValue(call.toolCallId),
        toolName: stringValue(call.toolName),
        status: call.status,
        input: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
        ...(call.error ? { error: stringValue(call.error) } : {}),
      },
    ];
  });
  const sources = recordArray(value.sources).flatMap((source) => {
    const url = stringValue(source.url);
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return [];
    } catch {
      return [];
    }
    return [{ url, title: stringValue(source.title, url) }];
  });
  return calls.length || sources.length ? { calls, sources } : undefined;
}

export function WebSearchRecord({ record }: { readonly record: WebSearchRecordView }) {
  return (
    <details className="conversation-web-search">
      <summary>
        {record.calls.length ? `联网搜索记录 · ${record.calls.length} 次调用` : "模型提供的来源"}
        {record.sources.length > 0 && ` · ${record.sources.length} 个来源`}
      </summary>
      {record.calls.length > 0 && (
        <ul>
          {record.calls.map((call) => (
            <li key={call.toolCallId}>
              <strong>
                {call.status === "completed"
                  ? "搜索已完成"
                  : call.status === "error"
                    ? "搜索失败"
                    : "搜索结果待确认"}
              </strong>
              <span> · {call.toolName}</span>
              <pre>{call.input}</pre>
              {call.error && <p>{call.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {record.sources.length > 0 && (
        <ul aria-label="搜索来源">
          {record.sources.map((source, index) => (
            <li key={`${source.url}:${index}`}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
