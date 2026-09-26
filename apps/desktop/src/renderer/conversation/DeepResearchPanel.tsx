import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { DeepResearchProgress } from "@pico/core/deep-research";
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeWorkbarRuntime, workbarErrorMessage } from "../workbar-panels/workbar-runtime.js";
import { useResourceFrame } from "../workbar-panels/useResourceFrame.js";

const labels: Record<string, string> = {
  project_entrypoints: "项目入口",
  core_flow: "核心链路",
  boundaries: "边界条件",
  verification_evidence: "验证证据",
  conclusion: "结论",
  source_evidence: "源码证据",
  borrow_diverge_risk_gate: "借鉴与风险",
  implementation_recommendations: "实施建议",
  verification: "验证方案",
  pending: "待处理",
  in_progress: "进行中",
  blocked: "有阻塞",
  completed: "已完成",
  skipped: "已说明跳过",
  drafted: "草稿",
  knowledge_base: "收集证据",
  report_writing: "撰写报告",
  active: "进行中",
};

export function DeepResearchPanel(props: {
  workspacePath: string;
  sessionId?: string;
  refreshKey: string;
  busy: boolean;
  onOpenArtifacts(): void;
  onImplement(prompt: string): Promise<void>;
  onStarter(prompt: string): void;
}) {
  const [run, setRun] = useState<DeepResearchProgress | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const request = useRef(0);
  const scope = `${props.workspacePath}:${props.sessionId ?? ""}`;
  const [loadedScope, setLoadedScope] = useState(scope);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!props.sessionId) {
      setRun(null);
      setLoadedScope(scope);
      return;
    }
    setLoading(true);
    try {
      const result = await invokeWorkbarRuntime(window.pico.runtime, "session.research.query", {
        workspacePath: props.workspacePath,
        sessionId: props.sessionId,
      });
      if (id !== request.current) return;
      setRun(result.run as unknown as DeepResearchProgress | null);
      setLoadedScope(scope);
      setError(undefined);
    } catch (cause) {
      if (id === request.current) setError(workbarErrorMessage(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [props.workspacePath, props.sessionId, scope]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, props.refreshKey]);
  useResourceFrame(
    { active: Boolean(props.sessionId), sessionId: props.sessionId ?? "", resource: "artifacts" },
    refresh,
  );
  const current = loadedScope === scope ? run : null;
  const implement = async () => {
    if (!current?.implementationPrompt || implementing || props.busy) return;
    setImplementing(true);
    try {
      await props.onImplement(current.implementationPrompt);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setImplementing(false);
    }
  };
  return (
    <section className="deep-research-panel" aria-label="深度研究进度">
      <div className="deep-research-heading">
        <strong>深度研究 · 只读</strong>
        {props.sessionId && (
          <AstryxButton
            className="pico-page-control"
            label="刷新"
            variant="ghost"
            type="button"
            isDisabled={loading}
            onClick={() => void refresh()}
          >
            刷新
          </AstryxButton>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {current ? (
        <DeepResearchProgressView run={current} />
      ) : (
        <>
          <p>研究来源、证据和检查点会持续保存。完成后生成报告，再创建独立的实施任务。</p>
          <div className="deep-research-actions">
            {(
              [
                ["快速", "只追踪项目入口与一个关键问题"],
                ["标准", "梳理核心链路、相关测试和主要风险"],
                ["深挖", "跨模块追踪实现、数据流与边界条件"],
              ] as const
            ).map(([scopeLabel, task]) => (
              <AstryxButton
                className="pico-page-control"
                label={`${scopeLabel}研究`}
                variant="ghost"
                key={scopeLabel}
                type="button"
                isDisabled={props.busy}
                onClick={() =>
                  props.onStarter(
                    `请按${scopeLabel}范围只读研究这个项目：${task}。保存证据与检查点，完成研究报告和可实施的交接清单。`,
                  )
                }
              >
                {scopeLabel}研究
              </AstryxButton>
            ))}
          </div>
        </>
      )}
      {current && (
        <div className="deep-research-actions">
          <AstryxButton
            className="pico-page-control"
            label={`查看证据与报告（${current.artifactsCount}）`}
            variant="ghost"
            type="button"
            onClick={props.onOpenArtifacts}
          >
            查看证据与报告（{current.artifactsCount}）
          </AstryxButton>
          {current.status === "completed" && current.implementationPrompt && (
            <AstryxButton
              className="pico-page-control"
              label={implementing ? "正在创建…" : "新建实施任务"}
              variant="ghost"
              type="button"
              isDisabled={props.busy || implementing}
              onClick={() => void implement()}
            >
              {implementing ? "正在创建…" : "新建实施任务"}
            </AstryxButton>
          )}
        </div>
      )}
    </section>
  );
}

export function DeepResearchProgressView({ run }: { run: DeepResearchProgress }) {
  const checkpoint = run.checkpoints.at(-1);
  return (
    <div className="deep-research-progress">
      <p>{run.objective}</p>
      <p className="deep-research-meta">
        {labels[run.status] ?? run.status} · {labels[run.stage] ?? run.stage} · 第 {run.round} 轮 ·{" "}
        {run.stepsCount} 个研究步骤
      </p>
      <details open={run.status !== "completed"}>
        <summary>证据检查与报告进度</summary>
        <ul>
          {run.checklist.map((item) => (
            <li key={item.itemId}>
              <span>{labels[item.itemId] ?? item.title}</span>
              <span>{labels[item.status] ?? item.status}</span>
              {item.blockedReason && <small>{item.blockedReason}</small>}
            </li>
          ))}
        </ul>
        <ul>
          {run.reportSections.map((item) => (
            <li key={item.key}>
              <span>{labels[item.key] ?? item.key}</span>
              <span>{labels[item.status] ?? item.status}</span>
            </li>
          ))}
        </ul>
        {run.blockers.length > 0 && <p>阻塞：{run.blockers.join("；")}</p>}
        {checkpoint && (
          <div>
            <p>最近检查点：{checkpoint.summary}</p>
            {checkpoint.openQuestions.length > 0 && (
              <p>待解决：{checkpoint.openQuestions.join("；")}</p>
            )}
            {checkpoint.nextSteps.length > 0 && <p>下一步：{checkpoint.nextSteps.join("；")}</p>}
          </div>
        )}
        {run.recentInspectedRefs.length > 0 && (
          <ul>
            {run.recentInspectedRefs.map((ref, index) => (
              <li key={index} className="deep-research-reference">
                {ref.label ?? ref.locator}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
