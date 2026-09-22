import type { RuntimeLatestContextRequest } from "@pico/protocol";

const names = {
  system: "系统指令",
  tools: "工具定义",
  messages: "会话消息（含附件）",
  other: "其他请求选项",
};
const colors = { system: "#8b7bc8", tools: "#5e9eae", messages: "#be9966", other: "#92969e" };
const tokens = (value: number | undefined) => value?.toLocaleString("zh-CN") ?? "未知";
const estimate = (bytes: number) => `≈${tokens(Math.ceil(bytes / 4))} Token`;

export function ContextComposition({ request }: { request?: RuntimeLatestContextRequest }) {
  const composition = request?.compositionStatus === "available" ? request.composition : undefined;
  const input = request?.usageStatus !== "missing" ? request?.inputTokens : undefined;
  const window = request?.contextWindow;
  const percent = input !== undefined && window ? (input / window) * 100 : undefined;
  const cache = request?.cachedInputTokens;
  const cachePercent =
    input !== undefined && window && cache !== undefined
      ? (Math.min(input, cache) / window) * 100
      : undefined;
  const tools = [...(composition?.tools ?? [])].sort((left, right) => right.bytes - left.bytes);
  const remainingCount = Math.max(0, tools.length - 5) + (composition?.remainingTools.count ?? 0);
  const remainingBytes = tools
    .slice(5)
    .reduce((total, tool) => total + tool.bytes, composition?.remainingTools.bytes ?? 0);
  return (
    <section className="tool-panel__section" aria-label="最近成功主请求组成">
      <div className="tool-panel__section-heading">
        <h3>最近成功主请求</h3>
      </div>
      <p className="tool-panel__muted">历史请求快照；当前模型、工具或压缩状态变化后不会改写它。</p>
      {request?.status === "available" ? (
        <>
          <p className="tool-panel__muted">
            <code>
              {request.providerId} / {request.modelId}
            </code>
            {request.completedAt !== undefined && (
              <> · {new Date(request.completedAt).toLocaleString("zh-CN")}</>
            )}
          </p>
          <dl className="tool-panel__metrics">
            <div>
              <dt>实际输入 Token</dt>
              <dd>{tokens(input)}</dd>
            </div>
            <div>
              <dt>当时模型窗口</dt>
              <dd>{tokens(window)}</dd>
            </div>
            <div>
              <dt>其中缓存 Token</dt>
              <dd>{tokens(cache)}</dd>
            </div>
            <div>
              <dt>窗口空余</dt>
              <dd>
                {input !== undefined && window ? tokens(Math.max(0, window - input)) : "未知"}
              </dd>
            </div>
          </dl>
          {percent !== undefined && (
            <>
              <div
                className="tool-panel__progress"
                role="progressbar"
                aria-label="上下文使用率"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(Math.min(100, percent))}
                aria-valuetext={`${percent.toFixed(1)}%，其中缓存 ${tokens(cache)} Token`}
                style={{ display: "flex" }}
              >
                {cachePercent !== undefined && (
                  <span
                    title="缓存输入（已包含在实际输入中）"
                    style={{ width: `${Math.min(100, cachePercent)}%`, backgroundColor: "#5e9eae" }}
                  />
                )}
                <span
                  title={cachePercent === undefined ? "实际输入（缓存未上报）" : "非缓存输入"}
                  style={{ width: `${Math.min(100, percent) - Math.min(100, cachePercent ?? 0)}%` }}
                />
              </div>
              <p className="tool-panel__muted">
                占用 {percent.toFixed(1)}%；窗口空余对应这次请求，不是下次可追加内容的保证。
              </p>
            </>
          )}
          {input === undefined && <p className="tool-panel__muted">本次请求没有上报输入用量。</p>}
          <details>
            <summary>请求身份与压缩边界</summary>
            <p className="tool-panel__muted">
              调用 <code>{request.providerCallId}</code> · 底层请求{" "}
              <code>{request.physicalAttemptId}</code>
            </p>
            <p className="tool-panel__muted">
              路由 <code>{request.routeId}</code> · 连接{" "}
              <code>{request.connectionId ?? "未知"}</code>
            </p>
            <p className="tool-panel__muted">窗口来源 {request.contextWindowSource ?? "未知"}</p>
            {request.compaction ? (
              <p className="tool-panel__muted">
                本次使用压缩 <code>{request.compaction.checkpointId}</code> · 覆盖{" "}
                {request.compaction.coveredEventCount} 条 ·{" "}
                <code>{request.compaction.throughEventId}</code>
              </p>
            ) : (
              <p className="tool-panel__muted">本次没有使用压缩 checkpoint。</p>
            )}
          </details>
        </>
      ) : (
        <p className="tool-panel__muted">{request?.reason ?? "尚无成功的主请求。"}</p>
      )}
      {!composition ? (
        <p className="tool-panel__muted">请求组成未知（未记录）。</p>
      ) : (
        <>
          <p className="tool-panel__muted">
            组成按 UTF-8 字节比例展示，Token 以字节数 ÷ 4
            向上取整估算；不等于实际输入用量，也不包含完整 HTTP 传输开销。合计{" "}
            {estimate(composition.totalBytes)}。
          </p>
          {composition.totalBytes > 0 && (
            <div
              style={{
                display: "flex",
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                margin: "10px 0",
              }}
              aria-hidden="true"
            >
              {composition.segments.map((segment) => (
                <span
                  key={segment.kind}
                  style={{
                    width: `${(segment.bytes / composition.totalBytes) * 100}%`,
                    backgroundColor: colors[segment.kind],
                  }}
                />
              ))}
            </div>
          )}
          <ul className="tool-panel__compact-list" aria-label="请求组成估算">
            {composition.segments.map((segment) => (
              <li key={segment.kind}>
                <span>{names[segment.kind]}</span>
                <small title={`${tokens(segment.bytes)} B`}>
                  {estimate(segment.bytes)} ·{" "}
                  {composition.totalBytes === 0
                    ? "0.0"
                    : ((segment.bytes / composition.totalBytes) * 100).toFixed(1)}
                  %
                </small>
              </li>
            ))}
          </ul>
          {(tools.length > 0 || composition.unlabelledToolBytes > 0 || remainingCount > 0) && (
            <details>
              <summary>工具定义明细 · 按大小排序</summary>
              <ul className="tool-panel__compact-list" aria-label="工具定义估算明细">
                {tools.slice(0, 5).map((tool) => (
                  <li key={tool.label}>
                    <code>{tool.label}</code>
                    <small title={`${tokens(tool.bytes)} B`}>{estimate(tool.bytes)}</small>
                  </li>
                ))}
                {remainingCount > 0 && (
                  <li>
                    <span>其余 {remainingCount} 项工具定义</span>
                    <small title={`${tokens(remainingBytes)} B`}>{estimate(remainingBytes)}</small>
                  </li>
                )}
                {composition.unlabelledToolBytes > 0 && (
                  <li>
                    <span>未命名工具</span>
                    <small title={`${tokens(composition.unlabelledToolBytes)} B`}>
                      {estimate(composition.unlabelledToolBytes)}
                    </small>
                  </li>
                )}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
