import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ExperienceDiagnostic, ExperienceUse } from "@pico/core";
import { Button, InlineNotice } from "./components.js";
import { isMemoryConflict } from "./runtime.js";
import { experienceManagementHref } from "./experience-management-route.js";
import {
  newerExperienceUse,
  type ExperienceUseDetail,
  type ExperienceUseFeedbackRequest,
} from "./useExperienceLedger.js";

interface ExperienceUsagePanelProps {
  readonly uses: readonly ExperienceUse[];
  readonly diagnostics?: readonly ExperienceDiagnostic[];
  readonly workspacePath?: string;
  readonly onDetail: (useId: string) => Promise<ExperienceUseDetail>;
  readonly onFeedback: (request: ExperienceUseFeedbackRequest) => Promise<ExperienceUse>;
}
const sourceLabels = {
  "reviewed-reference": "用户确认的任务经验",
  "execution-validated": "自然验收的执行方案",
  "execution-evidence": "旧版执行证据经验",
};
const adoptionLabels = { unknown: "未知", observed: "已观察到采用要点", not_applied: "未采用" };
const validationLabels = {
  unknown: "尚无结论",
  pass: "验证通过",
  fail: "验证失败",
  stale: "需重新验证",
};
const scopeLabels = {
  unknown: "验证范围未知",
  "native-claim": "冻结的原生执行目标",
  "spreadsheet-range": "当前附件、目标范围与有限数值求和",
  command: "列明的执行命令与条件",
};

/** Decode only the known Host memory wrapper; retain the original receipt as evidence. */
function referenceBody(content: string): string {
  const wrapped = /^<memory\b[^>]*>([\s\S]*)<\/memory>$/u.exec(content.trim());
  if (!wrapped) return content;
  const entities: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return wrapped[1]!.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (entity, name: string) => entities[name] ?? entity,
  );
}

