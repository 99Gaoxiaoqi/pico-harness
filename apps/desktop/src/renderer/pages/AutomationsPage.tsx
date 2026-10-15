import { TextField, TextAreaField, SwitchField } from "../ui-controls.js";
import { Clock3, Plus, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RuntimeRun } from "@pico/protocol";
import { Button, EmptyState, InlineNotice, StatusPill } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { formatRelative } from "../view-format.js";
import { sessionHref } from "../workspace-session.js";

export function AutomationsPage() {
  const { data, actions, busy } = useRuntime();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", schedule: "", prompt: "" });
  const [schedulePreview, setSchedulePreview] = useState<{
    readonly schedule: string;
    readonly timeZone: string;
    readonly nextRunAt?: number;
    readonly error?: string;
  }>();
  const [historyJobId, setHistoryJobId] = useState<string>();
  const [historyRuns, setHistoryRuns] = useState<readonly RuntimeRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const historyRequest = useRef(0);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    if (!creating || !draft.schedule.trim() || !timeZone) {
      setSchedulePreview(undefined);
      return;
    }
    let disposed = false;
    const schedule = draft.schedule.trim();
    const timer = setTimeout(() => {
      void actions
        .previewJobSchedule({ schedule, timeZone })
        .then((nextRunAt) => {
          if (!disposed)
            setSchedulePreview({
              schedule,
              timeZone,
              ...(nextRunAt === undefined ? {} : { nextRunAt }),
            });
        })
        .catch((error: unknown) => {
          if (!disposed)
            setSchedulePreview({
              schedule,
              timeZone,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [actions, creating, draft.schedule, timeZone]);

  async function loadHistory(jobId: string) {
    const request = ++historyRequest.current;
    setHistoryJobId(jobId);
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const runs = await actions.loadJobHistory(jobId);
      if (historyRequest.current === request) setHistoryRuns(runs);
    } catch (error) {
      if (historyRequest.current === request) {
        setHistoryRuns([]);
        setHistoryError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (historyRequest.current === request) setHistoryLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">后台任务</span>
          <h2>定时任务</h2>
          <p>让 Pico 按计划重复执行任务；审批与信任规则始终有效。</p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            if (!creating) setDraft({ name: "", schedule: "", prompt: "" });
            setCreating((value) => !value);
          }}
        >
          <Plus aria-hidden="true" size={16} />
          新建定时任务
        </Button>
      </section>
      {creating && (
        <form
          className="automation-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = form.get("name");
            const prompt = form.get("prompt");
            const schedule = form.get("schedule");
            if (
              typeof name === "string" &&
              typeof prompt === "string" &&
              typeof schedule === "string"
            )
              void actions
                .createJob({
                  name,
                  prompt,
                  schedule,
                  ...(timeZone ? { timeZone } : {}),
                })
                .then((succeeded) => {
                  if (succeeded) setCreating(false);
                });
          }}
        >
          <div>
            <label htmlFor="automation-name">名称</label>
            <TextField
              label="名称"
              value={draft.name}
              onValueChange={(name) => setDraft((current) => ({ ...current, name }))}
              id="automation-name"
              name="name"
              required
              autoComplete="off"
              placeholder="例如：每周依赖检查…"
            />
          </div>
          <div>
            <label htmlFor="automation-schedule">计划</label>
            <TextField
              label="计划"
              value={draft.schedule}
              onValueChange={(schedule) => setDraft((current) => ({ ...current, schedule }))}
              id="automation-schedule"
              name="schedule"
              required
              autoComplete="off"
              placeholder="例如：0 9 * * 1…"
            />
          </div>
          <div className="automation-form__prompt">
            <label htmlFor="automation-prompt">任务说明</label>
            <TextAreaField
              label="任务说明"
              value={draft.prompt}
              onValueChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
              id="automation-prompt"
              name="prompt"
              required
              autoComplete="off"
              rows={3}
              placeholder="告诉 Pico 每次需要完成什么…"
            />
          </div>
          <div className="automation-form__schedule-preview" aria-live="polite">
            <p>计划：{describeAutomationSchedule(draft.schedule)}</p>
            <p>任务时区：{timeZone || "未知，暂不能确认计划"}</p>
            <p>
              下次执行：
              {schedulePreview?.schedule === draft.schedule.trim() &&
              schedulePreview.timeZone === timeZone
                ? schedulePreview.nextRunAt === undefined
                  ? (schedulePreview.error ?? "未知")
                  : formatAutomationTime(schedulePreview.nextRunAt, timeZone)
                : "正在计算…"}
            </p>
          </div>
          <div className="button-row">
            <Button onClick={() => setCreating(false)}>取消</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                Boolean(busy) ||
                !timeZone ||
                schedulePreview?.schedule !== draft.schedule.trim() ||
                schedulePreview.timeZone !== timeZone ||
                schedulePreview.nextRunAt === undefined
              }
            >
              创建
            </Button>
          </div>
        </form>
      )}
      {data.notices.jobs && <InlineNotice tone="warning">{data.notices.jobs}</InlineNotice>}
      {data.jobs.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="还没有定时任务"
          detail="创建后，任务会在这里显示计划、开关和最近状态。"
        />
      ) : (
        <div className="automation-grid">
          {data.jobs.map((job) => (
            <article className="automation-card" key={job.id}>
              <header>
                <span className="automation-card__icon">
                  <Clock3 aria-hidden="true" />
                </span>
                <SwitchField
                  label={`启用 ${job.name}`}
                  checked={job.enabled}
                  disabled={busy === "toggle-job"}
                  onCheckedChange={(enabled) => void actions.toggleJob(job.id, enabled)}
                />
              </header>
              <h3>{job.name}</h3>
              <p>{job.prompt}</p>
              <div className="automation-card__meta">
                <span>{describeAutomationSchedule(job.schedule)}</span>
                <StatusPill status={job.status} />
              </div>
              <div className="automation-card__schedule-preview">
                <p>
                  计划：<code>{job.schedule}</code>
                </p>
                <p>任务时区：{job.timeZone ?? "未知"}</p>
                <p>
                  下次执行：
                  {job.nextRunAt !== undefined && job.timeZone
                    ? formatAutomationTime(job.nextRunAt, job.timeZone)
                    : "未知"}
                </p>
              </div>
              <footer>
                <time>更新于 {formatRelative(job.updatedAt)}</time>
                <div className="button-row">
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy) || !job.enabled || job.status === "running"}
                    onClick={() => {
                      void actions.runJob(job.id).then(() => loadHistory(job.id));
                    }}
                  >
                    立即运行
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={historyLoading && historyJobId === job.id}
                    onClick={() => {
                      if (historyJobId === job.id) {
                        historyRequest.current += 1;
                        setHistoryJobId(undefined);
                      } else void loadHistory(job.id);
                    }}
                  >
                    {historyJobId === job.id ? "收起记录" : "运行记录"}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (window.confirm(`删除自动化“${job.name}”？此操作无法撤销。`))
                        void actions.deleteJob(job.id);
                    }}
                  >
                    删除
                  </Button>
                </div>
              </footer>
              {historyJobId === job.id && (
                <section className="automation-card__history" aria-label={`${job.name}运行记录`}>
                  <h4>最近运行记录</h4>
                  {historyLoading && <p>正在读取历史…</p>}
                  {historyError && <InlineNotice tone="warning">{historyError}</InlineNotice>}
                  {!historyLoading && !historyError && historyRuns.length === 0 && (
                    <p>暂无运行记录。</p>
                  )}
                  {historyRuns.map((run) => {
                    const status = automationRunStatus(run);
                    return (
                      <article className="automation-history-run" key={run.runId}>
                        <div>
                          <StatusPill status={status.label} />
                          <time>
                            {formatAutomationTime(run.startedAt, job.timeZone ?? timeZone)}
                          </time>
                        </div>
                        {run.error && <p>{run.error}</p>}
                        {run.sessionId ? (
                          <Link
                            to={sessionHref({
                              workspacePath: job.workspacePath,
                              sessionId: run.sessionId,
                            })}
                          >
                            打开运行会话与结果
                          </Link>
                        ) : (
                          <p>当前记录没有关联会话。</p>
                        )}
                      </article>
                    );
                  })}
                </section>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function describeAutomationSchedule(schedule: string): string {
  const fields = schedule.trim().split(/\s+/u);
  if (fields.length !== 5) return "自定义计划（Cron 表达式）";
  const [minute, hour, day, month, weekday] = fields;
  if (minute === "*" && hour === "*" && day === "*" && month === "*" && weekday === "*")
    return "每分钟";
  if (
    /^\*\/\d+$/u.test(minute ?? "") &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  )
    return `每 ${minute?.slice(2)} 分钟`;
  const minuteNumber = Number(minute);
  const hourNumber = Number(hour);
  if (
    Number.isInteger(minuteNumber) &&
    minuteNumber >= 0 &&
    minuteNumber <= 59 &&
    Number.isInteger(hourNumber) &&
    hourNumber >= 0 &&
    hourNumber <= 23
  ) {
    const clock = `${String(hourNumber).padStart(2, "0")}:${String(minuteNumber).padStart(2, "0")}`;
    if (day === "*" && month === "*" && weekday === "*") return `每天 ${clock}`;
    const weekdays: Record<string, string> = {
      "0": "周日",
      "1": "周一",
      "2": "周二",
      "3": "周三",
      "4": "周四",
      "5": "周五",
      "6": "周六",
    };
    if (day === "*" && month === "*" && weekday && weekdays[weekday])
      return `每周${weekdays[weekday]} ${clock}`;
    if (month === "*" && weekday === "*" && day && /^\d{1,2}$/u.test(day))
      return `每月 ${day} 日 ${clock}`;
  }
  return "自定义计划（按 Cron 表达式）";
}

function formatAutomationTime(timestamp: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(timestamp);
  } catch {
    return "未知（时区不可用）";
  }
}

function automationRunStatus(run: RuntimeRun): { readonly label: string } {
  const cronStatus = run["cronStatus"];
  if (cronStatus === "queued") return { label: "等待运行" };
  if (cronStatus === "running") return { label: "运行中" };
  if (cronStatus === "succeeded" || (!cronStatus && run.status === "succeeded"))
    return { label: "运行完成" };
  if (cronStatus === "failed" && run.error === "daemon_interrupted_after_lease_expiry")
    return { label: "中断" };
  if (cronStatus === "failed" || (!cronStatus && run.status === "failed"))
    return { label: "运行失败" };
  if (cronStatus === "cancelled" || run.status === "cancelled") return { label: "已取消" };
  if (cronStatus === "blocked") return { label: "被策略阻止" };
  if (cronStatus === "skipped") return { label: "已跳过" };
  return { label: "结果未知" };
}
