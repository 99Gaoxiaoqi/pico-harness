import type { RuntimeLatestContextRequest } from "@pico/protocol";

const names = {
  system: "系统指令",
  tools: "工具定义",
  messages: "会话消息（含附件）",
  other: "其他请求选项",
};
const colors = { system: "#8b7bc8", tools: "#5e9eae", messages: "#be9966", other: "#92969e" };

export function ContextComposition({ request }: { request?: RuntimeLatestContextRequest }) {
  const composition = request?.composition;
  return (
    <section className="tool-panel__section" aria-label="最近成功主请求组成">
      <div className="tool-panel__section-heading">
        <h3>最近成功主请求</h3>
      </div>
      <p className="tool-panel__muted">历史请求快照；当前模型、工具或压缩状态变化后不会改写它。</p>
      {request?.providerCallId && (
        <>
          <p className="tool-panel__muted">
            <code>
              {request.providerId} / {request.modelId}
            </code>
            {request.completedAt !== undefined && (
              <> · {new Date(request.completedAt).toLocaleString("zh-CN")}</>
            )}
          </p>
          <details>
            <summary>
              请求身份 · {request.source === "physical" ? "物理记录" : "旧调用记录"}
            </summary>
            <p className="tool-panel__muted">
              调用 <code>{request.providerCallId}</code>
            </p>
            {request.physicalAttemptId ? (
              <p className="tool-panel__muted">
                底层请求 <code>{request.physicalAttemptId}</code>
              </p>
            ) : (
              <p className="tool-panel__muted">旧记录未保存可验证的物理请求关联。</p>
            )}
          </details>
          <dl className="tool-panel__metrics">
            <div>
              <dt>上报输入 Token</dt>
              <dd>{request.inputTokens?.toLocaleString("zh-CN") ?? "未知"}</dd>
            </div>
            <div>
              <dt>其中缓存 Token</dt>
              <dd>{request.cachedInputTokens?.toLocaleString("zh-CN") ?? "未知"}</dd>
            </div>
          </dl>
        </>
      )}
      {request?.status !== "available" || !composition ? (
        <p className="tool-panel__muted">{request?.reason ?? "没有可用的请求组成记录。"}</p>
      ) : (
        <>
          <p className="tool-panel__muted">
            组成按序列化语义分段的 UTF-8 字节计算，不是 Token，也不包含完整 HTTP 传输开销。合计{" "}
            {formatBytes(composition.totalBytes)}。
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
          <ul className="tool-panel__compact-list" aria-label="语义字节组成">
            {composition.segments.map((segment) => (
              <li key={segment.kind}>
                <span>{names[segment.kind]}</span>
                <small>
                  {formatBytes(segment.bytes)} ·{" "}
                  {composition.totalBytes === 0
                    ? "0.0"
                    : ((segment.bytes / composition.totalBytes) * 100).toFixed(1)}
                  %
                </small>
              </li>
            ))}
          </ul>
          {(composition.tools.length > 0 ||
            composition.unlabelledToolBytes > 0 ||
            composition.remainingTools.count > 0) && (
            <details>
              <summary>工具定义明细 · 按大小排序</summary>
              <ul className="tool-panel__compact-list" aria-label="工具定义字节明细">
                {composition.tools.map((tool) => (
                  <li key={tool.label}>
                    <code>{tool.label}</code>
                    <small>{formatBytes(tool.bytes)}</small>
                  </li>
                ))}
                {composition.remainingTools.count > 0 && (
                  <li>
                    <span>其余 {composition.remainingTools.count} 项工具定义</span>
                    <small>{formatBytes(composition.remainingTools.bytes)}</small>
                  </li>
                )}
                {composition.unlabelledToolBytes > 0 && (
                  <li>
                    <span>未命名工具（旧记录或名称不可用）</span>
                    <small>{formatBytes(composition.unlabelledToolBytes)}</small>
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
function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("zh-CN")} B`;
}
