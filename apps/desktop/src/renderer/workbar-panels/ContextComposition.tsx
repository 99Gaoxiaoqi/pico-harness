import type { RuntimeLatestContextRequest } from "@pico/protocol";

const names = {
  system: "系统指令",
  tools: "工具定义",
  messages: "会话消息（含附件）",
  other: "其他请求选项",
};
const colors = {
  system: "var(--inspector-purple)",
  tools: "var(--inspector-blue)",
  messages: "var(--inspector-teal)",
  other: "var(--inspector-orange)",
};
const valid = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;
const tokens = (value: number | undefined) =>
  valid(value) ? value.toLocaleString("zh-CN") : "未知";
const estimate = (bytes: number) => `≈${tokens(Math.ceil(bytes / 4))} Token`;

export function ContextComposition({ request }: { request?: RuntimeLatestContextRequest }) {
  const composition = request?.compositionStatus === "available" ? request.composition : undefined;
  const input =
    request?.usageStatus !== "missing" && valid(request?.inputTokens)
      ? request.inputTokens
      : undefined;
  const window = valid(request?.contextWindow) ? request.contextWindow : undefined;
  const percent = input !== undefined && window ? (input / window) * 100 : undefined;
  const cache = valid(request?.cachedInputTokens) ? request.cachedInputTokens : undefined;
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
    <section className="inspector-composition" aria-label="最近成功主请求组成">
      <h3>最近成功主请求</h3>
      {request?.status === "available" ? (
        <>
          <p className="inspector-overview__note">
            <code>
              {request.providerId} / {request.modelId}
            </code>
            {request.completedAt !== undefined && (
              <> · {new Date(request.completedAt).toLocaleString("zh-CN")}</>
            )}
          </p>
          <div
            className="inspector-composition__usage"
            aria-label={`实际输入 ${tokens(input)} / 当时模型窗口 ${tokens(window)} Token`}
          >
            <div>
              <strong>{tokens(input)}</strong>
              <span> / {tokens(window)}</span>
              <small>Token</small>
            </div>
            <strong>{percent === undefined ? "未知" : `${percent.toFixed(1)}%`}</strong>
          </div>
          {percent !== undefined && (
            <>
              <div
                className="inspector-composition__bar"
                role="progressbar"
                aria-label="上下文使用率"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(Math.min(100, percent))}
                aria-valuetext={`${percent.toFixed(1)}%，其中缓存 ${tokens(cache)} Token`}
              >
                {cachePercent !== undefined && (
                  <span
                    title="缓存输入（已包含在实际输入中）"
                    style={{
                      width: `${Math.min(100, cachePercent)}%`,
                      backgroundColor: "var(--inspector-teal)",
                    }}
                  />
                )}
                <span
                  title={cachePercent === undefined ? "实际输入（缓存未上报）" : "非缓存输入"}
                  style={{
                    width: `${Math.min(100, percent) - Math.min(100, cachePercent ?? 0)}%`,
                    backgroundColor: "var(--inspector-blue)",
                  }}
                />
              </div>
            </>
          )}
          <dl className="inspector-overview__facts">
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
          <p className="inspector-overview__note">实际输入 · 请求时窗口；缓存已包含在输入中。</p>
          {input === undefined && (
            <p className="inspector-overview__note">本次请求没有上报输入用量。</p>
          )}
          <details>
            <summary>请求身份与压缩边界</summary>
            <dl className="inspector-overview__facts">
              <div>
                <dt>实际输入 Token</dt>
                <dd>{tokens(input)}</dd>
              </div>
              <div>
                <dt>当时模型窗口</dt>
                <dd>{tokens(window)}</dd>
              </div>
            </dl>
            <p className="inspector-overview__note">
              历史请求快照；当前模型、工具或压缩状态变化后不会改写它。窗口空余对应这次请求，不是下次可追加内容的保证。
            </p>
            <p className="inspector-overview__note">
              调用 <code>{request.providerCallId}</code> · 底层请求{" "}
              <code>{request.physicalAttemptId}</code>
            </p>
            <p className="inspector-overview__note">
              路由 <code>{request.routeId}</code> · 连接{" "}
              <code>{request.connectionId ?? "未知"}</code>
            </p>
            <p className="inspector-overview__note">
              窗口来源 {request.contextWindowSource ?? "未知"}
            </p>
            {request.compaction ? (
              <p className="inspector-overview__note">
                本次使用压缩 <code>{request.compaction.checkpointId}</code> · 覆盖{" "}
                {request.compaction.coveredEventCount} 条 ·{" "}
                <code>{request.compaction.throughEventId}</code>
              </p>
            ) : (
              <p className="inspector-overview__note">本次没有使用压缩 checkpoint。</p>
            )}
          </details>
        </>
      ) : (
        <p className="inspector-overview__note">{request?.reason ?? "尚无成功的主请求。"}</p>
      )}
      <div className="inspector-composition__heading">
        <h3>请求组成</h3>
        <span>字节估算</span>
      </div>
      {!composition ? (
        <p className="inspector-overview__note">请求组成未知（未记录）。</p>
      ) : (
        <>
          {composition.totalBytes > 0 && (
            <div className="inspector-composition__bar" aria-hidden="true">
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
          <ul className="inspector-composition__list" aria-label="请求组成估算">
            {composition.segments.map((segment) => (
              <li key={segment.kind}>
                <span>
                  <i aria-hidden="true" style={{ background: colors[segment.kind] }} />
                  {names[segment.kind]}
                </span>
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
          <details>
            <summary>
              {tools.length > 0 || composition.unlabelledToolBytes > 0 || remainingCount > 0
                ? "工具定义明细 · 按大小排序"
                : "组成估算口径"}
            </summary>
            <p className="inspector-overview__note">
              组成按 UTF-8 字节比例展示，Token 以字节数 ÷ 4
              向上取整估算；不等于实际输入用量，也不包含完整 HTTP 传输开销。合计{" "}
              {estimate(composition.totalBytes)}。
            </p>
            <ul className="inspector-composition__list" aria-label="工具定义估算明细">
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
        </>
      )}
    </section>
  );
}