export function ExperienceUsagePanel({
  uses,
  diagnostics = [],
  ...props
}: ExperienceUsagePanelProps) {
  if (!uses.length && !diagnostics.length) return null;
  const carried = uses.filter((use) => use.delivery === "carried" && !use.historical).length;
  const pending = uses.filter((use) => use.delivery === "pending" && !use.historical).length;
  const historical = uses.filter((use) => use.historical).length;
  const unconfirmed = uses.filter((use) => !use.historical && use.delivery === "unknown").length;
  return (
    <>
      {uses.length > 0 && (
        <details
          className="execution-learning task-experience__usage"
          aria-label="本次经验使用记录"
        >
          <summary>
            <span>经验使用记录</span>
            <span>{carried} 条已引用</span>
            {pending > 0 && <span>{pending} 条待注入</span>}
            {historical > 0 && <span>{historical} 条旧记录</span>}
            {unconfirmed > 0 && <span>{unconfirmed} 条引用未确认</span>}
          </summary>
          <div className="task-experience__summary-content">
            <p>
              用户确认、保存时验收、是否采用与本次执行结果分别记录。只有已携带到模型请求的记录显示“已引用”。
            </p>
            {uses.map((use) => (
              <UseCard
                key={JSON.stringify([props.workspacePath, use.useId])}
                use={use}
                {...props}
              />
            ))}
          </div>
        </details>
      )}
      {diagnostics.length > 0 && <ExperienceDiagnostics diagnostics={diagnostics} />}
    </>
  );
}
function ExperienceDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: readonly ExperienceDiagnostic[];
}) {
  const phases = {
    identity: "任务关联",
    proposal: "提案整理",
    reference: "引用记录",
    effect: "执行核对",
    worker: "后台整理",
  };
  const reasons: Readonly<Record<string, string>> = {
    experience_feedback_deadline: "这次经验记录超时，记录可能不完整。",
    experience_use_budget: "本轮引用记录达到上限，部分记录可能省略。",
    native_preparation_budget: "本轮执行验证记录达到上限。",
    native_condition_budget: "本轮执行验证条件记录达到上限。",
    experience_feedback_unavailable: "这次经验使用记录未能保存。",
    experience_validation_unavailable: "这次执行核对未能完成，验证结论保持未知。",
    collection_deadline: "这次任务经验采集超时，记录可能不完整。",
    canonical_run_binding_unavailable: "这次任务执行证据无法关联。",
    host_run_binding_conflict: "这次任务执行证据关联发生冲突。",
    task_experience_collection_unavailable: "这次任务经验采集未能完成。",
    execution_learning_collection_unavailable: "这次执行经验采集未能完成。",
  };
  return (
    <details className="execution-learning" aria-label="最近记录诊断">
      <summary>
        <span>最近记录诊断</span>
        <span>{diagnostics.length} 项</span>
      </summary>
      <div className="task-experience__summary-content">
        <p>以下为最近发生的记录事件，不表示当前连接或经验状态存在故障。</p>
        {diagnostics.map((diagnostic) => (
          <div key={diagnostic.diagnosticId}>
            <p>
              {phases[diagnostic.phase]} · {new Date(diagnostic.createdAt).toLocaleString("zh-CN")}
            </p>
            <p>{reasons[diagnostic.reason] ?? "这次经验记录未完整完成。"}</p>
            <small>诊断代码：{diagnostic.reason}</small>
          </div>
        ))}
      </div>
    </details>
  );
}
function UseCard({
  use,
  workspacePath,
  onDetail,
  onFeedback,
}: Omit<ExperienceUsagePanelProps, "uses"> & { readonly use: ExperienceUse }) {
  const [current, setCurrent] = useState(use);
  const [detail, setDetail] = useState<ExperienceUseDetail>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [stopped, setStopped] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const request = useRef(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  const operation = useRef<
    { fingerprint: string; request: ExperienceUseFeedbackRequest } | undefined
  >(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);
  useEffect(() => {
    setCurrent((previous) => newerExperienceUse(previous, use));
  }, [use]);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const sequence = ++request.current;
    setBusy(true);
    setError("");
    setOpen(true);
    try {
      const result = await onDetail(use.useId);
      if (!mounted.current || request.current !== sequence) return;
      if (newerExperienceUse(currentRef.current, result.use) !== result.use) return;
      setDetail(result);
      if (
        result.currentItemUnavailable ||
        result.currentItem?.lifecycleState === "archived" ||
        (result.currentItem?.taskExperience && !result.currentItem.taskExperience.enabled)
      )
        setStopped(true);
      else if (result.currentItem) setStopped(false);
      if (result.currentItem && result.currentItem.version !== use.itemVersion) setConflict(true);
      setCurrent((previous) => newerExperienceUse(previous, result.use));
    } catch {
      if (mounted.current && request.current === sequence) setError("无法读取使用详情，请重试。");
    } finally {
      inFlight.current = false;
      if (mounted.current && request.current === sequence) setBusy(false);
    }
  };
  const feedback = async (action: ExperienceUseFeedbackRequest["action"]) => {
    if (inFlight.current || conflict || current.deleted) return;
    inFlight.current = true;
    const payload = { useId: use.useId, expectedItemVersion: use.itemVersion, action };
    const fingerprint = JSON.stringify(payload);
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = {
        fingerprint,
        request: { ...payload, operationId: crypto.randomUUID() },
      };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await onFeedback(operation.current.request);
      if (!mounted.current) return;
      setCurrent((previous) => newerExperienceUse(previous, result));
      if (action === "disable") setStopped(true);
      setNotice(
        action === "not_applicable"
          ? "仅本次任务排除这条经验，其他任务仍可使用。"
          : use.source.kind === "reviewed-reference"
            ? "已停用这条经验，停止后续任务引用。旧使用记录仍保留。"
            : "已归档并停止引用这条经验。旧使用记录仍保留。",
      );
      operation.current = undefined;
    } catch (failure) {
      if (mounted.current) {
        setConflict(isMemoryConflict(failure));
        setError(
          isMemoryConflict(failure)
            ? "经验版本已变化，反馈未保存。请在记忆页管理最新版本。"
            : "反馈未保存，请重试；重试沿用同一操作标识。",
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const version =
    use.source.kind === "reviewed-reference"
      ? use.source.contentVersion
      : use.source.kind === "execution-validated"
        ? use.source.claimRevision
        : use.source.candidateVersion;
  const management = experienceManagementHref(
    workspacePath,
    {
      itemId: use.itemId,
      referenceItemVersion: use.itemVersion,
      ...(use.source.kind === "reviewed-reference"
        ? {
            candidateId: use.source.candidateId,
            referenceContentVersion: use.source.contentVersion,
          }
        : {}),
    },
    stopped && use.source.kind !== "reviewed-reference" ? "archived" : "saved",
  );
  const unconfirmed = !use.historical && use.delivery !== "carried";
  return (
    <article
      className="memory-card task-experience__reference"
      data-use-id={use.useId}
      aria-busy={busy}
    >
      <header>
        <strong>
          {sourceLabels[use.source.kind]} · v{version}
        </strong>
        <span className="task-experience__meta">
          <span>
            {use.historical
              ? "旧记录，注入时序不完整"
              : use.delivery === "carried"
                ? "已引用"
                : use.delivery === "pending"
                  ? "待注入"
                  : "引用未确认"}
          </span>
          <span>
            {use.source.kind === "reviewed-reference"
              ? "用户确认：已确认此版本"
              : "用户确认：无需逐例审核"}
          </span>
          <span>
            {use.source.kind === "execution-validated"
              ? "保存时验收：限定执行目标通过"
              : use.source.kind === "execution-evidence"
                ? "保存时证据：历史执行记录，范围未知"
                : "保存时验收：用户确认不等于执行验证"}
          </span>
          <span>采用：{unconfirmed ? "未知（引用未确认）" : adoptionLabels[current.adoption]}</span>
          <span>
            本次结果：{unconfirmed ? "尚无经验效果归因" : validationLabels[current.validation]} ·{" "}
            {unconfirmed ? "引用未确认" : scopeLabels[current.validationScope]}
          </span>
          {current.excluded && <span>本次已排除</span>}
          {current.deleted || detail?.currentItemUnavailable ? (
            <span>经验已删除或不可用</span>
          ) : stopped ? (
            <span>
              {use.source.kind === "reviewed-reference"
                ? "当前管理状态：已停用"
                : "当前管理状态：已归档并停止引用"}
            </span>
          ) : null}
        </span>
      </header>
      {current.referenceContent && (
        <p className="task-experience__content">{referenceBody(current.referenceContent)}</p>
      )}
      {unconfirmed && <p>引用尚未确认，独立执行结果仍保留，但不能归因于这条经验。</p>}
      {(use.historical || current.validationScope === "unknown") && (
        <p>历史记录或未知范围的 pass 不能证明建议全文、当前用户目标或最终回答正确。</p>
      )}
      <div className="memory-card__actions">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            if (open) setOpen(false);
            else void load();
          }}
        >
          {open ? "收起使用详情" : "查看使用详情"}
        </Button>
        <Button
          variant="quiet"
          disabled={busy || conflict || current.excluded || current.deleted || stopped}
          onClick={() => void feedback("not_applicable")}
        >
          本次不适用
        </Button>
        <Button
          variant="quiet"
          disabled={busy || conflict || current.deleted || stopped}
          onClick={() => void feedback("disable")}
        >
          {use.source.kind === "reviewed-reference" ? "停止引用" : "归档并停止引用"}
        </Button>
        <Link className="button" to={management}>
          管理工作区记忆
        </Link>
      </div>
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {error && (
        <InlineNotice tone="error">
          {error}
          {!conflict && (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                if (operation.current) void feedback(operation.current.request.action);
                else void load();
              }}
            >
              重试
            </Button>
          )}
        </InlineNotice>
      )}
      {open && (
        <div className="execution-learning__inspection">
          {!current.deleted && current.referenceContent && (
            <details className="memory-source">
              <summary>原始引用片段</summary>
              <pre
                className="experience-use__raw-reference"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {current.referenceContent}
              </pre>
            </details>
          )}
          {detail?.currentItem && (
            <p>
              当前管理记忆版本：v{detail.currentItem.version} ·{" "}
              {detail.currentItem.lifecycleState === "archived" ? "已归档" : "已保存"}
              。本次使用记录保持记忆版本 v{use.itemVersion}。
            </p>
          )}
          {detail?.managementError && (
            <InlineNotice tone="warning">{detail.managementError}</InlineNotice>
          )}
          <p>
            记忆：{use.itemId} · 版本 {use.itemVersion} · 引用摘要：{use.referenceHash}
          </p>
          <p>
            任务：{use.taskId} · 版本 {use.taskVersion} · 会话：{use.sessionId} · 运行：{use.runId}
          </p>
          <p>
            召回序号：{use.recallSequence ?? "未记录"} · 注入序号：
            {use.deliverySequence ?? "未记录"}
          </p>
          {!current.deleted &&
            detail?.effects.map((effect) => (
              <div key={effect.effectId}>
                <p>
                  {unconfirmed ? "独立执行观察" : "采用"}：{adoptionLabels[effect.adoption]} ·{" "}
                  {unconfirmed ? "独立执行结果" : "本次结果"}：{validationLabels[effect.validation]}{" "}
                  · {scopeLabels[effect.validationScope]}
                </p>
                <p>{effect.reason}</p>
                <p>
                  派发：{effect.preparedEventId}（{effect.preparedSequence}）· 结果：
                  {effect.outcomeEventId}（{effect.outcomeSequence}）
                </p>
              </div>
            ))}
          {detail && detail.effects.length === 0 && <p>尚无本次采用或验证事件。</p>}
          {(current.deleted ? [] : (detail?.use.sources ?? use.sources)).map((source) => (
            <p key={JSON.stringify(source)}>
              来源：{source.sessionId} · {source.runId} · {source.eventId}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}
